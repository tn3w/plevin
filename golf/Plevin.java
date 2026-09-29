static final int IS_REPEAT = 192, IS_FIRST = IS_REPEAT + 12, IS_SECOND = IS_FIRST + 12;
static final int IS_THIRD = IS_SECOND + 12, IS_LONG = IS_THIRD + 12, SLOTS = IS_LONG + 192;
static final int SPECIAL = SLOTS + 256, ALIGN = SPECIAL + 114, LENGTHS = ALIGN + 16;
static final int REPEATS = LENGTHS + 514, LITERALS = REPEATS + 514;

static final List<String> CARRIED = List.of("place", "network", "abuse", "prefix", "rpki", "roas");
static final Map<String, String> BOOKS = Map.of(
    "rpki", "rpki", "place.granularity", "granularity", "city.timezone", "timezones",
    "city.type", "place_types", "operator.category", "categories",
    "abuse.user_type", "categories", "abuse.service", "services", "abuse.evidence", "evidence");

static class Lzma {
    final byte[] data;
    final short[] probs;
    byte[] out = new byte[1 << 16];
    int at = 5, range = -1, code, size;

    Lzma(byte[] data, int from, int to, int context, int position) {
        this.data = Arrays.copyOfRange(data, from, to);
        probs = new short[LITERALS + (0x300 << (context + position))];
        Arrays.fill(probs, (short) 1024);
        for (int index = 1; index < 5; index++) code = code << 8 | this.data[index] & 0xFF;
    }

    void normalize() {
        if (Integer.compareUnsigned(range, 1 << 24) >= 0) return;
        range <<= 8;
        code = code << 8 | data[at++] & 0xFF;
    }

    int bit(int index) {
        int chance = probs[index], bound = (range >>> 11) * chance, result = 0;
        if (Integer.compareUnsigned(code, bound) < 0) {
            range = bound;
            probs[index] += (short) ((2048 - chance) >> 5);
        } else {
            range -= bound;
            code -= bound;
            probs[index] -= (short) (chance >> 5);
            result = 1;
        }
        normalize();
        return result;
    }

    int direct(int count) {
        int value = 0;
        for (int step = 0; step < count; step++) {
            range >>>= 1;
            int result = Integer.compareUnsigned(code, range) >= 0 ? 1 : 0;
            code -= range * result;
            value = value << 1 | result;
            normalize();
        }
        return value;
    }

    int tree(int base, int count) {
        int symbol = 1;
        for (int step = 0; step < count; step++) symbol = symbol << 1 | bit(base + symbol);
        return symbol - (1 << count);
    }

    int reversed(int base, int count) {
        int symbol = 1, value = 0;
        for (int step = 0; step < count; step++) {
            int result = bit(base + symbol);
            symbol = symbol << 1 | result;
            value |= result << step;
        }
        return value;
    }

    int length(int base, int spot) {
        if (bit(base) == 0) return tree(base + 2 + (spot << 3), 3);
        if (bit(base + 1) == 0) return 8 + tree(base + 130 + (spot << 3), 3);
        return 16 + tree(base + 258, 8);
    }

    int distance(int span) {
        int slot = tree(SLOTS + (Math.min(span, 3) << 6), 6);
        if (slot < 4) return slot;
        int count = (slot >> 1) - 1, base = (2 | slot & 1) << count;
        if (slot < 14) return base + reversed(SPECIAL + base - slot - 1, count);
        return base + (direct(count - 4) << 4) + reversed(ALIGN, 4);
    }

    void push(int value) {
        if (size == out.length) out = Arrays.copyOf(out, size * 2);
        out[size++] = (byte) value;
    }

    void literal(int state, int recent, int context, int position) {
        int previous = size > 0 ? out[size - 1] & 0xFF : 0;
        int spot = (size & ((1 << position) - 1)) << context;
        int base = LITERALS + 0x300 * (spot + (previous >> (8 - context))), symbol = 1;
        if (state >= 7) {
            int matched = out[size - recent - 1] & 0xFF;
            while (symbol < 0x100) {
                int expected = matched >> 7 & 1;
                matched <<= 1;
                int result = bit(base + ((1 + expected) << 8) + symbol);
                symbol = symbol << 1 | result;
                if (result != expected) break;
            }
        }
        while (symbol < 0x100) symbol = symbol << 1 | bit(base + symbol);
        push(symbol);
    }

    static byte[] decompress(byte[] data, int from, int to, int[] tuning) {
        var lzma = new Lzma(data, from, to, tuning[0], tuning[1]);
        int[] recent = new int[4];
        for (int state = 0, span; ; ) {
            int spot = lzma.size & ((1 << tuning[2]) - 1);
            if (lzma.bit(state << 4 | spot) == 0) {
                lzma.literal(state, recent[0], tuning[0], tuning[1]);
                state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
                continue;
            }
            if (lzma.bit(IS_REPEAT + state) == 1) {
                if (lzma.bit(IS_FIRST + state) == 1) {
                    int picked = lzma.bit(IS_SECOND + state) == 0 ? 1 : 2 + lzma.bit(IS_THIRD + state);
                    int held = recent[picked];
                    System.arraycopy(recent, 0, recent, 1, picked);
                    recent[0] = held;
                } else if (lzma.bit(IS_LONG + (state << 4 | spot)) == 0) {
                    state = state < 7 ? 9 : 11;
                    lzma.push(lzma.out[lzma.size - recent[0] - 1]);
                    continue;
                }
                span = lzma.length(REPEATS, spot);
                state = state < 7 ? 8 : 11;
            } else {
                System.arraycopy(recent, 0, recent, 1, 3);
                span = lzma.length(LENGTHS, spot);
                state = state < 7 ? 7 : 10;
                recent[0] = lzma.distance(span);
                if (recent[0] == -1) return Arrays.copyOf(lzma.out, lzma.size);
            }
            for (int step = 0; step < span + 2; step++) lzma.push(lzma.out[lzma.size - recent[0] - 1]);
        }
    }
}

static class Cursor {
    final byte[] data;
    int at;

    Cursor(byte[] data, int at) {
        this.data = data;
        this.at = at;
    }

    BigInteger big() {
        var value = BigInteger.ZERO;
        for (int shift = 0; ; shift += 7) {
            byte octet = data[at++];
            value = value.or(BigInteger.valueOf(octet & 0x7F).shiftLeft(shift));
            if (octet >= 0) return value;
        }
    }

    int small() {
        return big().intValue();
    }
}

static int upper(List<BigInteger> values, BigInteger address) {
    int low = 0, high = values.size();
    while (low < high) {
        int middle = (low + high) / 2;
        if (values.get(middle).compareTo(address) <= 0) low = middle + 1;
        else high = middle;
    }
    return low;
}

record Heads(List<BigInteger> heads, int[] starts) {}

record Found(int row, boolean exact) {}

static class Section {
    final String encoding, read;
    final int count, block, group, fanout, width, offsets, start;
    final int[] tuning;
    final byte[] file;
    final List<BigInteger> keys = new ArrayList<>();
    final Map<Integer, byte[]> blocks = new HashMap<>();

    Section(byte[] file, int view, Map<?, ?> entry) {
        var buffer = ByteBuffer.wrap(file).order(ByteOrder.LITTLE_ENDIAN);
        this.file = file;
        encoding = (String) entry.get("encoding");
        read = (String) entry.get("read");
        count = ((Long) entry.get("count")).intValue();
        block = ((Long) entry.get("block")).intValue();
        group = ((Long) entry.get("group")).intValue();
        tuning = ((List<?>) entry.get("lzma")).stream().mapToInt(item -> ((Long) item).intValue()).toArray();
        fanout = block / group;
        int total = buffer.getInt(view);
        width = buffer.getInt(view + 4);
        offsets = view + 8;
        int at = offsets + 4 * (total + 1);
        for (int index = 0; index < total; index++, at += width)
            keys.add(new BigInteger(1, Arrays.copyOfRange(file, at, at + width)));
        start = at;
    }

    int offset(int index) {
        return ByteBuffer.wrap(file).order(ByteOrder.LITTLE_ENDIAN).getInt(offsets + 4 * index);
    }

    byte[] decoded(int index) {
        return blocks.computeIfAbsent(index,
            key -> Lzma.decompress(file, start + offset(key), start + offset(key + 1), tuning));
    }

    long number(byte[] raw, int place, int size) {
        long value = 0;
        for (int index = size - 1; index >= 0; index--) value = value << 8 | raw[1 + place * size + index] & 0xFF;
        if (encoding.equals("fixed")) return value;
        int shift = 64 - 8 * size;
        return value << shift >> shift;
    }

    long value(int row) {
        byte[] raw = decoded(row / block);
        int place = row % block, size = raw[0];
        if (!encoding.equals("delta")) return number(raw, place, size);
        long total = 0;
        for (int index = 0; index <= place; index++) total += number(raw, index, size);
        return total;
    }

    String text(long identifier) {
        if (identifier == 0) return "";
        int groupIndex = (int) (identifier - 1) / group, place = (int) (identifier - 1) % group;
        int index = groupIndex / fanout, at = groupIndex % fanout;
        var cursor = new Cursor(decoded(index), 0);
        int total = Math.min(fanout, (count - index * block + group - 1) / group) - 1, skipped = 0;
        for (int step = 0; step < total; step++) {
            int span = cursor.small();
            if (step < at) skipped += span;
        }
        cursor.at += skipped;
        byte[] previous = new byte[0];
        for (int step = 0; step <= place; step++) {
            int shared = cursor.data[cursor.at++] & 0xFF, fresh = cursor.small();
            previous = Arrays.copyOf(previous, shared + fresh);
            System.arraycopy(cursor.data, cursor.at, previous, shared, fresh);
            cursor.at += fresh;
        }
        return new String(previous, StandardCharsets.UTF_8);
    }

    Heads heads(int index) {
        var cursor = new Cursor(decoded(index), 0);
        int total = (cursor.small() + group - 1) / group;
        List<BigInteger> heads = new ArrayList<>(List.of(keys.get(index)));
        for (int step = 1; step < total; step++) heads.add(heads.getLast().add(cursor.big()));
        int[] starts = new int[total];
        for (int step = 1; step < total; step++) starts[step] = cursor.small();
        starts[0] = cursor.at;
        for (int step = 1; step < total; step++) starts[step] += starts[step - 1];
        return new Heads(heads, starts);
    }

    List<BigInteger> values(int groupIndex) {
        int index = groupIndex / fanout, at = groupIndex % fanout;
        int size = Math.min(group, count - groupIndex * group), hostBits = width == 4 ? 0 : 64;
        var heads = heads(index);
        var cursor = new Cursor(decoded(index), heads.starts()[at]);
        List<BigInteger> values = new ArrayList<>(List.of(heads.heads().get(at).shiftRight(hostBits)));
        for (int step = 1; step < size; step++) values.add(values.getLast().add(cursor.big()));
        if (hostBits > 0) values.replaceAll(network -> network.shiftLeft(64).or(cursor.big()));
        return values;
    }

    Found row(BigInteger address) {
        int index = upper(keys, address) - 1;
        if (index < 0) return null;
        int groupIndex = index * fanout + upper(heads(index).heads(), address) - 1;
        var values = values(groupIndex);
        int spot = upper(values, address) - 1;
        if (spot < 0) return null;
        return new Found(groupIndex * group + spot, values.get(spot).equals(address));
    }
}

static class Json {
    final String text;
    int at;

    Json(String text) {
        this.text = text;
    }

    char peek() {
        while (" \t\r\n,:".indexOf(text.charAt(at)) >= 0) at++;
        return text.charAt(at);
    }

    Object value() {
        char first = peek();
        if (first == '{') {
            Map<String, Object> map = new LinkedHashMap<>();
            for (at++; peek() != '}'; ) map.put((String) value(), value());
            at++;
            return map;
        }
        if (first == '[') {
            List<Object> list = new ArrayList<>();
            for (at++; peek() != ']'; ) list.add(value());
            at++;
            return list;
        }
        if (first == '"') return string();
        if (first == 't' || first == 'n') at += 4;
        if (first == 'f') at += 5;
        if (first == 't' || first == 'f') return first == 't';
        if (first == 'n') return null;
        int start = at;
        while (at < text.length() && "+-.0123456789eE".indexOf(text.charAt(at)) >= 0) at++;
        String raw = text.substring(start, at);
        return raw.matches("-?\\d+") ? (Object) Long.parseLong(raw) : Double.parseDouble(raw);
    }

    String string() {
        var out = new StringBuilder();
        for (at++; text.charAt(at) != '"'; at++) {
            char character = text.charAt(at);
            if (character != '\\') {
                out.append(character);
                continue;
            }
            char escaped = text.charAt(++at);
            if (escaped == 'u') {
                out.append((char) Integer.parseInt(text.substring(at + 1, at + 5), 16));
                at += 4;
            } else out.append(escaped == 'n' ? '\n' : escaped == 't' ? '\t' : escaped);
        }
        at++;
        return out.toString();
    }
}

static void quote(String text, StringBuilder out) {
    out.append('"');
    for (char character : text.toCharArray()) {
        if (character == '"' || character == '\\') out.append('\\').append(character);
        else if (character < ' ') out.append("\\u%04x".formatted((int) character));
        else out.append(character);
    }
    out.append('"');
}

static void write(Object value, int depth, StringBuilder out) {
    switch (value) {
        case null -> out.append("null");
        case String text -> quote(text, out);
        case Map<?, ?> map when map.isEmpty() -> out.append("{}");
        case Map<?, ?> map -> {
            String indent = "  ".repeat(depth + 1), separator = "{\n";
            for (var field : map.entrySet()) {
                out.append(separator).append(indent);
                quote((String) field.getKey(), out);
                out.append(": ");
                write(field.getValue(), depth + 1, out);
                separator = ",\n";
            }
            out.append('\n').append(indent, 2, indent.length()).append('}');
        }
        default -> out.append(value);
    }
}

final Map<String, Section> sections = new TreeMap<>();
final Map<String, List<String>> books = new HashMap<>();
final Map<String, List<String>> tables = new HashMap<>();

void open(String path) throws IOException {
    byte[] file = Files.readAllBytes(Path.of(path));
    byte[] magic = "PLEVIN\0\2".getBytes(StandardCharsets.ISO_8859_1);
    if (file.length < 12 || !Arrays.equals(file, 0, 8, magic, 0, 8))
        throw new IllegalArgumentException(path + " is not a plevin 2 database");
    int size = ByteBuffer.wrap(file).order(ByteOrder.LITTLE_ENDIAN).getInt(8);
    var head = (Map<?, ?>) new Json(new String(file, 12, size, StandardCharsets.UTF_8)).value();
    for (var entry : ((Map<?, ?>) head.get("sections")).entrySet()) {
        String name = (String) entry.getKey();
        var fields = (Map<?, ?>) entry.getValue();
        int view = 12 + size + ((Long) fields.get("offset")).intValue();
        sections.put(name, new Section(file, view, fields));
        String[] parts = name.split("\\.");
        if (parts.length == 3 && (parts[0].equals("col") || parts[0].equals("link")))
            tables.computeIfAbsent(parts[1], key -> new ArrayList<>()).add(name);
    }
    var vocabularies = (Map<?, ?>) head.get("vocabularies");
    BOOKS.forEach((field, book) -> {
        if (vocabularies.get(book) instanceof List<?> words)
            books.put(field, words.stream().map(String.class::cast).toList());
    });
}

Object read(String name, Section section, long value) {
    var book = books.get(name);
    if (name.equals("abuse.risk")) return value == 255 ? null : value / 100.0;
    if (name.equals("abuse.is_anycast") || name.equals("abuse.is_satellite")) return value != 0;
    if (book != null) return value < book.size() ? book.get((int) value) : "";
    if (section.read.equals("text")) return sections.get("strings").text(value);
    return section.read.isEmpty() ? (Object) value : value / 10000.0;
}

Map<String, Object> row(String table, int row) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (String name : tables.getOrDefault(table, List.of())) {
        var section = sections.get(name);
        String field = name.substring(name.lastIndexOf('.') + 1);
        long value = section.value(row);
        if (name.startsWith("col.")) out.put(field, read(table + "." + field, section, value));
        else if (value != 0) out.put(field, row(field, (int) value - 1));
    }
    if (out.get("postal_partial") instanceof Long partial && out.get("postal") instanceof String postal)
        out.put("postal_partial", postal.substring(0, (int) Math.min(partial, postal.length())));
    return out;
}

Map<String, Object> lookup(String text) throws IOException {
    byte[] raw = InetAddress.ofLiteral(text).getAddress();
    var address = new BigInteger(1, raw);
    String version = raw.length == 4 ? "v4" : "v6";
    var spine = sections.get("spine." + version);
    var found = spine == null ? null : spine.row(address);
    if (found == null) return null;
    var hosts = sections.get("hosts." + version);
    var records = sections.get("hosts." + version + ".abuse");
    long override = 0;
    if (hosts != null && records != null && hosts.row(address) instanceof Found(int at, boolean exact) && exact)
        override = records.value(at) + 1;
    return answer(version, found.row(), override);
}

Map<String, Object> answer(String version, int row, long override) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (String name : CARRIED) {
        var column = sections.get("spine." + version + "." + name);
        if (column == null) continue;
        long value = override != 0 && name.equals("abuse") ? override : column.value(row);
        if (List.of("place", "network", "abuse").contains(name)) {
            if (value != 0) out.put(name, row(name, (int) value - 1));
            continue;
        }
        @SuppressWarnings("unchecked")
        var network = (Map<String, Object>) out.computeIfAbsent("network", key -> new LinkedHashMap<>());
        network.put(name, read(name, column, value));
    }
    return out;
}

void main(String[] arguments) throws IOException {
    if (arguments.length != 2) {
        System.err.println("usage: java Plevin.java path address");
        System.exit(1);
    }
    open(arguments[0]);
    var out = new StringBuilder();
    write(lookup(arguments[1]), 0, out);
    IO.println(out);
}
