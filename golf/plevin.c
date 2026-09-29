#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef unsigned __int128 u128;

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
    MOST = 1024,
};

static const char *BOOKS[][2] = {
    {"rpki", "rpki"},
    {"place.granularity", "granularity"},
    {"city.timezone", "timezones"},
    {"city.type", "place_types"},
    {"operator.category", "categories"},
    {"abuse.user_type", "categories"},
    {"abuse.service", "services"},
    {"abuse.evidence", "evidence"},
};

typedef struct {
    const uint8_t *data;
    size_t at, size, capacity;
    uint32_t range, code;
    uint16_t *probs;
    uint8_t *out;
} Lzma;

typedef struct {
    uint8_t *bytes;
    size_t size;
} Block;

typedef struct {
    char *name, *encoding, *read;
    int count, block, group, tuning[3], width, blocks;
    const uint8_t *view, *data;
    u128 *keys;
    Block *decoded;
} Section;

typedef struct {
    char *name, **words;
    int count;
} Book;

static Section sections[MOST];
static Book books[MOST];
static int section_count, book_count;
static const char *cursor;

static void normalize(Lzma *lzma) {
    if (lzma->range >= 1u << 24) return;
    lzma->range <<= 8;
    lzma->code = lzma->code << 8 | lzma->data[lzma->at++];
}

static int bit(Lzma *lzma, int index) {
    uint32_t chance = lzma->probs[index], bound = (lzma->range >> 11) * chance;
    int result = lzma->code >= bound;
    if (result) {
        lzma->range -= bound;
        lzma->code -= bound;
        lzma->probs[index] -= chance >> 5;
    } else {
        lzma->range = bound;
        lzma->probs[index] += (2048 - chance) >> 5;
    }
    normalize(lzma);
    return result;
}

static uint32_t direct(Lzma *lzma, int count) {
    uint32_t value = 0;
    for (int step = 0; step < count; step++) {
        lzma->range >>= 1;
        uint32_t result = lzma->code >= lzma->range;
        lzma->code -= lzma->range * result;
        value = value << 1 | result;
        normalize(lzma);
    }
    return value;
}

static int tree(Lzma *lzma, int base, int count) {
    int symbol = 1;
    for (int step = 0; step < count; step++) symbol = symbol << 1 | bit(lzma, base + symbol);
    return symbol - (1 << count);
}

static uint32_t reversed(Lzma *lzma, int base, int count) {
    uint32_t symbol = 1, value = 0;
    for (int step = 0; step < count; step++) {
        uint32_t result = bit(lzma, base + symbol);
        symbol = symbol << 1 | result;
        value |= result << step;
    }
    return value;
}

static int length(Lzma *lzma, int base, int spot) {
    if (!bit(lzma, base)) return tree(lzma, base + 2 + (spot << 3), 3);
    if (!bit(lzma, base + 1)) return 8 + tree(lzma, base + 130 + (spot << 3), 3);
    return 16 + tree(lzma, base + 258, 8);
}

static uint32_t distance(Lzma *lzma, int span) {
    int slot = tree(lzma, SLOTS + ((span < 3 ? span : 3) << 6), 6);
    if (slot < 4) return slot;
    int count = (slot >> 1) - 1;
    uint32_t base = (uint32_t)(2 | (slot & 1)) << count;
    if (slot < 14) return base + reversed(lzma, SPECIAL + base - slot - 1, count);
    return base + (direct(lzma, count - 4) << 4) + reversed(lzma, ALIGN, 4);
}

static void push(Lzma *lzma, uint8_t byte) {
    if (lzma->size == lzma->capacity) {
        lzma->capacity = lzma->capacity * 2 + 4096;
        lzma->out = realloc(lzma->out, lzma->capacity);
    }
    lzma->out[lzma->size++] = byte;
}

static void literal(Lzma *lzma, int state, uint32_t recent, int context, int position) {
    size_t size = lzma->size;
    int previous = size ? lzma->out[size - 1] : 0;
    int spot = (int)(size & ((1u << position) - 1)) << context;
    int base = LITERALS + 0x300 * (spot + (previous >> (8 - context)));
    int symbol = 1;
    if (state >= 7) {
        int matched = lzma->out[size - recent - 1];
        while (symbol < 0x100) {
            int expected = matched >> 7 & 1;
            matched <<= 1;
            int result = bit(lzma, base + ((1 + expected) << 8) + symbol);
            symbol = symbol << 1 | result;
            if (result != expected) break;
        }
    }
    while (symbol < 0x100) symbol = symbol << 1 | bit(lzma, base + symbol);
    push(lzma, symbol);
}

static uint8_t *decompress(const uint8_t *data, const int *tuning, size_t *size) {
    int context = tuning[0], position = tuning[1], matches = tuning[2];
    int count = LITERALS + (0x300 << (context + position)), state = 0;
    Lzma lzma = {.data = data, .at = 5, .range = UINT32_MAX, .probs = malloc(count * 2)};
    for (int index = 0; index < count; index++) lzma.probs[index] = 1024;
    for (int index = 1; index < 5; index++) lzma.code = lzma.code << 8 | data[index];
    uint32_t recent[4] = {0};
    for (;;) {
        int spot = lzma.size & ((1 << matches) - 1), span;
        if (!bit(&lzma, state << 4 | spot)) {
            literal(&lzma, state, recent[0], context, position);
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
            continue;
        }
        if (bit(&lzma, IS_REPEAT + state)) {
            if (bit(&lzma, IS_FIRST + state)) {
                int picked = bit(&lzma, IS_SECOND + state) ? 2 + bit(&lzma, IS_THIRD + state) : 1;
                uint32_t held = recent[picked];
                memmove(recent + 1, recent, picked * sizeof *recent);
                recent[0] = held;
            } else if (!bit(&lzma, IS_LONG + (state << 4 | spot))) {
                state = state < 7 ? 9 : 11;
                push(&lzma, lzma.out[lzma.size - recent[0] - 1]);
                continue;
            }
            span = length(&lzma, REPEATS, spot);
            state = state < 7 ? 8 : 11;
        } else {
            memmove(recent + 1, recent, 3 * sizeof *recent);
            span = length(&lzma, LENGTHS, spot);
            state = state < 7 ? 7 : 10;
            recent[0] = distance(&lzma, span);
            if (recent[0] == UINT32_MAX) break;
        }
        for (int step = 0; step < span + 2; step++) push(&lzma, lzma.out[lzma.size - recent[0] - 1]);
    }
    free(lzma.probs);
    *size = lzma.size;
    return lzma.out;
}

static void skip(void) {
    while (*cursor && strchr(" \t\r\n,:", *cursor)) cursor++;
}

static char *word(void) {
    char buffer[MOST];
    size_t size = 0;
    skip();
    for (cursor++; *cursor != '"'; cursor++) {
        if (*cursor == '\\') cursor++;
        if (size < MOST - 1) buffer[size++] = *cursor;
    }
    cursor++;
    buffer[size] = 0;
    return strdup(buffer);
}

static int number(void) {
    char *end;
    skip();
    int value = strtol(cursor, &end, 10);
    cursor = end;
    return value;
}

static int enter(char opening) {
    skip();
    if (*cursor != opening) return 0;
    cursor++;
    return 1;
}

static int more(char closing) {
    skip();
    if (*cursor != closing) return 1;
    cursor++;
    return 0;
}

static uint32_t u32(const uint8_t *at) {
    return at[0] | at[1] << 8 | at[2] << 16 | (uint32_t)at[3] << 24;
}

static void section(const uint8_t *body) {
    Section *s = &sections[section_count++];
    int offset = 0;
    s->name = word();
    enter('{');
    while (more('}')) {
        char *key = word();
        if (!strcmp(key, "lzma") && enter('['))
            for (int index = 0; more(']'); index++) s->tuning[index] = number();
        else if (!strcmp(key, "encoding")) s->encoding = word();
        else if (!strcmp(key, "read")) s->read = word();
        else {
            int value = number();
            if (!strcmp(key, "offset")) offset = value;
            if (!strcmp(key, "count")) s->count = value;
            if (!strcmp(key, "block")) s->block = value;
            if (!strcmp(key, "group")) s->group = value;
        }
        free(key);
    }
    s->view = body + offset;
    s->blocks = u32(s->view);
    s->width = u32(s->view + 4);
    const uint8_t *keys = s->view + 8 + 4 * (s->blocks + 1);
    s->keys = calloc(s->blocks + 1, sizeof *s->keys);
    for (int index = 0; index < s->blocks * s->width; index++)
        s->keys[index / s->width] = s->keys[index / s->width] << 8 | keys[index];
    s->data = keys + s->blocks * s->width;
    s->decoded = calloc(s->blocks + 1, sizeof *s->decoded);
}

static void parse(const char *head, const uint8_t *body) {
    cursor = strstr(head, "\"sections\"") + 10;
    enter('{');
    while (more('}')) section(body);
    cursor = strstr(head, "\"vocabularies\"") + 14;
    enter('{');
    while (more('}')) {
        Book *book = &books[book_count++];
        book->name = word();
        book->words = malloc(MOST * sizeof *book->words);
        enter('[');
        while (more(']') && book->count < MOST) book->words[book->count++] = word();
    }
}

static Section *find(const char *name) {
    for (int index = 0; index < section_count; index++)
        if (!strcmp(sections[index].name, name)) return &sections[index];
    return NULL;
}

static Book *book_for(const char *name) {
    for (size_t pair = 0; pair < sizeof BOOKS / sizeof *BOOKS; pair++) {
        if (strcmp(BOOKS[pair][0], name)) continue;
        for (int index = 0; index < book_count; index++)
            if (!strcmp(books[index].name, BOOKS[pair][1])) return &books[index];
    }
    return NULL;
}

static const uint8_t *decoded(Section *s, int index) {
    Block *block = &s->decoded[index];
    const uint8_t *offsets = s->view + 8 + 4 * index;
    if (!block->bytes) block->bytes = decompress(s->data + u32(offsets), s->tuning, &block->size);
    return block->bytes;
}

static u128 varint(const uint8_t *data, size_t *at) {
    u128 value = 0;
    for (int shift = 0;; shift += 7) {
        uint8_t byte = data[(*at)++];
        value |= (u128)(byte & 0x7F) << shift;
        if (!(byte & 0x80)) return value;
    }
}

static int64_t read_number(Section *s, const uint8_t *block, int place, int width) {
    uint64_t value = 0;
    for (int index = width - 1; index >= 0; index--) value = value << 8 | block[1 + place * width + index];
    if (!strcmp(s->encoding, "fixed")) return value;
    int shift = 64 - 8 * width;
    return (int64_t)(value << shift) >> shift;
}

static int64_t value(Section *s, int row) {
    const uint8_t *block = decoded(s, row / s->block);
    int place = row % s->block, width = block[0];
    if (strcmp(s->encoding, "delta")) return read_number(s, block, place, width);
    int64_t total = 0;
    for (int index = 0; index <= place; index++) total += read_number(s, block, index, width);
    return total;
}

static char *text(int64_t identifier) {
    static char previous[1 << 16];
    previous[0] = 0;
    if (!identifier) return previous;
    Section *s = find("strings");
    int group = (identifier - 1) / s->group, place = (identifier - 1) % s->group;
    int fanout = s->block / s->group, index = group / fanout, at = group % fanout;
    const uint8_t *block = decoded(s, index);
    int left = (s->count - index * s->block + s->group - 1) / s->group;
    int total = (fanout < left ? fanout : left) - 1;
    size_t cursor = 0, start = 0, size = 0;
    for (int step = 0; step < total; step++) {
        size_t span = varint(block, &cursor);
        if (step < at) start += span;
    }
    cursor += start;
    for (int step = 0; step <= place; step++) {
        size = block[cursor++];
        size_t fresh = varint(block, &cursor);
        memcpy(previous + size, block + cursor, fresh);
        size += fresh;
        cursor += fresh;
    }
    previous[size] = 0;
    return previous;
}

static int heads(Section *s, int index, u128 *heads, size_t *starts) {
    const uint8_t *block = decoded(s, index);
    size_t cursor = 0;
    int count = varint(block, &cursor), total = (count + s->group - 1) / s->group;
    heads[0] = s->keys[index];
    for (int step = 1; step < total; step++) heads[step] = heads[step - 1] + varint(block, &cursor);
    size_t spans[MOST];
    for (int step = 1; step < total; step++) spans[step] = varint(block, &cursor);
    starts[0] = cursor;
    for (int step = 1; step < total; step++) starts[step] = starts[step - 1] + spans[step];
    return total;
}

static int values(Section *s, int group, u128 *values) {
    u128 head[MOST];
    size_t starts[MOST];
    int fanout = s->block / s->group, index = group / fanout, at = group % fanout;
    int size = s->count - group * s->group < s->group ? s->count - group * s->group : s->group;
    heads(s, index, head, starts);
    const uint8_t *block = decoded(s, index);
    int host_bits = s->width == 4 ? 0 : 64;
    size_t cursor = starts[at];
    values[0] = head[at] >> host_bits;
    for (int step = 1; step < size; step++) values[step] = values[step - 1] + varint(block, &cursor);
    for (int step = 0; host_bits && step < size; step++)
        values[step] = values[step] << 64 | varint(block, &cursor);
    return size;
}

static int upper(const u128 *values, int count, u128 address) {
    int low = 0;
    while (low < count) {
        int middle = (low + count) / 2;
        if (values[middle] <= address) low = middle + 1;
        else count = middle;
    }
    return low;
}

static int find_row(Section *s, u128 address, int *exact) {
    u128 head[MOST], found[MOST];
    size_t starts[MOST];
    int index = upper(s->keys, s->blocks, address) - 1;
    if (index < 0) return -1;
    int total = heads(s, index, head, starts);
    int group = index * (s->block / s->group) + upper(head, total, address) - 1;
    int spot = upper(found, values(s, group, found), address) - 1;
    if (spot < 0) return -1;
    *exact = found[spot] == address;
    return group * s->group + spot;
}

static void quote(const char *raw) {
    putchar('"');
    for (; *raw; raw++) {
        if (*raw == '"' || *raw == '\\') printf("\\%c", *raw);
        else if ((unsigned char)*raw < ' ') printf("\\u%04x", *raw);
        else putchar(*raw);
    }
    putchar('"');
}

static void field(int depth, int *first, const char *name) {
    printf("%s\n%*s", *first ? "" : ",", 2 * depth, "");
    quote(name);
    printf(": ");
    *first = 0;
}

static void close_object(int depth, int first) {
    if (!first) printf("\n%*s", 2 * depth, "");
    putchar('}');
}

static void print_value(const char *name, Section *s, int64_t value) {
    Book *book = book_for(name);
    if (!strcmp(name, "abuse.risk") && value == 255) printf("null");
    else if (!strcmp(name, "abuse.risk")) printf("%.2f", value / 100.0);
    else if (!strcmp(name, "abuse.is_anycast") || !strcmp(name, "abuse.is_satellite"))
        printf(value ? "true" : "false");
    else if (book) quote(value < book->count ? book->words[value] : "");
    else if (!strcmp(s->read, "text")) quote(text(value));
    else if (*s->read) printf("%.4f", value / 10000.0);
    else printf("%lld", (long long)value);
}

static void print_row(const char *table, int row, int depth);

static void print_fields(const char *table, int row, int depth, int *first) {
    char column[MOST], link[MOST], name[MOST];
    snprintf(column, MOST, "col.%s.", table);
    snprintf(link, MOST, "link.%s.", table);
    for (Section *s = sections; s < sections + section_count; s++) {
        int linked = !strncmp(s->name, link, strlen(link));
        if (!linked && strncmp(s->name, column, strlen(column))) continue;
        const char *label = s->name + strlen(linked ? link : column);
        if (strchr(label, '.')) continue;
        int64_t found = value(s, row);
        if (linked && !found) continue;
        field(depth, first, label);
        snprintf(name, MOST, "%s.%s", table, label);
        if (linked) print_row(label, found - 1, depth);
        else if (strcmp(label, "postal_partial")) print_value(name, s, found);
        else {
            snprintf(name, MOST, "col.%s.postal", table);
            char *postal = text(value(find(name), row));
            if (found < (int64_t)strlen(postal)) postal[found] = 0;
            quote(postal);
        }
    }
}

static void print_row(const char *table, int row, int depth) {
    int first = 1;
    putchar('{');
    print_fields(table, row, depth + 1, &first);
    close_object(depth, first);
}

static void answer(const char *version, int row, int64_t override) {
    const char *linked[] = {"place", "abuse"}, *extras[] = {"prefix", "rpki", "roas"};
    char name[MOST];
    int first = 1, inner = 1;
    putchar('{');
    for (int index = 0; index < 2; index++) {
        snprintf(name, MOST, "spine.%s.%s", version, linked[index]);
        Section *s = find(name);
        int64_t found = s ? value(s, row) : 0;
        if (override && index == 1) found = override;
        if (!found) continue;
        field(1, &first, linked[index]);
        print_row(linked[index], found - 1, 1);
    }
    snprintf(name, MOST, "spine.%s.network", version);
    Section *network = find(name), *extra[3];
    int64_t found = network ? value(network, row) : 0;
    int any = found != 0;
    for (int index = 0; index < 3; index++) {
        snprintf(name, MOST, "spine.%s.%s", version, extras[index]);
        any |= (extra[index] = find(name)) != NULL;
    }
    if (any) {
        field(1, &first, "network");
        putchar('{');
        if (found) print_fields("network", found - 1, 2, &inner);
        for (int index = 0; index < 3; index++) {
            if (!extra[index]) continue;
            field(2, &inner, extras[index]);
            print_value(extras[index], extra[index], value(extra[index], row));
        }
        close_object(1, inner);
    }
    close_object(0, first);
    putchar('\n');
}

int main(int count, char **arguments) {
    if (count != 3) return fprintf(stderr, "usage: plevin path address\n"), 1;
    FILE *file = fopen(arguments[1], "rb");
    if (!file) return perror(arguments[1]), 1;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    uint8_t *data = malloc(size + 1);
    rewind(file);
    fread(data, 1, size, file);
    fclose(file);
    if (size < 12 || memcmp(data, "PLEVIN\0\2", 8))
        return fprintf(stderr, "%s is not a plevin 2 database\n", arguments[1]), 1;
    uint32_t head_size = u32(data + 8);
    char *head = strndup((char *)data + 12, head_size);
    parse(head, data + 12 + head_size);

    uint8_t raw[16];
    int six = strchr(arguments[2], ':') != NULL, exact = 0;
    if (inet_pton(six ? AF_INET6 : AF_INET, arguments[2], raw) != 1)
        return fprintf(stderr, "%s is not an address\n", arguments[2]), 1;
    u128 address = 0;
    for (int index = 0; index < (six ? 16 : 4); index++) address = address << 8 | raw[index];
    const char *version = six ? "v6" : "v4";
    char name[MOST];
    snprintf(name, MOST, "spine.%s", version);
    Section *spine = find(name);
    int row = spine ? find_row(spine, address, &exact) : -1;
    if (row < 0) return puts("null"), 0;
    snprintf(name, MOST, "hosts.%s", version);
    Section *hosts = find(name);
    snprintf(name, MOST, "hosts.%s.abuse", version);
    Section *records = find(name);
    int64_t override = 0;
    if (hosts && records) {
        int at = find_row(hosts, address, &exact);
        if (at >= 0 && exact) override = value(records, at) + 1;
    }
    answer(version, row, override);
    return 0;
}
