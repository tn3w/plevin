#!/usr/bin/env perl
use v5.36;
use Encode qw(decode);
use JSON::PP;
use List::Util qw(min sum0);
use Socket qw(inet_pton AF_INET AF_INET6);

use constant IS_REPEAT => 192;
use constant IS_FIRST  => IS_REPEAT + 12;
use constant IS_SECOND => IS_FIRST + 12;
use constant IS_THIRD  => IS_SECOND + 12;
use constant IS_LONG   => IS_THIRD + 12;
use constant SLOTS     => IS_LONG + 192;
use constant SPECIAL   => SLOTS + 256;
use constant ALIGN     => SPECIAL + 114;
use constant LENGTHS   => ALIGN + 16;
use constant REPEATS   => LENGTHS + 514;
use constant LITERALS  => REPEATS + 514;
use constant MASK      => 0xFFFFFFFF;

my @CARRIED = qw(place network abuse prefix rpki roas);
my %LINKED  = map { $_ => 1 } qw(place network abuse);
my %BOOKS   = (
    'rpki'              => 'rpki',        'place.granularity' => 'granularity',
    'city.timezone'     => 'timezones',   'city.type'         => 'place_types',
    'operator.category' => 'categories',  'abuse.user_type'   => 'categories',
    'abuse.service'     => 'services',    'abuse.evidence'    => 'evidence',
);
my %UNSIGNED = (1 => 'C', 2 => 'v', 4 => 'V', 8 => 'Q<');
my %SIGNED   = (1 => 'c', 2 => 's<', 4 => 'l<', 8 => 'q<');

sub stream ($packed, $tuning) {
    my ($context, $position, $matches) = @$tuning;
    my @data  = unpack 'C*', $packed;
    my @probs = (1024) x (LITERALS + (0x300 << ($context + $position)));
    my ($at, $range, $code) = (5, MASK, unpack 'N', substr $packed, 1, 4);
    my (@out, $span, $done);
    my @recent = (0, 0, 0, 0);
    my $state  = 0;

    my $bit = sub ($index) {
        my $chance = $probs[$index];
        my $bound  = ($range >> 11) * $chance;
        my $result = $code < $bound ? 0 : 1;
        if ($result) {
            $range -= $bound;
            $code  -= $bound;
            $probs[$index] -= $chance >> 5;
        }
        else {
            $range = $bound;
            $probs[$index] += (2048 - $chance) >> 5;
        }
        if ($range < 1 << 24) {
            $range = ($range << 8) & MASK;
            $code  = (($code << 8) | $data[$at++]) & MASK;
        }
        return $result;
    };
    my $direct = sub ($count) {
        my $value = 0;
        for (1 .. $count) {
            $range >>= 1;
            my $result = $code >= $range ? 1 : 0;
            $code -= $range * $result;
            $value = $value << 1 | $result;
            next if $range >= 1 << 24;
            $range = ($range << 8) & MASK;
            $code  = (($code << 8) | $data[$at++]) & MASK;
        }
        return $value;
    };
    my $tree = sub ($base, $count) {
        my $symbol = 1;
        $symbol = $symbol << 1 | $bit->($base + $symbol) for 1 .. $count;
        return $symbol - (1 << $count);
    };
    my $reversed = sub ($base, $count) {
        my ($symbol, $value) = (1, 0);
        for my $step (0 .. $count - 1) {
            my $result = $bit->($base + $symbol);
            $symbol = $symbol << 1 | $result;
            $value |= $result << $step;
        }
        return $value;
    };
    my $length = sub ($base, $spot) {
        return $tree->($base + 2 + ($spot << 3), 3) if !$bit->($base);
        return 8 + $tree->($base + 130 + ($spot << 3), 3) if !$bit->($base + 1);
        return 16 + $tree->($base + 258, 8);
    };
    my $distance = sub ($span) {
        my $slot = $tree->(SLOTS + (min($span, 3) << 6), 6);
        return $slot if $slot < 4;
        my $count = ($slot >> 1) - 1;
        my $base  = (2 | ($slot & 1)) << $count;
        return $base + $reversed->(SPECIAL + $base - $slot - 1, $count) if $slot < 14;
        return $base + ($direct->($count - 4) << 4) + $reversed->(ALIGN, 4);
    };
    my $literal = sub {
        my $previous = @out ? $out[-1] : 0;
        my $spot     = (@out & ((1 << $position) - 1)) << $context;
        my $base     = LITERALS + 0x300 * ($spot + ($previous >> (8 - $context)));
        my $symbol   = 1;
        if ($state >= 7) {
            my $matched = $out[-$recent[0] - 1];
            while ($symbol < 0x100) {
                my $expected = ($matched >> 7) & 1;
                $matched <<= 1;
                my $result = $bit->($base + ((1 + $expected) << 8) + $symbol);
                $symbol = $symbol << 1 | $result;
                last if $result != $expected;
            }
        }
        $symbol = $symbol << 1 | $bit->($base + $symbol) while $symbol < 0x100;
        push @out, $symbol & 0xFF;
    };

    return sub ($index) {
        while (!$done && @out <= $index) {
            my $spot = @out & ((1 << $matches) - 1);
            if (!$bit->($state << 4 | $spot)) {
                $literal->();
                $state = $state < 4 ? 0 : $state < 10 ? $state - 3 : $state - 6;
                next;
            }
            if ($bit->(IS_REPEAT + $state)) {
                if ($bit->(IS_FIRST + $state)) {
                    my $picked = $bit->(IS_SECOND + $state) ? 2 + $bit->(IS_THIRD + $state) : 1;
                    unshift @recent, splice @recent, $picked, 1;
                }
                elsif (!$bit->(IS_LONG + ($state << 4 | $spot))) {
                    $state = $state < 7 ? 9 : 11;
                    push @out, $out[-$recent[0] - 1];
                    next;
                }
                $span  = $length->(REPEATS, $spot);
                $state = $state < 7 ? 8 : 11;
            }
            else {
                pop @recent;
                $span  = $length->(LENGTHS, $spot);
                $state = $state < 7 ? 7 : 10;
                unshift @recent, $distance->($span);
                $done = $recent[0] == MASK and last;
            }
            push @out, $out[-$recent[0] - 1] for 1 .. $span + 2;
        }
        return $out[$index];
    };
}

sub bytes ($byte, $from, $count) {
    return pack 'C*', map { $byte->($_) } $from .. $from + $count - 1;
}

sub varint ($data, $at) {
    my ($value, $shift) = (0, 0);
    while (1) {
        my $octet = $data->($$at++);
        $value |= ($octet & 0x7F) << $shift;
        return $value if $octet < 0x80;
        $shift += 7;
    }
}

sub wide ($data, $at) {
    my ($high, $low, $shift) = (0, 0, 0);
    while (1) {
        my $octet = $data->($$at++);
        my $chunk = $octet & 0x7F;
        if ($shift < 64) {
            $low  |= $chunk << $shift;
            $high |= $chunk >> (64 - $shift) if $shift > 57;
        }
        else {
            $high |= $chunk << ($shift - 64);
        }
        return pack 'Q>2', $high, $low if $octet < 0x80;
        $shift += 7;
    }
}

sub add ($left, $right) {
    my $carry = 0;
    for my $index (reverse 0 .. 15) {
        my $sum = ord(substr $left, $index, 1) + ord(substr $right, $index, 1) + $carry;
        substr $left, $index, 1, chr($sum & 0xFF);
        $carry = $sum >> 8;
    }
    return $left;
}

sub upper ($values, $address) {
    my ($low, $high) = (0, scalar @$values);
    while ($low < $high) {
        my $middle = int(($low + $high) / 2);
        if ($values->[$middle] le $address) { $low = $middle + 1 } else { $high = $middle }
    }
    return $low;
}

package Section {
    sub new ($class, $view, $entry) {
        my ($total, $width) = unpack 'V2', $view;
        my $at = 8 + 4 * ($total + 1);
        return bless {
            %$entry,
            fanout  => $entry->{block} / $entry->{group},
            width   => $width,
            offsets => [unpack "V@{[$total + 1]}", substr $view, 8],
            keys    => [map { "\0" x (16 - $width) . substr $view, $at + $_ * $width, $width }
                    0 .. $total - 1],
            data    => substr($view, $at + $total * $width),
            blocks  => {},
        }, $class;
    }

    sub decoded ($self, $index) {
        my ($from, $to) = @{$self->{offsets}}[$index, $index + 1];
        return $self->{blocks}{$index}
            //= main::stream(substr($self->{data}, $from, $to - $from), $self->{lzma});
    }

    sub value ($self, $row) {
        my $raw    = $self->decoded(int($row / $self->{block}));
        my $place  = $row % $self->{block};
        my $size   = $raw->(0);
        my $format = ($self->{encoding} eq 'fixed' ? \%UNSIGNED : \%SIGNED)->{$size};
        return unpack $format, main::bytes($raw, 1 + $place * $size, $size)
            if $self->{encoding} ne 'delta';
        return main::sum0(unpack "($format)*", main::bytes($raw, 1, ($place + 1) * $size));
    }

    sub text ($self, $identifier) {
        return '' if !$identifier;
        my $group = int(($identifier - 1) / $self->{group});
        my $place = ($identifier - 1) % $self->{group};
        my $index = int($group / $self->{fanout});
        my $raw   = $self->decoded($index);
        my $left  = int(($self->{count} - $index * $self->{block} + $self->{group} - 1)
            / $self->{group});
        my ($cursor, $start) = (0, 0);
        for my $step (0 .. main::min($self->{fanout}, $left) - 2) {
            my $span = main::varint($raw, \$cursor);
            $start += $span if $step < $group % $self->{fanout};
        }
        $cursor += $start;
        my $previous = '';
        for (0 .. $place) {
            my $shared = $raw->($cursor++);
            my $fresh  = main::varint($raw, \$cursor);
            $previous = substr($previous, 0, $shared) . main::bytes($raw, $cursor, $fresh);
            $cursor += $fresh;
        }
        return Encode::decode('UTF-8', $previous);
    }

    sub heads ($self, $index) {
        my $raw    = $self->decoded($index);
        my $cursor = 0;
        my $total  = int((main::varint($raw, \$cursor) + $self->{group} - 1) / $self->{group});
        my @heads  = ($self->{keys}[$index]);
        push @heads, main::add($heads[-1], main::wide($raw, \$cursor)) for 2 .. $total;
        my @spans  = map { main::varint($raw, \$cursor) } 2 .. $total;
        my @starts = ($cursor);
        push @starts, $starts[-1] + $_ for @spans;
        return (\@heads, \@starts);
    }

    sub values ($self, $group) {
        my $index  = int($group / $self->{fanout});
        my $at     = $group % $self->{fanout};
        my $size   = main::min($self->{group}, $self->{count} - $group * $self->{group});
        my ($heads, $starts) = $self->heads($index);
        my $raw    = $self->decoded($index);
        my $cursor = $starts->[$at];
        my $wide   = $self->{width} == 16;
        my @networks = (unpack 'Q>', substr $heads->[$at], $wide ? 0 : 8, 8);
        push @networks, $networks[-1] + main::varint($raw, \$cursor) for 2 .. $size;
        return [map { $wide ? pack('Q>2', $_, main::varint($raw, \$cursor)) : pack('Q>2', 0, $_) }
                @networks];
    }

    sub row ($self, $address) {
        my $index = main::upper($self->{keys}, $address) - 1;
        return if $index < 0;
        my ($heads) = $self->heads($index);
        my $group  = $index * $self->{fanout} + main::upper($heads, $address) - 1;
        my $values = $self->values($group);
        my $spot   = main::upper($values, $address) - 1;
        return if $spot < 0;
        return ($group * $self->{group} + $spot, $values->[$spot] eq $address);
    }
}

package Plevin {
    sub new ($class, $path) {
        open my $handle, '<:raw', $path or die "$path: $!\n";
        my $file = do { local $/; <$handle> };
        die "$path is not a plevin 2 database\n" if substr($file, 0, 8) ne "PLEVIN\0\2";
        my $size = unpack 'V', substr $file, 8, 4;
        my $head = JSON::PP->new->utf8->decode(substr $file, 12, $size);
        my $self = bless { sections => {}, books => {}, tables => {} }, $class;
        for my $name (sort keys %{$head->{sections}}) {
            my $entry = $head->{sections}{$name};
            my $view  = substr $file, 12 + $size + $entry->{offset}, $entry->{bytes};
            $self->{sections}{$name} = Section->new($view, $entry);
            my @parts = split /\./, $name;
            push @{$self->{tables}{$parts[1]}}, $name if @parts == 3 && $parts[0] =~ /^(col|link)$/;
        }
        for my $field (keys %BOOKS) {
            my $words = $head->{vocabularies}{$BOOKS{$field}};
            $self->{books}{$field} = $words if $words;
        }
        return $self;
    }

    sub read ($self, $name, $section, $value) {
        return $value == 255 ? undef : $value / 100 if $name eq 'abuse.risk';
        return $value ? JSON::PP::true : JSON::PP::false if $name =~ /^abuse\.is_(anycast|satellite)$/;
        return $self->{books}{$name}[$value] // '' if $self->{books}{$name};
        return $self->{sections}{strings}->text($value) if $section->{read} eq 'text';
        return $section->{read} eq '' ? $value : $value / 10000;
    }

    sub row ($self, $table, $row) {
        my %out;
        for my $name (@{$self->{tables}{$table} // []}) {
            my $section = $self->{sections}{$name};
            my ($kind, undef, $field) = split /\./, $name;
            my $value = $section->value($row);
            if ($kind eq 'col') {
                $out{$field} = $self->read("$table.$field", $section, $value);
            }
            elsif ($value) {
                $out{$field} = $self->row($field, $value - 1);
            }
        }
        $out{postal_partial} = substr $out{postal}, 0, $out{postal_partial}
            if exists $out{postal_partial};
        return \%out;
    }

    sub lookup ($self, $text) {
        my $six = $text =~ /:/;
        my $raw = Socket::inet_pton($six ? Socket::AF_INET6 : Socket::AF_INET, $text)
            // die "$text is not an address\n";
        my $version = $six ? 'v6' : 'v4';
        my $address = "\0" x (16 - length $raw) . $raw;
        my $spine   = $self->{sections}{"spine.$version"} or return;
        my ($row)   = $spine->row($address);
        return if !defined $row;
        my $hosts   = $self->{sections}{"hosts.$version"};
        my $records = $self->{sections}{"hosts.$version.abuse"};
        my ($at, $exact) = $hosts && $records ? $hosts->row($address) : ();
        return $self->answer($version, $row, $exact ? $records->value($at) + 1 : 0);
    }

    sub answer ($self, $version, $row, $override) {
        my %out;
        for my $name (@CARRIED) {
            my $column = $self->{sections}{"spine.$version.$name"} or next;
            my $value  = $override && $name eq 'abuse' ? $override : $column->value($row);
            if (!$LINKED{$name}) {
                $out{network}{$name} = $self->read($name, $column, $value);
            }
            elsif ($value) {
                $out{$name} = $self->row($name, $value - 1);
            }
        }
        return \%out;
    }
}

die "usage: perl plevin.pl path address\n" if @ARGV != 2;
print JSON::PP->new->utf8->pretty->canonical->allow_nonref->encode(
    Plevin->new($ARGV[0])->lookup($ARGV[1]));
