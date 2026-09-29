#include <arpa/inet.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <format>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <string>
#include <vector>

using u128 = unsigned __int128;
using Bytes = std::vector<uint8_t>;

enum {
    IS_REPEAT = 192,
    IS_FIRST = IS_REPEAT + 12,
    IS_SECOND = IS_FIRST + 12,
    IS_THIRD = IS_SECOND + 12,
    IS_LONG = IS_THIRD + 12,
    SLOTS = IS_LONG + 192,
    SPECIAL = SLOTS + 256,
    ALIGN = SPECIAL + 114,
    LENGTHS = ALIGN + 16,
    REPEATS = LENGTHS + 514,
    LITERALS = REPEATS + 514,
};

const std::map<std::string, std::string> BOOKS = {
    {"rpki", "rpki"},
    {"place.granularity", "granularity"},
    {"city.timezone", "timezones"},
    {"city.type", "place_types"},
    {"operator.category", "categories"},
    {"abuse.user_type", "categories"},
    {"abuse.service", "services"},
    {"abuse.evidence", "evidence"},
};

class Lzma {
    const uint8_t *data;
    size_t at = 5;
    uint32_t range = UINT32_MAX, code = 0;
    std::vector<uint16_t> probs;

    void normalize() {
        if (range >= 1u << 24) return;
        range <<= 8;
        code = code << 8 | data[at++];
    }

    int bit(int index) {
        uint32_t chance = probs[index], bound = (range >> 11) * chance;
        bool result = code >= bound;
        if (result) {
            range -= bound;
            code -= bound;
            probs[index] -= chance >> 5;
        } else {
            range = bound;
            probs[index] += (2048 - chance) >> 5;
        }
        normalize();
        return result;
    }

    uint32_t direct(int count) {
        uint32_t value = 0;
        for (int step = 0; step < count; step++) {
            range >>= 1;
            uint32_t result = code >= range;
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

    uint32_t reversed(int base, int count) {
        uint32_t symbol = 1, value = 0;
        for (int step = 0; step < count; step++) {
            uint32_t result = bit(base + symbol);
            symbol = symbol << 1 | result;
            value |= result << step;
        }
        return value;
    }

    int length(int base, int spot) {
        if (!bit(base)) return tree(base + 2 + (spot << 3), 3);
        if (!bit(base + 1)) return 8 + tree(base + 130 + (spot << 3), 3);
        return 16 + tree(base + 258, 8);
    }

    uint32_t distance(int span) {
        int slot = tree(SLOTS + (std::min(span, 3) << 6), 6);
        if (slot < 4) return slot;
        int count = (slot >> 1) - 1;
        uint32_t base = uint32_t(2 | (slot & 1)) << count;
        if (slot < 14) return base + reversed(SPECIAL + base - slot - 1, count);
        return base + (direct(count - 4) << 4) + reversed(ALIGN, 4);
    }

    void literal(Bytes &out, int state, uint32_t recent, int context, int position) {
        int previous = out.empty() ? 0 : out.back();
        int spot = int(out.size() & ((1u << position) - 1)) << context;
        int base = LITERALS + 0x300 * (spot + (previous >> (8 - context)));
        int symbol = 1;
        if (state >= 7) {
            int matched = out[out.size() - recent - 1];
            while (symbol < 0x100) {
                int expected = matched >> 7 & 1;
                matched <<= 1;
                int result = bit(base + ((1 + expected) << 8) + symbol);
                symbol = symbol << 1 | result;
                if (result != expected) break;
            }
        }
        while (symbol < 0x100) symbol = symbol << 1 | bit(base + symbol);
        out.push_back(symbol);
    }

  public:
    Bytes decompress(const uint8_t *packed, const int *tuning) {
        auto [context, position, matches] = std::tuple(tuning[0], tuning[1], tuning[2]);
        data = packed;
        probs.assign(LITERALS + (0x300 << (context + position)), 1024);
        for (int index = 1; index < 5; index++) code = code << 8 | data[index];
        Bytes out;
        uint32_t recent[4] = {};
        int state = 0;
        for (;;) {
            int spot = out.size() & ((1 << matches) - 1), span;
            if (!bit(state << 4 | spot)) {
                literal(out, state, recent[0], context, position);
                state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
                continue;
            }
            if (bit(IS_REPEAT + state)) {
                if (bit(IS_FIRST + state)) {
                    int picked = bit(IS_SECOND + state) ? 2 + bit(IS_THIRD + state) : 1;
                    std::rotate(recent, recent + picked, recent + picked + 1);
                } else if (!bit(IS_LONG + (state << 4 | spot))) {
                    state = state < 7 ? 9 : 11;
                    out.push_back(out[out.size() - recent[0] - 1]);
                    continue;
                }
                span = length(REPEATS, spot);
                state = state < 7 ? 8 : 11;
            } else {
                std::rotate(recent, recent + 3, recent + 4);
                span = length(LENGTHS, spot);
                state = state < 7 ? 7 : 10;
                recent[0] = distance(span);
                if (recent[0] == UINT32_MAX) return out;
            }
            for (int step = 0; step < span + 2; step++)
                out.push_back(out[out.size() - recent[0] - 1]);
        }
    }
};

u128 varint(const Bytes &data, size_t &at) {
    u128 value = 0;
    for (int shift = 0;; shift += 7) {
        uint8_t byte = data[at++];
        value |= u128(byte & 0x7F) << shift;
        if (!(byte & 0x80)) return value;
    }
}

uint32_t u32(const uint8_t *at) { return at[0] | at[1] << 8 | at[2] << 16 | uint32_t(at[3]) << 24; }

int upper(const std::vector<u128> &values, u128 address) {
    return std::upper_bound(values.begin(), values.end(), address) - values.begin();
}

struct Section {
    std::string encoding, read;
    int count = 0, block = 0, group = 0, offset = 0, tuning[3] = {}, fanout = 0;
    const uint8_t *view = nullptr, *data = nullptr;
    std::vector<u128> keys;
    std::map<int, Bytes> blocks;

    void open(const uint8_t *body) {
        view = body + offset;
        int total = u32(view), width = u32(view + 4);
        const uint8_t *raw = view + 8 + 4 * (total + 1);
        keys.assign(total, 0);
        for (int index = 0; index < total * width; index++)
            keys[index / width] = keys[index / width] << 8 | raw[index];
        data = raw + total * width;
        fanout = block / group;
    }

    int width() const { return u32(view + 4); }

    const Bytes &decoded(int index) {
        if (!blocks.contains(index))
            blocks[index] = Lzma().decompress(data + u32(view + 8 + 4 * index), tuning);
        return blocks[index];
    }

    int64_t number(const Bytes &raw, int place, int size) const {
        uint64_t value = 0;
        for (int index = size - 1; index >= 0; index--) value = value << 8 | raw[1 + place * size + index];
        if (encoding == "fixed") return value;
        int shift = 64 - 8 * size;
        return int64_t(value << shift) >> shift;
    }

    int64_t value(int row) {
        const Bytes &raw = decoded(row / block);
        int place = row % block, size = raw[0];
        if (encoding != "delta") return number(raw, place, size);
        int64_t total = 0;
        for (int index = 0; index <= place; index++) total += number(raw, index, size);
        return total;
    }

    std::string text(int64_t identifier) {
        if (!identifier) return "";
        int group_index = (identifier - 1) / group, place = (identifier - 1) % group;
        int index = group_index / fanout, at = group_index % fanout;
        const Bytes &raw = decoded(index);
        int total = std::min(fanout, (count - index * block + group - 1) / group) - 1;
        size_t cursor = 0, start = 0;
        for (int step = 0; step < total; step++) {
            size_t span = varint(raw, cursor);
            if (step < at) start += span;
        }
        cursor += start;
        std::string previous;
        for (int step = 0; step <= place; step++) {
            previous.resize(raw[cursor++]);
            size_t fresh = varint(raw, cursor);
            previous.append(raw.begin() + cursor, raw.begin() + cursor + fresh);
            cursor += fresh;
        }
        return previous;
    }

    std::pair<std::vector<u128>, std::vector<size_t>> heads(int index) {
        const Bytes &raw = decoded(index);
        size_t cursor = 0;
        int total = (int(varint(raw, cursor)) + group - 1) / group;
        std::vector<u128> heads = {keys[index]};
        for (int step = 1; step < total; step++) heads.push_back(heads.back() + varint(raw, cursor));
        std::vector<size_t> spans;
        for (int step = 1; step < total; step++) spans.push_back(varint(raw, cursor));
        std::vector<size_t> starts = {cursor};
        for (size_t span : spans) starts.push_back(starts.back() + span);
        return {heads, starts};
    }

    std::vector<u128> values(int group_index) {
        int index = group_index / fanout, at = group_index % fanout;
        int size = std::min(group, count - group_index * group);
        auto [head, starts] = heads(index);
        const Bytes &raw = decoded(index);
        int host_bits = width() == 4 ? 0 : 64;
        size_t cursor = starts[at];
        std::vector<u128> values = {head[at] >> host_bits};
        for (int step = 1; step < size; step++) values.push_back(values.back() + varint(raw, cursor));
        for (auto &value : values)
            if (host_bits) value = value << 64 | varint(raw, cursor);
        return values;
    }

    int row(u128 address, bool &exact) {
        int index = upper(keys, address) - 1;
        if (index < 0) return -1;
        int group_index = index * fanout + upper(heads(index).first, address) - 1;
        auto found = values(group_index);
        int spot = upper(found, address) - 1;
        if (spot < 0) return -1;
        exact = found[spot] == address;
        return group_index * group + spot;
    }
};

class Header {
    const char *cursor;

  public:
    explicit Header(const char *text) : cursor(text) {}

    void seek(const char *text, const char *key) { cursor = std::strstr(text, key) + strlen(key); }

    char peek() {
        while (*cursor && std::strchr(" \t\r\n,:", *cursor)) cursor++;
        return *cursor;
    }

    bool more(char closing) {
        if (peek() != closing) return true;
        cursor++;
        return false;
    }

    void enter() {
        peek();
        cursor++;
    }

    std::string word() {
        std::string out;
        peek();
        for (cursor++; *cursor != '"'; cursor++) out += *cursor == '\\' ? *++cursor : *cursor;
        cursor++;
        return out;
    }

    int number() {
        char *end;
        peek();
        int value = std::strtol(cursor, &end, 10);
        cursor = end;
        return value;
    }
};

class Plevin {
    std::string file;
    std::map<std::string, Section> sections;
    std::map<std::string, std::vector<std::string>> books;
    std::string out;

    Section *find(const std::string &name) {
        auto found = sections.find(name);
        return found == sections.end() ? nullptr : &found->second;
    }

    void quote(const std::string &raw) {
        out += '"';
        for (char character : raw) {
            if (character == '"' || character == '\\') out += '\\';
            if (uint8_t(character) < ' ') out += std::format("\\u{:04x}", character);
            else out += character;
        }
        out += '"';
    }

    void field(int depth, bool &first, const std::string &name) {
        out += (first ? "\n" : ",\n") + std::string(2 * depth, ' ');
        quote(name);
        out += ": ";
        first = false;
    }

    void close(int depth, bool first) {
        if (!first) out += "\n" + std::string(2 * depth, ' ');
        out += '}';
    }

    void print(const std::string &name, Section &section, int64_t value) {
        auto book = BOOKS.contains(name) ? books.find(BOOKS.at(name)) : books.end();
        if (name == "abuse.risk") {
            out += value == 255 ? "null" : std::format("{}", value / 100.0);
        } else if (name == "abuse.is_anycast" || name == "abuse.is_satellite") {
            out += value ? "true" : "false";
        } else if (book != books.end()) {
            quote(size_t(value) < book->second.size() ? book->second[value] : "");
        } else if (section.read == "text") {
            quote(sections["strings"].text(value));
        } else {
            out += section.read.empty() ? std::to_string(value) : std::format("{}", value / 1e4);
        }
    }

    void fields(const std::string &table, int row, int depth, bool &first) {
        for (auto &[name, section] : sections) {
            auto dot = name.find('.'), last = name.rfind('.');
            if (name.substr(dot + 1, last - dot - 1) != table) continue;
            bool linked = name.starts_with("link.");
            if (!linked && !name.starts_with("col.")) continue;
            std::string label = name.substr(last + 1);
            int64_t found = section.value(row);
            if (linked && !found) continue;
            field(depth, first, label);
            if (linked) {
                record(label, found - 1, depth);
            } else if (label == "postal_partial") {
                std::string postal = sections["strings"].text(find("col." + table + ".postal")->value(row));
                quote(postal.substr(0, found));
            } else {
                print(table + "." + label, section, found);
            }
        }
    }

    void record(const std::string &table, int row, int depth) {
        bool first = true;
        out += '{';
        fields(table, row, depth + 1, first);
        close(depth, first);
    }

    std::string answer(const std::string &version, int row, int64_t override) {
        bool first = true, inner = true;
        out = "{";
        for (std::string name : {"place", "abuse"}) {
            Section *section = find("spine." + version + "." + name);
            int64_t found = section ? section->value(row) : 0;
            if (override && name == "abuse") found = override;
            if (!found) continue;
            field(1, first, name);
            record(name, found - 1, 1);
        }
        Section *network = find("spine." + version + ".network");
        int64_t found = network ? network->value(row) : 0;
        std::vector<std::pair<std::string, Section *>> extras;
        for (std::string name : {"prefix", "rpki", "roas"})
            if (Section *section = find("spine." + version + "." + name)) extras.push_back({name, section});
        if (found || !extras.empty()) {
            field(1, first, "network");
            out += '{';
            if (found) fields("network", found - 1, 2, inner);
            for (auto &[name, section] : extras) {
                field(2, inner, name);
                print(name, *section, section->value(row));
            }
            close(1, inner);
        }
        close(0, first);
        return out;
    }

  public:
    explicit Plevin(const std::string &path) {
        std::ifstream stream(path, std::ios::binary);
        file.assign(std::istreambuf_iterator<char>(stream), {});
        if (file.size() < 12 || file.compare(0, 8, std::string("PLEVIN\0\2", 8)))
            throw std::runtime_error(path + " is not a plevin 2 database");
        auto data = reinterpret_cast<const uint8_t *>(file.data());
        uint32_t size = u32(data + 8);
        std::string head = file.substr(12, size);
        Header header(head.c_str());
        header.seek(head.c_str(), "\"sections\"");
        header.enter();
        while (header.more('}')) {
            Section &section = sections[header.word()];
            header.enter();
            while (header.more('}')) {
                std::string key = header.word();
                if (key == "lzma") {
                    header.enter();
                    for (int index = 0; header.more(']'); index++) section.tuning[index] = header.number();
                } else if (key == "encoding" || key == "read") {
                    (key == "read" ? section.read : section.encoding) = header.word();
                } else {
                    std::map<std::string, int *> numbers = {{"offset", &section.offset},
                        {"count", &section.count}, {"block", &section.block}, {"group", &section.group}};
                    int value = header.number();
                    if (numbers.contains(key)) *numbers[key] = value;
                }
            }
            section.open(data + 12 + size);
        }
        header.seek(head.c_str(), "\"vocabularies\"");
        header.enter();
        while (header.more('}')) {
            auto &words = books[header.word()];
            header.enter();
            while (header.more(']')) words.push_back(header.word());
        }
    }

    std::string lookup(const std::string &text) {
        uint8_t raw[16];
        bool six = text.contains(':'), exact = false;
        if (inet_pton(six ? AF_INET6 : AF_INET, text.c_str(), raw) != 1)
            throw std::runtime_error(text + " is not an address");
        u128 address = 0;
        for (int index = 0; index < (six ? 16 : 4); index++) address = address << 8 | raw[index];
        std::string version = six ? "v6" : "v4";
        Section *spine = find("spine." + version);
        int row = spine ? spine->row(address, exact) : -1;
        if (row < 0) return "null";
        Section *hosts = find("hosts." + version), *records = find("hosts." + version + ".abuse");
        int64_t override = 0;
        if (hosts && records) {
            int at = hosts->row(address, exact);
            if (at >= 0 && exact) override = records->value(at) + 1;
        }
        return answer(version, row, override);
    }
};

int main(int count, char **arguments) {
    if (count != 3) {
        std::cerr << "usage: plevin path address\n";
        return 1;
    }
    try {
        std::cout << Plevin(arguments[1]).lookup(arguments[2]) << "\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
