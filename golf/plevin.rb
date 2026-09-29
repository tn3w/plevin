require "ipaddr"
require "json"

RubyVM::YJIT.enable if defined?(RubyVM::YJIT)

IS_REPEAT = 192
IS_FIRST = IS_REPEAT + 12
IS_SECOND = IS_FIRST + 12
IS_THIRD = IS_SECOND + 12
IS_LONG = IS_THIRD + 12
SLOTS = IS_LONG + 192
SPECIAL = SLOTS + 256
ALIGN = SPECIAL + 114
LENGTHS = ALIGN + 16
REPEATS = LENGTHS + 514
LITERALS = REPEATS + 514
MASK = 0xFFFFFFFF

CARRIED = %w[place network abuse prefix rpki roas].freeze
LINKED = %w[place network abuse].freeze
BOOKS = {
  "rpki" => "rpki", "place.granularity" => "granularity", "city.timezone" => "timezones",
  "city.type" => "place_types", "operator.category" => "categories",
  "abuse.user_type" => "categories", "abuse.service" => "services",
  "abuse.evidence" => "evidence"
}.freeze

class Lzma
  def initialize(data, tuning)
    @data = data.bytes
    @context, @position, @matches = tuning
    @probs = Array.new(LITERALS + (0x300 << (@context + @position)), 1024)
    @at = 5
    @range = MASK
    @code = data.unpack1("N", offset: 1)
    @out = []
    @recent = [0, 0, 0, 0]
    @state = 0
  end

  def [](index)
    step until @done || @out.size > index
    @out[index]
  end

  def bytes(from, count) = Array.new(count) { |offset| self[from + offset] }.pack("C*")

  private

  def step
    spot = @out.size & ((1 << @matches) - 1)
    return literal if bit(@state << 4 | spot).zero?
    return match(spot) if bit(IS_REPEAT + @state).zero?

    if bit(IS_FIRST + @state) == 1
      picked = bit(IS_SECOND + @state).zero? ? 1 : 2 + bit(IS_THIRD + @state)
      @recent.unshift(@recent.delete_at(picked))
    elsif bit(IS_LONG + (@state << 4 | spot)).zero?
      @state = @state < 7 ? 9 : 11
      return @out << back(@recent[0])
    end
    @state = @state < 7 ? 8 : 11
    copy(length(REPEATS, spot))
  end

  def match(spot)
    @recent.pop
    span = length(LENGTHS, spot)
    @state = @state < 7 ? 7 : 10
    @recent.unshift(distance(span))
    return @done = true if @recent[0] == MASK

    copy(span)
  end

  def copy(span) = (span + 2).times { @out << back(@recent[0]) }

  def normalize
    return if @range >= 1 << 24

    @range = (@range << 8) & MASK
    @code = ((@code << 8) | @data[@at]) & MASK
    @at += 1
  end

  def bit(index)
    chance = @probs[index]
    bound = (@range >> 11) * chance
    if @code < bound
      @range = bound
      @probs[index] += (2048 - chance) >> 5
      result = 0
    else
      @range -= bound
      @code -= bound
      @probs[index] -= chance >> 5
      result = 1
    end
    normalize
    result
  end

  def direct(count)
    count.times.reduce(0) do |value, _|
      @range >>= 1
      result = @code >= @range ? 1 : 0
      @code -= @range * result
      normalize
      value << 1 | result
    end
  end

  def tree(base, count)
    symbol = 1
    count.times { symbol = symbol << 1 | bit(base + symbol) }
    symbol - (1 << count)
  end

  def reversed(base, count)
    symbol = 1
    count.times.reduce(0) do |value, step|
      result = bit(base + symbol)
      symbol = symbol << 1 | result
      value | result << step
    end
  end

  def length(base, spot)
    return tree(base + 2 + (spot << 3), 3) if bit(base).zero?
    return 8 + tree(base + 130 + (spot << 3), 3) if bit(base + 1).zero?

    16 + tree(base + 258, 8)
  end

  def distance(span)
    slot = tree(SLOTS + ([span, 3].min << 6), 6)
    return slot if slot < 4

    count = (slot >> 1) - 1
    base = (2 | (slot & 1)) << count
    return base + reversed(SPECIAL + base - slot - 1, count) if slot < 14

    base + (direct(count - 4) << 4) + reversed(ALIGN, 4)
  end

  def back(distance) = @out[@out.size - distance - 1]

  def literal
    previous = @out.last || 0
    spot = (@out.size & ((1 << @position) - 1)) << @context
    base = LITERALS + 0x300 * (spot + (previous >> (8 - @context)))
    symbol = 1
    if @state >= 7
      matched = back(@recent[0])
      while symbol < 0x100
        expected = (matched >> 7) & 1
        matched <<= 1
        result = bit(base + ((1 + expected) << 8) + symbol)
        symbol = symbol << 1 | result
        break if result != expected
      end
    end
    symbol = symbol << 1 | bit(base + symbol) while symbol < 0x100
    @out << (symbol & 0xFF)
    @state = @state < 4 ? 0 : @state < 10 ? @state - 3 : @state - 6
  end
end

class Cursor
  attr_accessor :at
  attr_reader :data

  def initialize(data, at = 0)
    @data = data
    @at = at
  end

  def next
    value = 0
    shift = 0
    loop do
      octet = @data[@at]
      @at += 1
      value |= (octet & 0x7F) << shift
      return value if octet < 0x80

      shift += 7
    end
  end
end

def upper(values, address) = values.bsearch_index { |value| value > address } || values.size

class Section
  attr_reader :read

  def initialize(view, entry)
    @encoding, @read, @count, @block, @group, @tuning =
      entry.values_at("encoding", "read", "count", "block", "group", "lzma")
    @fanout = @block / @group
    total, @width = view.unpack("V2")
    @offsets = view.unpack("V#{total + 1}", offset: 8)
    at = 8 + 4 * (total + 1)
    @keys = Array.new(total) { |index| view[at + index * @width, @width].unpack1("H*").to_i(16) }
    @data = view.byteslice(at + total * @width..)
    @blocks = {}
  end

  def value(row)
    raw = decoded(row / @block)
    place = row % @block
    return number(raw, place) if @encoding != "delta"

    (0..place).sum { |index| number(raw, index) }
  end

  def text(identifier)
    return "" if identifier.zero?

    group, place = (identifier - 1).divmod(@group)
    index, at = group.divmod(@fanout)
    cursor = Cursor.new(decoded(index))
    spans = Array.new([@fanout, (@count - index * @block).ceildiv(@group)].min - 1) { cursor.next }
    cursor.at += spans.take(at).sum
    previous = (0..place).reduce(String.new) do |text, _|
      shared = cursor.data[cursor.at]
      cursor.at += 1
      fresh = cursor.next
      cursor.at += fresh
      text.byteslice(0, shared) + cursor.data.bytes(cursor.at - fresh, fresh)
    end
    previous.force_encoding("UTF-8").scrub
  end

  def row(address)
    index = upper(@keys, address) - 1
    return if index.negative?

    group = index * @fanout + upper(heads(index)[0], address) - 1
    values = values(group)
    spot = upper(values, address) - 1
    [group * @group + spot, values[spot] == address] unless spot.negative?
  end

  private

  def decoded(index)
    @blocks[index] ||= Lzma.new(@data.byteslice(@offsets[index]...@offsets[index + 1]), @tuning)
  end

  def number(raw, place)
    size = raw[0]
    value = raw.bytes(1 + place * size, size).bytes.reverse.reduce(0) { |sum, octet| sum << 8 | octet }
    return value if @encoding == "fixed" || value < 1 << (8 * size - 1)

    value - (1 << (8 * size))
  end

  def heads(index)
    cursor = Cursor.new(decoded(index))
    total = cursor.next.ceildiv(@group)
    heads = Array.new(total - 1) { cursor.next }.reduce([@keys[index]]) { |all, gap| all << all.last + gap }
    spans = Array.new(total - 1) { cursor.next }
    [heads, spans.reduce([cursor.at]) { |all, span| all << all.last + span }]
  end

  def values(group)
    index, at = group.divmod(@fanout)
    size = [@group, @count - group * @group].min
    heads, starts = heads(index)
    cursor = Cursor.new(decoded(index), starts[at])
    host_bits = @width == 4 ? 0 : 64
    gaps = Array.new(size - 1) { cursor.next }
    networks = gaps.reduce([heads[at] >> host_bits]) { |all, gap| all << all.last + gap }
    return networks if host_bits.zero?

    networks.map { |network| network << 64 | cursor.next }
  end
end

class Plevin
  def initialize(path)
    file = File.binread(path)
    raise "#{path} is not a plevin 2 database" unless file.start_with?("PLEVIN\0\2".b)

    size = file.unpack1("V", offset: 8)
    head = JSON.parse(file.byteslice(12, size))
    @sections = head["sections"].to_h do |name, entry|
      view = file.byteslice(12 + size + entry["offset"], entry["bytes"])
      [name, Section.new(view, entry)]
    end
    @tables = @sections.keys.map { |name| name.split(".") }
      .select { |parts| parts.size == 3 && %w[col link].include?(parts[0]) }
      .group_by { |parts| parts[1] }
    @books = BOOKS.filter_map do |field, book|
      [field, head["vocabularies"][book]] if head["vocabularies"].key?(book)
    end.to_h
  end

  def lookup(text)
    address = IPAddr.new(text)
    version = address.ipv4? ? "v4" : "v6"
    row, = @sections["spine.#{version}"]&.row(address.to_i)
    return if row.nil?

    hosts = @sections["hosts.#{version}"]
    records = @sections["hosts.#{version}.abuse"]
    at, exact = hosts.row(address.to_i) if hosts && records
    answer(version, row, exact ? records.value(at) + 1 : 0)
  end

  private

  def read(name, section, value)
    return value == 255 ? nil : value / 100.0 if name == "abuse.risk"
    return !value.zero? if %w[abuse.is_anycast abuse.is_satellite].include?(name)
    return @books[name][value] || "" if @books.key?(name)
    return @sections["strings"].text(value) if section.read == "text"

    section.read.empty? ? value : value / 10_000.0
  end

  def row(table, row)
    out = {}
    @tables.fetch(table, []).each do |kind, _, field|
      section = @sections["#{kind}.#{table}.#{field}"]
      value = section.value(row)
      if kind == "col"
        out[field] = read("#{table}.#{field}", section, value)
      elsif value.positive?
        out[field] = row(field, value - 1)
      end
    end
    out["postal_partial"] = out["postal"][0, out["postal_partial"]] if out.key?("postal_partial")
    out
  end

  def answer(version, row, override)
    CARRIED.each_with_object({}) do |name, out|
      column = @sections["spine.#{version}.#{name}"]
      next if column.nil?

      value = override.positive? && name == "abuse" ? override : column.value(row)
      if !LINKED.include?(name)
        (out["network"] ||= {})[name] = read(name, column, value)
      elsif value.positive?
        out[name] = row(name, value - 1)
      end
    end
  end
end

abort "usage: ruby plevin.rb path address" if ARGV.size != 2
puts JSON.pretty_generate(Plevin.new(ARGV[0]).lookup(ARGV[1]))
