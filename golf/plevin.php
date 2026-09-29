<?php

declare(strict_types=1);

const IS_REPEAT = 192;
const IS_FIRST = IS_REPEAT + 12;
const IS_SECOND = IS_FIRST + 12;
const IS_THIRD = IS_SECOND + 12;
const IS_LONG = IS_THIRD + 12;
const SLOTS = IS_LONG + 192;
const SPECIAL = SLOTS + 256;
const ALIGN = SPECIAL + 114;
const LENGTHS = ALIGN + 16;
const REPEATS = LENGTHS + 514;
const LITERALS = REPEATS + 514;
const MASK = 0xFFFFFFFF;

const CARRIED = ['place', 'network', 'abuse', 'prefix', 'rpki', 'roas'];
const LINKED = ['place', 'network', 'abuse'];
const BOOKS = [
    'rpki' => 'rpki', 'place.granularity' => 'granularity', 'city.timezone' => 'timezones',
    'city.type' => 'place_types', 'operator.category' => 'categories',
    'abuse.user_type' => 'categories', 'abuse.service' => 'services',
    'abuse.evidence' => 'evidence',
];

final class Lzma
{
    private int $at = 5;
    private int $range = MASK;
    private int $code;
    private array $probs;
    private string $out = '';

    private function __construct(private string $data, private array $tuning)
    {
        $this->probs = array_fill(0, LITERALS + (0x300 << ($tuning[0] + $tuning[1])), 1024);
        $this->code = unpack('N', $data, 1)[1];
    }

    private function normalize(): void
    {
        if ($this->range >= 1 << 24) {
            return;
        }
        $this->range = ($this->range << 8) & MASK;
        $this->code = (($this->code << 8) | ord($this->data[$this->at++])) & MASK;
    }

    private function bit(int $index): int
    {
        $chance = $this->probs[$index];
        $bound = ($this->range >> 11) * $chance;
        if ($this->code < $bound) {
            $this->range = $bound;
            $this->probs[$index] += (2048 - $chance) >> 5;
            $result = 0;
        } else {
            $this->range -= $bound;
            $this->code -= $bound;
            $this->probs[$index] -= $chance >> 5;
            $result = 1;
        }
        $this->normalize();
        return $result;
    }

    private function direct(int $count): int
    {
        $value = 0;
        for ($step = 0; $step < $count; $step++) {
            $this->range >>= 1;
            $result = $this->code >= $this->range ? 1 : 0;
            $this->code -= $this->range * $result;
            $value = $value << 1 | $result;
            $this->normalize();
        }
        return $value;
    }

    private function tree(int $base, int $count): int
    {
        $symbol = 1;
        for ($step = 0; $step < $count; $step++) {
            $symbol = $symbol << 1 | $this->bit($base + $symbol);
        }
        return $symbol - (1 << $count);
    }

    private function reversed(int $base, int $count): int
    {
        $symbol = 1;
        $value = 0;
        for ($step = 0; $step < $count; $step++) {
            $result = $this->bit($base + $symbol);
            $symbol = $symbol << 1 | $result;
            $value |= $result << $step;
        }
        return $value;
    }

    private function length(int $base, int $spot): int
    {
        if (!$this->bit($base)) {
            return $this->tree($base + 2 + ($spot << 3), 3);
        }
        if (!$this->bit($base + 1)) {
            return 8 + $this->tree($base + 130 + ($spot << 3), 3);
        }
        return 16 + $this->tree($base + 258, 8);
    }

    private function distance(int $span): int
    {
        $slot = $this->tree(SLOTS + (min($span, 3) << 6), 6);
        if ($slot < 4) {
            return $slot;
        }
        $count = ($slot >> 1) - 1;
        $base = (2 | ($slot & 1)) << $count;
        if ($slot < 14) {
            return $base + $this->reversed(SPECIAL + $base - $slot - 1, $count);
        }
        return $base + ($this->direct($count - 4) << 4) + $this->reversed(ALIGN, 4);
    }

    private function back(int $distance): string
    {
        return $this->out[strlen($this->out) - $distance - 1];
    }

    private function literal(int $state, int $recent): void
    {
        [$context, $position] = $this->tuning;
        $size = strlen($this->out);
        $previous = $size ? ord($this->out[$size - 1]) : 0;
        $spot = ($size & ((1 << $position) - 1)) << $context;
        $base = LITERALS + 0x300 * ($spot + ($previous >> (8 - $context)));
        $symbol = 1;
        if ($state >= 7) {
            $matched = ord($this->back($recent));
            while ($symbol < 0x100) {
                $expected = ($matched >> 7) & 1;
                $matched <<= 1;
                $result = $this->bit($base + ((1 + $expected) << 8) + $symbol);
                $symbol = $symbol << 1 | $result;
                if ($result !== $expected) {
                    break;
                }
            }
        }
        while ($symbol < 0x100) {
            $symbol = $symbol << 1 | $this->bit($base + $symbol);
        }
        $this->out .= chr($symbol & 0xFF);
    }

    public static function decompress(string $data, array $tuning): string
    {
        $lzma = new Lzma($data, $tuning);
        $recent = [0, 0, 0, 0];
        $state = 0;
        while (true) {
            $spot = strlen($lzma->out) & ((1 << $tuning[2]) - 1);
            if (!$lzma->bit($state << 4 | $spot)) {
                $lzma->literal($state, $recent[0]);
                $state = $state < 4 ? 0 : ($state < 10 ? $state - 3 : $state - 6);
                continue;
            }
            if ($lzma->bit(IS_REPEAT + $state)) {
                if ($lzma->bit(IS_FIRST + $state)) {
                    $picked = $lzma->bit(IS_SECOND + $state) ? 2 + $lzma->bit(IS_THIRD + $state) : 1;
                    array_unshift($recent, array_splice($recent, $picked, 1)[0]);
                } elseif (!$lzma->bit(IS_LONG + ($state << 4 | $spot))) {
                    $state = $state < 7 ? 9 : 11;
                    $lzma->out .= $lzma->back($recent[0]);
                    continue;
                }
                $span = $lzma->length(REPEATS, $spot);
                $state = $state < 7 ? 8 : 11;
            } else {
                array_pop($recent);
                $span = $lzma->length(LENGTHS, $spot);
                $state = $state < 7 ? 7 : 10;
                array_unshift($recent, $lzma->distance($span));
                if ($recent[0] === MASK) {
                    return $lzma->out;
                }
            }
            for ($step = 0; $step < $span + 2; $step++) {
                $lzma->out .= $lzma->back($recent[0]);
            }
        }
    }
}

function varint(string $data, int &$at): int
{
    $value = 0;
    for ($shift = 0; ; $shift += 7) {
        $octet = ord($data[$at++]);
        $value |= ($octet & 0x7F) << $shift;
        if ($octet < 0x80) {
            return $value;
        }
    }
}

function wide(string $data, int &$at): string
{
    $high = $low = 0;
    for ($shift = 0; ; $shift += 7) {
        $octet = ord($data[$at++]);
        $chunk = $octet & 0x7F;
        if ($shift < 64) {
            $low |= $chunk << $shift;
            $high |= $shift ? $chunk >> (64 - $shift) : 0;
        } else {
            $high |= $chunk << ($shift - 64);
        }
        if ($octet < 0x80) {
            return pack('J2', $high, $low);
        }
    }
}

function add(string $left, string $right): string
{
    $carry = 0;
    for ($index = 15; $index >= 0; $index--) {
        $sum = ord($left[$index]) + ord($right[$index]) + $carry;
        $left[$index] = chr($sum & 0xFF);
        $carry = $sum >> 8;
    }
    return $left;
}

function upper(array $values, string $address): int
{
    [$low, $high] = [0, count($values)];
    while ($low < $high) {
        $middle = intdiv($low + $high, 2);
        if (strcmp($values[$middle], $address) <= 0) {
            $low = $middle + 1;
        } else {
            $high = $middle;
        }
    }
    return $low;
}

final class Section
{
    public string $encoding;
    public string $read;
    private int $count;
    private int $block;
    private int $group;
    private int $fanout;
    private int $width;
    private array $tuning;
    private array $offsets;
    private array $keys = [];
    private array $blocks = [];
    private string $data;

    public function __construct(string $view, array $entry)
    {
        ['encoding' => $this->encoding, 'read' => $this->read, 'count' => $this->count,
            'block' => $this->block, 'group' => $this->group, 'lzma' => $this->tuning] = $entry;
        $this->fanout = intdiv($this->block, $this->group);
        [, $total, $this->width] = unpack('V2', $view);
        $this->offsets = array_values(unpack('V' . ($total + 1), $view, 8));
        $at = 8 + 4 * ($total + 1);
        for ($index = 0; $index < $total; $index++, $at += $this->width) {
            $this->keys[] = str_pad(substr($view, $at, $this->width), 16, "\0", STR_PAD_LEFT);
        }
        $this->data = substr($view, $at);
    }

    private function decoded(int $index): string
    {
        [$from, $to] = [$this->offsets[$index], $this->offsets[$index + 1]];
        return $this->blocks[$index] ??= Lzma::decompress(
            substr($this->data, $from, $to - $from),
            $this->tuning,
        );
    }

    private function number(string $raw, int $place, int $size): int
    {
        $value = 0;
        for ($index = $size - 1; $index >= 0; $index--) {
            $value = $value << 8 | ord($raw[1 + $place * $size + $index]);
        }
        if ($this->encoding === 'fixed') {
            return $value;
        }
        $shift = 64 - 8 * $size;
        return ($value << $shift) >> $shift;
    }

    public function value(int $row): int
    {
        $raw = $this->decoded(intdiv($row, $this->block));
        $place = $row % $this->block;
        if ($this->encoding !== 'delta') {
            return $this->number($raw, $place, ord($raw[0]));
        }
        $total = 0;
        for ($index = 0; $index <= $place; $index++) {
            $total += $this->number($raw, $index, ord($raw[0]));
        }
        return $total;
    }

    public function text(int $identifier): string
    {
        if (!$identifier) {
            return '';
        }
        $group = intdiv($identifier - 1, $this->group);
        $place = ($identifier - 1) % $this->group;
        $index = intdiv($group, $this->fanout);
        $raw = $this->decoded($index);
        $left = intdiv($this->count - $index * $this->block + $this->group - 1, $this->group);
        $cursor = $start = 0;
        for ($step = 0; $step < min($this->fanout, $left) - 1; $step++) {
            $span = varint($raw, $cursor);
            $start += $step < $group % $this->fanout ? $span : 0;
        }
        $cursor += $start;
        $previous = '';
        for ($step = 0; $step <= $place; $step++) {
            $shared = ord($raw[$cursor++]);
            $fresh = varint($raw, $cursor);
            $previous = substr($previous, 0, $shared) . substr($raw, $cursor, $fresh);
            $cursor += $fresh;
        }
        return $previous;
    }

    private function heads(int $index): array
    {
        $raw = $this->decoded($index);
        $cursor = 0;
        $total = intdiv(varint($raw, $cursor) + $this->group - 1, $this->group);
        $heads = [$this->keys[$index]];
        for ($step = 1; $step < $total; $step++) {
            $heads[] = add(end($heads), wide($raw, $cursor));
        }
        $spans = [];
        for ($step = 1; $step < $total; $step++) {
            $spans[] = varint($raw, $cursor);
        }
        $starts = [$cursor];
        foreach ($spans as $span) {
            $starts[] = end($starts) + $span;
        }
        return [$heads, $starts];
    }

    private function values(int $group): array
    {
        $index = intdiv($group, $this->fanout);
        $at = $group % $this->fanout;
        $size = min($this->group, $this->count - $group * $this->group);
        [$heads, $starts] = $this->heads($index);
        $raw = $this->decoded($index);
        $cursor = $starts[$at];
        $wide = $this->width === 16;
        $network = unpack('J', $heads[$at], $wide ? 0 : 8)[1];
        $networks = [$network];
        for ($step = 1; $step < $size; $step++) {
            $networks[] = $network += varint($raw, $cursor);
        }
        $values = [];
        foreach ($networks as $network) {
            $values[] = $wide ? pack('J2', $network, varint($raw, $cursor)) : pack('J2', 0, $network);
        }
        return $values;
    }

    public function row(string $address): ?array
    {
        $index = upper($this->keys, $address) - 1;
        if ($index < 0) {
            return null;
        }
        $group = $index * $this->fanout + upper($this->heads($index)[0], $address) - 1;
        $values = $this->values($group);
        $spot = upper($values, $address) - 1;
        return $spot < 0 ? null : [$group * $this->group + $spot, $values[$spot] === $address];
    }
}

final class Plevin
{
    private array $sections = [];
    private array $books = [];
    private array $tables = [];

    public function __construct(string $path)
    {
        $file = @file_get_contents($path);
        if ($file === false || !str_starts_with($file, "PLEVIN\0\2")) {
            throw new RuntimeException("$path is not a plevin 2 database");
        }
        $size = unpack('V', $file, 8)[1];
        $head = json_decode(substr($file, 12, $size), true);
        foreach ($head['sections'] as $name => $entry) {
            $view = substr($file, 12 + $size + $entry['offset'], $entry['bytes']);
            $this->sections[$name] = new Section($view, $entry);
            $parts = explode('.', $name);
            if (count($parts) === 3 && in_array($parts[0], ['col', 'link'], true)) {
                $this->tables[$parts[1]][] = $name;
            }
        }
        foreach (BOOKS as $field => $book) {
            if (isset($head['vocabularies'][$book])) {
                $this->books[$field] = $head['vocabularies'][$book];
            }
        }
    }

    private function read(string $name, Section $section, int $value): mixed
    {
        return match (true) {
            $name === 'abuse.risk' => $value === 255 ? null : $value / 100,
            in_array($name, ['abuse.is_anycast', 'abuse.is_satellite'], true) => $value !== 0,
            isset($this->books[$name]) => $this->books[$name][$value] ?? '',
            $section->read === 'text' => $this->sections['strings']->text($value),
            $section->read === '' => $value,
            default => $value / 10000,
        };
    }

    private function row(string $table, int $row): array
    {
        $out = [];
        foreach ($this->tables[$table] ?? [] as $name) {
            $section = $this->sections[$name];
            $field = substr($name, strrpos($name, '.') + 1);
            $value = $section->value($row);
            if (str_starts_with($name, 'col.')) {
                $out[$field] = $this->read("$table.$field", $section, $value);
            } elseif ($value) {
                $out[$field] = $this->row($field, $value - 1);
            }
        }
        if (isset($out['postal_partial'], $out['postal'])) {
            $out['postal_partial'] = substr($out['postal'], 0, $out['postal_partial']);
        }
        return $out;
    }

    public function lookup(string $text): ?array
    {
        $raw = @inet_pton($text);
        if ($raw === false) {
            throw new RuntimeException("$text is not an address");
        }
        $version = strlen($raw) === 4 ? 'v4' : 'v6';
        $address = str_pad($raw, 16, "\0", STR_PAD_LEFT);
        $found = ($this->sections["spine.$version"] ?? null)?->row($address);
        if ($found === null) {
            return null;
        }
        $hosts = $this->sections["hosts.$version"] ?? null;
        $records = $this->sections["hosts.$version.abuse"] ?? null;
        $override = 0;
        $host = $hosts && $records ? $hosts->row($address) : null;
        if ($host && $host[1]) {
            $override = $records->value($host[0]) + 1;
        }
        return $this->answer($version, $found[0], $override);
    }

    private function answer(string $version, int $row, int $override): array
    {
        $out = [];
        foreach (CARRIED as $name) {
            $column = $this->sections["spine.$version.$name"] ?? null;
            if ($column === null) {
                continue;
            }
            $value = $override && $name === 'abuse' ? $override : $column->value($row);
            if (!in_array($name, LINKED, true)) {
                $out['network'][$name] = $this->read($name, $column, $value);
            } elseif ($value) {
                $out[$name] = $this->row($name, $value - 1);
            }
        }
        return $out;
    }
}

if ($argc !== 3) {
    fwrite(STDERR, "usage: php plevin.php path address\n");
    exit(1);
}
$flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    | JSON_INVALID_UTF8_SUBSTITUTE;
echo json_encode((new Plevin($argv[1]))->lookup($argv[2]), $flags), "\n";
