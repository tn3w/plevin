using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

if (args.Length != 2)
{
    Console.Error.WriteLine("usage: dotnet run plevin.cs path address");
    return 1;
}
var options = new JsonSerializerOptions
{
    WriteIndented = true,
    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
};
Console.WriteLine(new Plevin(args[0]).Lookup(args[1])?.ToJsonString(options) ?? "null");
return 0;

class Lzma
{
    const int IsRepeat = 192, IsFirst = IsRepeat + 12, IsSecond = IsFirst + 12;
    const int IsThird = IsSecond + 12, IsLong = IsThird + 12, Slots = IsLong + 192;
    const int Special = Slots + 256, Align = Special + 114, Lengths = Align + 16;
    const int Repeats = Lengths + 514, Literals = Repeats + 514;

    readonly byte[] data;
    readonly ushort[] probs;
    readonly List<byte> output = [];
    readonly int context, position, matches;
    int at = 5;
    uint range = uint.MaxValue, code;

    Lzma(byte[] data, int[] tuning)
    {
        (this.data, context, position, matches) = (data, tuning[0], tuning[1], tuning[2]);
        probs = Enumerable.Repeat((ushort)1024, Literals + (0x300 << (context + position))).ToArray();
        code = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(1));
    }

    void Normalize()
    {
        if (range >= 1u << 24) return;
        range <<= 8;
        code = code << 8 | data[at++];
    }

    int Bit(int index)
    {
        uint chance = probs[index], bound = (range >> 11) * chance;
        int result = code < bound ? 0 : 1;
        if (result == 0)
        {
            range = bound;
            probs[index] += (ushort)((2048 - chance) >> 5);
        }
        else
        {
            range -= bound;
            code -= bound;
            probs[index] -= (ushort)(chance >> 5);
        }
        Normalize();
        return result;
    }

    uint Direct(int count)
    {
        uint value = 0;
        for (int step = 0; step < count; step++)
        {
            range >>= 1;
            uint result = code >= range ? 1u : 0u;
            code -= range * result;
            value = value << 1 | result;
            Normalize();
        }
        return value;
    }

    int Tree(int start, int count)
    {
        int symbol = 1;
        for (int step = 0; step < count; step++) symbol = symbol << 1 | Bit(start + symbol);
        return symbol - (1 << count);
    }

    uint Reversed(int start, int count)
    {
        int symbol = 1;
        uint value = 0;
        for (int step = 0; step < count; step++)
        {
            int result = Bit(start + symbol);
            symbol = symbol << 1 | result;
            value |= (uint)result << step;
        }
        return value;
    }

    int Length(int start, int spot)
    {
        if (Bit(start) == 0) return Tree(start + 2 + (spot << 3), 3);
        if (Bit(start + 1) == 0) return 8 + Tree(start + 130 + (spot << 3), 3);
        return 16 + Tree(start + 258, 8);
    }

    uint Distance(int span)
    {
        int slot = Tree(Slots + (Math.Min(span, 3) << 6), 6);
        if (slot < 4) return (uint)slot;
        int count = (slot >> 1) - 1;
        uint start = (uint)(2 | slot & 1) << count;
        if (slot < 14) return start + Reversed(Special + (int)start - slot - 1, count);
        return start + (Direct(count - 4) << 4) + Reversed(Align, 4);
    }

    byte Back(uint distance) => output[output.Count - (int)distance - 1];

    void Literal(int state, uint recent)
    {
        int previous = output.Count > 0 ? output[^1] : 0;
        int spot = (output.Count & ((1 << position) - 1)) << context;
        int start = Literals + 0x300 * (spot + (previous >> (8 - context))), symbol = 1;
        if (state >= 7)
        {
            int matched = Back(recent);
            while (symbol < 0x100)
            {
                int expected = matched >> 7 & 1;
                matched <<= 1;
                int result = Bit(start + ((1 + expected) << 8) + symbol);
                symbol = symbol << 1 | result;
                if (result != expected) break;
            }
        }
        while (symbol < 0x100) symbol = symbol << 1 | Bit(start + symbol);
        output.Add((byte)symbol);
    }

    public static byte[] Decompress(byte[] data, int[] tuning)
    {
        var lzma = new Lzma(data, tuning);
        var recent = new List<uint> { 0, 0, 0, 0 };
        for (int state = 0, span; ;)
        {
            int spot = lzma.output.Count & ((1 << lzma.matches) - 1);
            if (lzma.Bit(state << 4 | spot) == 0)
            {
                lzma.Literal(state, recent[0]);
                state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
                continue;
            }
            if (lzma.Bit(IsRepeat + state) == 1)
            {
                if (lzma.Bit(IsFirst + state) == 1)
                {
                    int picked = lzma.Bit(IsSecond + state) == 0 ? 1 : 2 + lzma.Bit(IsThird + state);
                    uint held = recent[picked];
                    recent.RemoveAt(picked);
                    recent.Insert(0, held);
                }
                else if (lzma.Bit(IsLong + (state << 4 | spot)) == 0)
                {
                    state = state < 7 ? 9 : 11;
                    lzma.output.Add(lzma.Back(recent[0]));
                    continue;
                }
                span = lzma.Length(Repeats, spot);
                state = state < 7 ? 8 : 11;
            }
            else
            {
                recent.RemoveAt(3);
                span = lzma.Length(Lengths, spot);
                state = state < 7 ? 7 : 10;
                recent.Insert(0, lzma.Distance(span));
                if (recent[0] == uint.MaxValue) return [.. lzma.output];
            }
            for (int step = 0; step < span + 2; step++) lzma.output.Add(lzma.Back(recent[0]));
        }
    }
}

class Cursor(byte[] data, int at)
{
    public byte[] Data => data;
    public int At { get => at; set => at = value; }

    public UInt128 Next()
    {
        UInt128 value = 0;
        for (int shift = 0; ; shift += 7)
        {
            byte octet = data[at++];
            value |= (UInt128)(octet & 0x7F) << shift;
            if (octet < 0x80) return value;
        }
    }

    public int Small() => (int)Next();
}

class Section
{
    readonly string encoding;
    readonly int count, block, group, fanout, width;
    readonly int[] tuning, offsets;
    readonly byte[] data;
    readonly UInt128[] keys;
    readonly Dictionary<int, byte[]> blocks = [];
    public readonly string Read;

    public Section(byte[] view, JsonElement entry)
    {
        encoding = entry.GetProperty("encoding").GetString()!;
        Read = entry.GetProperty("read").GetString()!;
        count = entry.GetProperty("count").GetInt32();
        block = entry.GetProperty("block").GetInt32();
        group = entry.GetProperty("group").GetInt32();
        tuning = [.. entry.GetProperty("lzma").EnumerateArray().Select(item => item.GetInt32())];
        fanout = block / group;
        int total = BinaryPrimitives.ReadInt32LittleEndian(view);
        width = BinaryPrimitives.ReadInt32LittleEndian(view.AsSpan(4));
        offsets = [.. Enumerable.Range(0, total + 1)
            .Select(index => BinaryPrimitives.ReadInt32LittleEndian(view.AsSpan(8 + 4 * index)))];
        int start = 8 + 4 * (total + 1);
        keys = [.. Enumerable.Range(0, total)
            .Select(index => view.Skip(start + index * width).Take(width)
                .Aggregate(UInt128.Zero, (key, octet) => key << 8 | octet))];
        data = view[(start + total * width)..];
    }

    byte[] Decoded(int index)
    {
        if (!blocks.TryGetValue(index, out var raw))
            blocks[index] = raw = Lzma.Decompress(data[offsets[index]..offsets[index + 1]], tuning);
        return raw;
    }

    long Number(byte[] raw, int place, int size)
    {
        ulong value = 0;
        for (int index = size - 1; index >= 0; index--) value = value << 8 | raw[1 + place * size + index];
        if (encoding == "fixed") return (long)value;
        int shift = 64 - 8 * size;
        return (long)(value << shift) >> shift;
    }

    public long Value(int row)
    {
        byte[] raw = Decoded(row / block);
        int place = row % block;
        if (encoding != "delta") return Number(raw, place, raw[0]);
        return Enumerable.Range(0, place + 1).Sum(index => Number(raw, index, raw[0]));
    }

    public string Text(long identifier)
    {
        if (identifier == 0) return "";
        int groupIndex = (int)(identifier - 1) / group, place = (int)(identifier - 1) % group;
        int index = groupIndex / fanout;
        var cursor = new Cursor(Decoded(index), 0);
        int total = Math.Min(fanout, (count - index * block + group - 1) / group) - 1;
        var spans = Enumerable.Range(0, total).Select(_ => cursor.Small()).ToList();
        cursor.At += spans.Take(groupIndex % fanout).Sum();
        byte[] previous = [];
        for (int step = 0; step <= place; step++)
        {
            int shared = cursor.Data[cursor.At++], fresh = cursor.Small();
            previous = [.. previous[..shared], .. cursor.Data[cursor.At..(cursor.At + fresh)]];
            cursor.At += fresh;
        }
        return Encoding.UTF8.GetString(previous);
    }

    (List<UInt128> Heads, List<int> Starts) Heads(int index)
    {
        var cursor = new Cursor(Decoded(index), 0);
        int total = (cursor.Small() + group - 1) / group;
        var heads = new List<UInt128> { keys[index] };
        for (int step = 1; step < total; step++) heads.Add(heads[^1] + cursor.Next());
        var spans = Enumerable.Range(1, total - 1).Select(_ => cursor.Small()).ToList();
        var starts = new List<int> { cursor.At };
        foreach (int span in spans) starts.Add(starts[^1] + span);
        return (heads, starts);
    }

    List<UInt128> Values(int groupIndex)
    {
        int index = groupIndex / fanout, at = groupIndex % fanout;
        int size = Math.Min(group, count - groupIndex * group), hostBits = width == 4 ? 0 : 64;
        var (heads, starts) = Heads(index);
        var cursor = new Cursor(Decoded(index), starts[at]);
        var values = new List<UInt128> { heads[at] >> hostBits };
        for (int step = 1; step < size; step++) values.Add(values[^1] + cursor.Next());
        if (hostBits == 0) return values;
        return [.. values.Select(network => network << 64 | cursor.Next())];
    }

    static int Upper(IList<UInt128> values, UInt128 address)
    {
        int low = 0, high = values.Count;
        while (low < high)
        {
            int middle = (low + high) / 2;
            if (values[middle] <= address) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    public (int Row, bool Exact)? Row(UInt128 address)
    {
        int index = Upper(keys, address) - 1;
        if (index < 0) return null;
        int groupIndex = index * fanout + Upper(Heads(index).Heads, address) - 1;
        var values = Values(groupIndex);
        int spot = Upper(values, address) - 1;
        if (spot < 0) return null;
        return (groupIndex * group + spot, values[spot] == address);
    }
}

class Plevin
{
    static readonly string[] Carried = ["place", "network", "abuse", "prefix", "rpki", "roas"];
    static readonly string[] Linked = ["place", "network", "abuse"];
    static readonly Dictionary<string, string> Books = new()
    {
        ["rpki"] = "rpki",
        ["place.granularity"] = "granularity",
        ["city.timezone"] = "timezones",
        ["city.type"] = "place_types",
        ["operator.category"] = "categories",
        ["abuse.user_type"] = "categories",
        ["abuse.service"] = "services",
        ["abuse.evidence"] = "evidence",
    };

    readonly SortedDictionary<string, Section> sections = new(StringComparer.Ordinal);
    readonly Dictionary<string, string[]> books = [];
    readonly Dictionary<string, List<string>> tables = [];

    public Plevin(string path)
    {
        byte[] file = File.ReadAllBytes(path);
        if (file.Length < 12 || !file.AsSpan(0, 8).SequenceEqual("PLEVIN\0\u0002"u8))
            throw new InvalidDataException($"{path} is not a plevin 2 database");
        int size = BinaryPrimitives.ReadInt32LittleEndian(file.AsSpan(8));
        using var head = JsonDocument.Parse(file.AsMemory(12, size));
        foreach (var entry in head.RootElement.GetProperty("sections").EnumerateObject())
        {
            int at = 12 + size + entry.Value.GetProperty("offset").GetInt32();
            int bytes = entry.Value.GetProperty("bytes").GetInt32();
            sections[entry.Name] = new Section(file[at..(at + bytes)], entry.Value);
            string[] parts = entry.Name.Split('.');
            if (parts.Length == 3 && parts[0] is "col" or "link")
            {
                if (!tables.ContainsKey(parts[1])) tables[parts[1]] = [];
                tables[parts[1]].Add(entry.Name);
            }
        }
        var vocabularies = head.RootElement.GetProperty("vocabularies");
        foreach (var (field, book) in Books)
            if (vocabularies.TryGetProperty(book, out var words))
                books[field] = [.. words.EnumerateArray().Select(word => word.GetString()!)];
    }

    JsonNode? Read(string name, Section section, long value)
    {
        if (name == "abuse.risk") return value == 255 ? null : value / 100.0;
        if (name is "abuse.is_anycast" or "abuse.is_satellite") return value != 0;
        if (books.TryGetValue(name, out var book)) return value < book.Length ? book[value] : "";
        if (section.Read == "text") return sections["strings"].Text(value);
        return section.Read == "" ? (JsonNode)value : value / 10000.0;
    }

    JsonObject Row(string table, int row)
    {
        var output = new JsonObject();
        foreach (string name in tables.GetValueOrDefault(table, []))
        {
            var section = sections[name];
            string field = name[(name.LastIndexOf('.') + 1)..];
            long value = section.Value(row);
            if (name.StartsWith("col.")) output[field] = Read($"{table}.{field}", section, value);
            else if (value != 0) output[field] = Row(field, (int)value - 1);
        }
        if (output["postal_partial"] is JsonValue partial && output["postal"] is JsonValue postal)
        {
            string text = postal.GetValue<string>();
            output["postal_partial"] = text[..(int)Math.Min(partial.GetValue<long>(), text.Length)];
        }
        return output;
    }

    public JsonObject? Lookup(string text)
    {
        var address = IPAddress.Parse(text);
        string version = address.AddressFamily == AddressFamily.InterNetwork ? "v4" : "v6";
        var key = address.GetAddressBytes().Aggregate(UInt128.Zero, (key, octet) => key << 8 | octet);
        var found = sections.GetValueOrDefault($"spine.{version}")?.Row(key);
        if (found is not (int row, _)) return null;
        long hostAbuse = 0;
        if (sections.TryGetValue($"hosts.{version}", out var hosts)
            && sections.TryGetValue($"hosts.{version}.abuse", out var records)
            && hosts.Row(key) is (int at, true))
            hostAbuse = records.Value(at) + 1;
        return Answer(version, row, hostAbuse);
    }

    JsonObject Answer(string version, int row, long hostAbuse)
    {
        var output = new JsonObject();
        foreach (string name in Carried)
        {
            if (!sections.TryGetValue($"spine.{version}.{name}", out var column)) continue;
            long value = hostAbuse != 0 && name == "abuse" ? hostAbuse : column.Value(row);
            if (Linked.Contains(name))
            {
                if (value != 0) output[name] = Row(name, (int)value - 1);
                continue;
            }
            output["network"] ??= new JsonObject();
            output["network"]![name] = Read(name, column, value);
        }
        return output;
    }
}
