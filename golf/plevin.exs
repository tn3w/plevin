defmodule Lzma do
  import Bitwise

  @is_repeat 192
  @is_first @is_repeat + 12
  @is_second @is_first + 12
  @is_third @is_second + 12
  @is_long @is_third + 12
  @slots @is_long + 192
  @special @slots + 256
  @align @special + 114
  @lengths @align + 16
  @repeats @lengths + 514
  @literals @repeats + 514
  @mask 0xFFFFFFFF
  @range 1
  @code 2
  @at 3
  @probs 4

  def open(<<_, code::32, _::binary>> = packed, [context, position, matches]) do
    count = @literals + (0x300 <<< (context + position))
    cells = :atomics.new(@probs + count, [])
    for index <- 0..(count - 1), do: :atomics.put(cells, @probs + index, 1024)
    :atomics.put(cells, @range, @mask)
    :atomics.put(cells, @code, code)
    :atomics.put(cells, @at, 5)
    tuning = {context, position, matches}

    %{
      cells: cells,
      packed: packed,
      tuning: tuning,
      out: <<>>,
      state: 0,
      recent: [0, 0, 0, 0]
    }
  end

  def fill(decoder, want) do
    if Map.get(decoder, :done) || byte_size(decoder.out) >= want,
      do: decoder,
      else: fill(step(decoder), want)
  end

  defp step(%{out: out, state: state, tuning: {_, _, matches}} = decoder) do
    spot = byte_size(out) &&& (1 <<< matches) - 1

    cond do
      bit(decoder, state <<< 4 ||| spot) == 0 -> literal(decoder)
      bit(decoder, @is_repeat + state) == 0 -> match(decoder, spot)
      true -> repeat(decoder, spot)
    end
  end

  defp normalize(%{cells: cells, packed: packed}, range, code) when range < 0x1000000 do
    at = :atomics.get(cells, @at)
    :atomics.put(cells, @range, range <<< 8 &&& @mask)
    :atomics.put(cells, @code, (code <<< 8 ||| :binary.at(packed, at)) &&& @mask)
    :atomics.put(cells, @at, at + 1)
  end

  defp normalize(%{cells: cells}, range, code) do
    :atomics.put(cells, @range, range)
    :atomics.put(cells, @code, code)
  end

  defp bit(%{cells: cells} = decoder, index) do
    chance = :atomics.get(cells, @probs + index)
    range = :atomics.get(cells, @range)
    code = :atomics.get(cells, @code)
    bound = (range >>> 11) * chance

    if code < bound do
      :atomics.put(cells, @probs + index, chance + ((2048 - chance) >>> 5))
      normalize(decoder, bound, code)
      0
    else
      :atomics.put(cells, @probs + index, chance - (chance >>> 5))
      normalize(decoder, range - bound, code - bound)
      1
    end
  end

  defp direct(%{cells: cells} = decoder, count) do
    Enum.reduce(1..count//1, 0, fn _, value ->
      range = :atomics.get(cells, @range) >>> 1
      code = :atomics.get(cells, @code)
      result = if code >= range, do: 1, else: 0
      normalize(decoder, range, code - range * result)
      value <<< 1 ||| result
    end)
  end

  defp tree(decoder, base, count) do
    symbol =
      Enum.reduce(1..count, 1, fn _, symbol ->
        symbol <<< 1 ||| bit(decoder, base + symbol)
      end)

    symbol - (1 <<< count)
  end

  defp reversed(decoder, base, count) do
    {value, _} =
      Enum.reduce(0..(count - 1)//1, {0, 1}, fn step, {value, symbol} ->
        result = bit(decoder, base + symbol)
        {value ||| result <<< step, symbol <<< 1 ||| result}
      end)

    value
  end

  defp span(decoder, base, spot) do
    cond do
      bit(decoder, base) == 0 -> tree(decoder, base + 2 + (spot <<< 3), 3)
      bit(decoder, base + 1) == 0 -> 8 + tree(decoder, base + 130 + (spot <<< 3), 3)
      true -> 16 + tree(decoder, base + 258, 8)
    end
  end

  defp distance(decoder, span) do
    slot = tree(decoder, @slots + (min(span, 3) <<< 6), 6)
    count = (slot >>> 1) - 1
    base = (2 ||| (slot &&& 1)) <<< max(count, 0)

    cond do
      slot < 4 -> slot
      slot < 14 -> base + reversed(decoder, @special + base - slot - 1, count)
      true -> base + (direct(decoder, count - 4) <<< 4) + reversed(decoder, @align, 4)
    end
  end

  defp after_literal(state) when state < 4, do: 0
  defp after_literal(state) when state < 10, do: state - 3
  defp after_literal(state), do: state - 6

  defp literal(%{out: out, state: state, recent: [distance | _]} = decoder) do
    {context, position, _} = decoder.tuning
    size = byte_size(out)
    previous = if size > 0, do: :binary.last(out), else: 0
    spot = (size &&& (1 <<< position) - 1) <<< context
    base = @literals + 0x300 * (spot + (previous >>> (8 - context)))
    symbol = if state >= 7, do: matched(decoder, base, back(out, distance), 1), else: 1
    symbol = plain(decoder, base, symbol)
    %{decoder | out: <<out::binary, symbol &&& 0xFF>>, state: after_literal(state)}
  end

  defp matched(decoder, base, byte, symbol) when symbol < 0x100 do
    expected = byte >>> 7 &&& 1
    result = bit(decoder, base + ((1 + expected) <<< 8) + symbol)
    symbol = symbol <<< 1 ||| result
    if result == expected, do: matched(decoder, base, byte <<< 1, symbol), else: symbol
  end

  defp matched(_, _, _, symbol), do: symbol

  defp plain(decoder, base, symbol) when symbol < 0x100,
    do: plain(decoder, base, symbol <<< 1 ||| bit(decoder, base + symbol))

  defp plain(_, _, symbol), do: symbol

  defp match(%{state: state, recent: recent} = decoder, spot) do
    span = span(decoder, @lengths, spot)
    distance = distance(decoder, span)
    state = if state < 7, do: 7, else: 10
    decoder = %{decoder | state: state, recent: [distance | Enum.take(recent, 3)]}
    if distance == @mask, do: Map.put(decoder, :done, true), else: copy(decoder, span)
  end

  defp repeat(%{state: state, recent: recent} = decoder, spot) do
    cond do
      bit(decoder, @is_first + state) == 1 ->
        picked =
          if bit(decoder, @is_second + state) == 0,
            do: 1,
            else: 2 + bit(decoder, @is_third + state)

        recent = [Enum.at(recent, picked) | List.delete_at(recent, picked)]
        long_repeat(%{decoder | recent: recent}, spot)

      bit(decoder, @is_long + (state <<< 4 ||| spot)) == 0 ->
        state = if state < 7, do: 9, else: 11

        %{
          decoder
          | state: state,
            out: <<decoder.out::binary, back(decoder.out, hd(recent))>>
        }

      true ->
        long_repeat(decoder, spot)
    end
  end

  defp long_repeat(%{state: state} = decoder, spot) do
    span = span(decoder, @repeats, spot)
    copy(%{decoder | state: if(state < 7, do: 8, else: 11)}, span)
  end

  defp copy(%{out: out, recent: [distance | _]} = decoder, span) do
    count = span + 2
    start = byte_size(out) - distance - 1

    piece =
      if count <= distance + 1,
        do: binary_part(out, start, count),
        else:
          binary_part(
            :binary.copy(binary_part(out, start, distance + 1), count),
            0,
            count
          )

    %{decoder | out: out <> piece}
  end

  defp back(out, distance), do: :binary.at(out, byte_size(out) - distance - 1)
end

defmodule Plevin do
  import Bitwise

  @carried ~w(place network abuse prefix rpki roas rir country since)
  @linked ~w(place network abuse)
  @books %{
    "rpki" => "rpki",
    "rir" => "rirs",
    "country" => "countries",
    "place.granularity" => "granularity",
    "city.timezone" => "timezones",
    "city.type" => "place_types",
    "operator.category" => "categories",
    "abuse.user_type" => "categories",
    "abuse.service" => "services",
    "abuse.evidence" => "evidence",
    "abuse.threat" => "threats",
    "abuse.level" => "levels"
  }

  def open(path) do
    case File.read(path) do
      {:ok, <<"PLEVIN", 0, 2, size::little-32, rest::binary>>} -> parse(size, rest)
      _ -> fail("#{path} is not a plevin 2 database")
    end
  end

  defp parse(size, rest) do
    <<header::binary-size(^size), body::binary>> = rest
    head = :json.decode(header)

    sections =
      Map.new(head["sections"], fn {name, entry} ->
        {name, section(name, binary_part(body, entry["offset"], entry["bytes"]), entry)}
      end)

    books =
      for {field, book} <- @books, Map.has_key?(head["vocabularies"], book), into: %{} do
        {field, List.to_tuple(head["vocabularies"][book])}
      end

    %{sections: sections, books: books, tables: tables(sections)}
  end

  defp tables(sections) do
    for {name, _} <- sections,
        [kind, owner, field] <- [String.split(name, ".")],
        kind in ["col", "link"],
        reduce: %{} do
      tables ->
        Map.update(tables, owner, [{kind, field, name}], &[{kind, field, name} | &1])
    end
  end

  defp section(name, <<total::little-32, width::little-32, rest::binary>>, entry) do
    table = 4 * (total + 1)

    <<offsets::binary-size(^table), keys::binary-size(^width * ^total), data::binary>> =
      rest

    %{
      name: name,
      encoding: entry["encoding"],
      read: entry["read"],
      count: entry["count"],
      block: entry["block"],
      group: entry["group"],
      fanout: div(entry["block"], entry["group"]),
      tuning: entry["lzma"],
      width: width,
      offsets: List.to_tuple(for <<offset::little-32 <- offsets>>, do: offset),
      keys:
        if(width > 0,
          do: for(<<key::binary-size(^width) <- keys>>, do: :binary.decode_unsigned(key)),
          else: []
        ),
      data: data
    }
  end

  defp decoded(section, index, want) do
    decoder =
      Process.get({section.name, index}) ||
        Lzma.open(
          binary_part(
            section.data,
            elem(section.offsets, index),
            elem(section.offsets, index + 1) - elem(section.offsets, index)
          ),
          section.tuning
        )

    decoder = Lzma.fill(decoder, want)
    Process.put({section.name, index}, decoder)
    decoder.out
  end

  defp reader(section, index), do: &:binary.at(decoded(section, index, &1 + 1), &1)

  defp varint(get, at, shift \\ 0, value \\ 0) do
    octet = get.(at)
    value = value ||| (octet &&& 0x7F) <<< shift
    if octet < 0x80, do: {value, at + 1}, else: varint(get, at + 1, shift + 7, value)
  end

  defp varints(get, at, count),
    do: Enum.map_reduce(1..count//1, at, fn _, at -> varint(get, at) end)

  defp value(section, row) do
    index = div(row, section.block)
    place = rem(row, section.block)
    width = :binary.at(decoded(section, index, 1), 0)
    bits = width * 8

    raw =
      binary_part(
        decoded(section, index, 1 + (place + 1) * width),
        1,
        (place + 1) * width
      )

    <<_::binary-size(^place * ^width), last::binary>> = raw

    case {section.encoding, last} do
      {"delta", _} ->
        for <<number::little-signed-size(^bits) <- raw>>,
          reduce: 0,
          do: (sum -> sum + number)

      {"signed", <<number::little-signed-size(^bits)>>} ->
        number

      {_, <<number::little-size(^bits)>>} ->
        number
    end
  end

  defp text(_, 0), do: ""

  defp text(section, identifier) do
    group = div(identifier - 1, section.group)
    index = div(group, section.fanout)
    get = reader(section, index)
    left = section.count - index * section.block
    total = min(section.fanout, div(left + section.group - 1, section.group)) - 1
    {lengths, cursor} = varints(get, 0, total)
    cursor = cursor + Enum.sum(Enum.take(lengths, rem(group, section.fanout)))

    {previous, _} =
      Enum.reduce(0..rem(identifier - 1, section.group), {"", cursor}, fn _,
                                                                          {previous,
                                                                           cursor} ->
        shared = get.(cursor)
        {fresh, cursor} = varint(get, cursor + 1)

        piece =
          for offset <- cursor..(cursor + fresh - 1)//1, into: <<>>, do: <<get.(offset)>>

        {binary_part(previous, 0, shared) <> piece, cursor + fresh}
      end)

    String.replace_invalid(previous)
  end

  defp heads(section, index) do
    get = reader(section, index)
    {count, cursor} = varint(get, 0)
    total = div(count + section.group - 1, section.group)
    {gaps, cursor} = varints(get, cursor, total - 1)
    {sizes, cursor} = varints(get, cursor, total - 1)

    {Enum.scan([Enum.at(section.keys, index) | gaps], &+/2),
     Enum.scan([cursor | sizes], &+/2)}
  end

  defp values(section, group) do
    index = div(group, section.fanout)
    at = rem(group, section.fanout)
    {heads, starts} = heads(section, index)
    get = reader(section, index)
    size = min(section.group, section.count - group * section.group)
    host_bits = if section.width == 4, do: 0, else: 64
    {gaps, cursor} = varints(get, Enum.at(starts, at), size - 1)
    networks = Enum.scan([Enum.at(heads, at) >>> host_bits | gaps], &+/2)
    {hosts, _} = varints(get, cursor, if(host_bits == 0, do: 0, else: size))

    if hosts == [],
      do: networks,
      else: Enum.zip_with(networks, hosts, &(&1 <<< 64 ||| &2))
  end

  defp upper(values, address), do: Enum.count(values, &(&1 <= address))

  defp row(section, address) do
    index = upper(section.keys, address) - 1

    with true <- index >= 0,
         {heads, _} = heads(section, index),
         group = index * section.fanout + upper(heads, address) - 1,
         values = values(section, group),
         spot = upper(values, address) - 1,
         true <- spot >= 0 do
      {group * section.group + spot, Enum.at(values, spot) == address}
    else
      _ -> nil
    end
  end

  defp read(plevin, name, section, value) do
    book = plevin.books[name]

    cond do
      name == "abuse.risk" -> if value == 255, do: :null, else: value / 100
      name in ["abuse.is_anycast", "abuse.is_satellite"] -> value != 0
      book && value < tuple_size(book) -> elem(book, value)
      book -> ""
      section.read == "text" -> text(plevin.sections["strings"], value)
      section.read != "" -> value / 10_000
      true -> value
    end
  end

  defp record(plevin, owner, row) do
    out =
      for {kind, field, name} <- Map.get(plevin.tables, owner, []), reduce: %{} do
        out ->
          section = plevin.sections[name]
          value = value(section, row)

          cond do
            kind == "col" ->
              Map.put(out, field, read(plevin, "#{owner}.#{field}", section, value))

            value != 0 ->
              Map.put(out, field, record(plevin, field, value - 1))

            true ->
              out
          end
      end

    case out do
      %{"postal_partial" => length, "postal" => postal} ->
        %{out | "postal_partial" => String.slice(postal, 0, length)}

      _ ->
        out
    end
  end

  defp answer(plevin, version, row, override) do
    for name <- @carried,
        column = plevin.sections["spine.#{version}.#{name}"],
        reduce: %{} do
      out ->
        value =
          if override != 0 and name == "abuse", do: override, else: value(column, row)

        cond do
          name not in @linked ->
            Map.update(
              out,
              "network",
              %{name => read(plevin, name, column, value)},
              fn network ->
                Map.put(network, name, read(plevin, name, column, value))
              end
            )

          value != 0 ->
            Map.put(out, name, record(plevin, name, value - 1))

          true ->
            out
        end
    end
  end

  defp address(text) do
    case :inet.parse_strict_address(String.to_charlist(text)) do
      {:ok, {_, _, _, _} = four} -> parts(four, 8)
      {:ok, six} -> parts(six, 16)
      _ -> fail("#{text} is not an address")
    end
  end

  defp parts(tuple, bits),
    do: tuple |> Tuple.to_list() |> Enum.reduce(0, &(&2 <<< bits ||| &1))

  def lookup(plevin, text) do
    version = if String.contains?(text, ":"), do: "v6", else: "v4"
    address = address(text)
    hosts = plevin.sections["hosts.#{version}"]
    records = plevin.sections["hosts.#{version}.abuse"]

    with %{} = spine <- plevin.sections["spine.#{version}"],
         {row, _} <- row(spine, address) do
      override =
        with %{} <- hosts,
             %{} <- records,
             {at, true} <- row(hosts, address),
             do: value(records, at) + 1,
             else: (_ -> 0)

      answer(plevin, version, row, override)
    else
      _ -> :null
    end
  end

  def fail(reason) do
    IO.puts(:stderr, reason)
    System.halt(1)
  end
end

case System.argv() do
  [path, address] ->
    path |> Plevin.open() |> Plevin.lookup(address) |> :json.format() |> IO.write()

  _ ->
    Plevin.fail("usage: elixir plevin.exs path address")
end
