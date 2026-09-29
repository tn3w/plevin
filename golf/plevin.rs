use std::cell::RefCell;
use std::collections::HashMap;
use std::net::IpAddr;
use std::rc::Rc;

const IS_REPEAT: usize = 192;
const IS_FIRST: usize = IS_REPEAT + 12;
const IS_SECOND: usize = IS_FIRST + 12;
const IS_THIRD: usize = IS_SECOND + 12;
const IS_LONG: usize = IS_THIRD + 12;
const SLOTS: usize = IS_LONG + 192;
const SPECIAL: usize = SLOTS + 256;
const ALIGN: usize = SPECIAL + 114;
const LENGTHS: usize = ALIGN + 16;
const REPEATS: usize = LENGTHS + 514;
const LITERALS: usize = REPEATS + 514;

const CARRIED: [&str; 6] = ["place", "network", "abuse", "prefix", "rpki", "roas"];
const BOOKS: [(&str, &str); 8] = [
    ("rpki", "rpki"),
    ("place.granularity", "granularity"),
    ("city.timezone", "timezones"),
    ("city.type", "place_types"),
    ("operator.category", "categories"),
    ("abuse.user_type", "categories"),
    ("abuse.service", "services"),
    ("abuse.evidence", "evidence"),
];

struct Lzma<'a> {
    data: &'a [u8],
    at: usize,
    range: u32,
    code: u32,
    probs: Vec<u16>,
    out: Vec<u8>,
}

impl Lzma<'_> {
    fn normalize(&mut self) {
        if self.range < 1 << 24 {
            self.range <<= 8;
            self.code = self.code << 8 | self.data[self.at] as u32;
            self.at += 1;
        }
    }

    fn bit(&mut self, index: usize) -> usize {
        let chance = self.probs[index] as u32;
        let bound = (self.range >> 11) * chance;
        let bit = if self.code < bound {
            self.range = bound;
            self.probs[index] += ((2048 - chance) >> 5) as u16;
            0
        } else {
            self.range -= bound;
            self.code -= bound;
            self.probs[index] -= (chance >> 5) as u16;
            1
        };
        self.normalize();
        bit
    }

    fn direct(&mut self, count: usize) -> u32 {
        let mut value = 0;
        for _ in 0..count {
            self.range >>= 1;
            let bit = (self.code >= self.range) as u32;
            self.code -= self.range * bit;
            value = value << 1 | bit;
            self.normalize();
        }
        value
    }

    fn tree(&mut self, base: usize, count: usize) -> usize {
        let mut symbol = 1;
        for _ in 0..count {
            symbol = symbol << 1 | self.bit(base + symbol);
        }
        symbol - (1 << count)
    }

    fn reversed(&mut self, base: usize, count: usize) -> u32 {
        let (mut symbol, mut value) = (1, 0);
        for step in 0..count {
            let bit = self.bit(base + symbol);
            symbol = symbol << 1 | bit;
            value |= (bit as u32) << step;
        }
        value
    }

    fn length(&mut self, base: usize, spot: usize) -> usize {
        if self.bit(base) == 0 {
            return self.tree(base + 2 + (spot << 3), 3);
        }
        if self.bit(base + 1) == 0 {
            return 8 + self.tree(base + 130 + (spot << 3), 3);
        }
        16 + self.tree(base + 258, 8)
    }

    fn distance(&mut self, length: usize) -> u32 {
        let slot = self.tree(SLOTS + (length.min(3) << 6), 6);
        if slot < 4 {
            return slot as u32;
        }
        let count = (slot >> 1) - 1;
        let base = ((2 | (slot & 1)) << count) as u32;
        if slot < 14 {
            return base + self.reversed(SPECIAL + base as usize - slot - 1, count);
        }
        base + (self.direct(count - 4) << 4) + self.reversed(ALIGN, 4)
    }

    fn literal(&mut self, state: usize, recent: usize, context: usize, position: usize) {
        let size = self.out.len();
        let previous = self.out.last().copied().unwrap_or(0) as usize;
        let spot =
            ((size & ((1 << position) - 1)) << context) + (previous >> (8 - context));
        let base = LITERALS + 0x300 * spot;
        let mut symbol = 1;
        if state >= 7 {
            let mut matched = self.out[size - recent - 1] as usize;
            while symbol < 0x100 {
                let bit = (matched >> 7) & 1;
                matched <<= 1;
                let read = self.bit(base + ((1 + bit) << 8) + symbol);
                symbol = symbol << 1 | read;
                if read != bit {
                    break;
                }
            }
        }
        while symbol < 0x100 {
            symbol = symbol << 1 | self.bit(base + symbol);
        }
        self.out.push(symbol as u8);
    }
}

fn decompress(data: &[u8], [context, position, matches]: [usize; 3]) -> Vec<u8> {
    let mut lzma = Lzma {
        data,
        at: 5,
        range: u32::MAX,
        code: u32::from_be_bytes(data[1..5].try_into().unwrap()),
        probs: vec![1024; LITERALS + (0x300 << (context + position))],
        out: Vec::new(),
    };
    let (mut state, mut recent) = (0, [0u32; 4]);
    loop {
        let spot = lzma.out.len() & ((1 << matches) - 1);
        if lzma.bit(state << 4 | spot) == 0 {
            lzma.literal(state, recent[0] as usize, context, position);
            state = if state < 4 {
                0
            } else if state < 10 {
                state - 3
            } else {
                state - 6
            };
            continue;
        }
        let length;
        if lzma.bit(IS_REPEAT + state) == 1 {
            if lzma.bit(IS_FIRST + state) == 1 {
                let picked = if lzma.bit(IS_SECOND + state) == 0 {
                    1
                } else {
                    2 + lzma.bit(IS_THIRD + state)
                };
                recent[..=picked].rotate_right(1);
            } else if lzma.bit(IS_LONG + (state << 4 | spot)) == 0 {
                state = if state < 7 { 9 } else { 11 };
                lzma.out
                    .push(lzma.out[lzma.out.len() - recent[0] as usize - 1]);
                continue;
            }
            length = lzma.length(REPEATS, spot);
            state = if state < 7 { 8 } else { 11 };
        } else {
            recent.rotate_right(1);
            length = lzma.length(LENGTHS, spot);
            state = if state < 7 { 7 } else { 10 };
            recent[0] = lzma.distance(length);
            if recent[0] == u32::MAX {
                return lzma.out;
            }
        }
        for _ in 0..length + 2 {
            lzma.out
                .push(lzma.out[lzma.out.len() - recent[0] as usize - 1]);
        }
    }
}

enum Json {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    Text(String),
    List(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        let Json::Object(fields) = self else {
            return None;
        };
        fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        let Json::Object(fields) = self else {
            return None;
        };
        fields
            .iter_mut()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    fn set(&mut self, key: &str, value: Json) {
        let Json::Object(fields) = self else { return };
        match fields.iter_mut().find(|(name, _)| name == key) {
            Some(field) => field.1 = value,
            None => fields.push((key.to_string(), value)),
        }
    }

    fn number(&self, key: &str) -> usize {
        match self.get(key) {
            Some(Json::Integer(value)) => *value as usize,
            _ => 0,
        }
    }

    fn text(&self) -> String {
        match self {
            Json::Text(value) => value.clone(),
            _ => String::new(),
        }
    }

    fn write(&self, depth: usize, out: &mut String) {
        let indent = "  ".repeat(depth + 1);
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(&value.to_string()),
            Json::Integer(value) => out.push_str(&value.to_string()),
            Json::Float(value) => out.push_str(&value.to_string()),
            Json::Text(value) => quote(value, out),
            Json::List(_) => out.push_str("[]"),
            Json::Object(fields) if fields.is_empty() => out.push_str("{}"),
            Json::Object(fields) => {
                out.push('{');
                for (index, (name, value)) in fields.iter().enumerate() {
                    out.push_str(if index == 0 { "\n" } else { ",\n" });
                    out.push_str(&indent);
                    quote(name, out);
                    out.push_str(": ");
                    value.write(depth + 1, out);
                }
                out.push('\n');
                out.push_str(&indent[2..]);
                out.push('}');
            }
        }
    }
}

fn quote(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ if character < ' ' => out.push_str(&format!("\\u{:04x}", character as u32)),
            _ => out.push(character),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    text: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn peek(&mut self) -> u8 {
        while self.text[self.at].is_ascii_whitespace() || self.text[self.at] == b',' {
            self.at += 1;
        }
        self.text[self.at]
    }

    fn value(&mut self) -> Json {
        match self.peek() {
            b'{' => {
                self.at += 1;
                let mut fields = Vec::new();
                while self.peek() != b'}' {
                    let name = self.string();
                    self.peek();
                    self.at += 1;
                    fields.push((name, self.value()));
                }
                self.at += 1;
                Json::Object(fields)
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                while self.peek() != b']' {
                    items.push(self.value());
                }
                self.at += 1;
                Json::List(items)
            }
            b'"' => Json::Text(self.string()),
            b't' | b'f' | b'n' => {
                let word = self.text[self.at];
                self.at += if word == b'f' { 5 } else { 4 };
                if word == b'n' {
                    Json::Null
                } else {
                    Json::Bool(word == b't')
                }
            }
            _ => {
                let start = self.at;
                while b"+-.0123456789eE".contains(&self.text[self.at]) {
                    self.at += 1;
                }
                let raw = std::str::from_utf8(&self.text[start..self.at]).unwrap();
                raw.parse()
                    .map(Json::Integer)
                    .unwrap_or(Json::Float(raw.parse().unwrap()))
            }
        }
    }

    fn string(&mut self) -> String {
        let mut raw = Vec::new();
        self.at += 1;
        loop {
            let byte = self.text[self.at];
            self.at += 1;
            match byte {
                b'"' => return String::from_utf8_lossy(&raw).into_owned(),
                b'\\' => {
                    let escaped = self.text[self.at];
                    self.at += 1;
                    let character = match escaped {
                        b'n' => '\n',
                        b't' => '\t',
                        b'u' => {
                            let hex =
                                std::str::from_utf8(&self.text[self.at..self.at + 4]);
                            self.at += 4;
                            let code = u32::from_str_radix(hex.unwrap(), 16).unwrap();
                            char::from_u32(code).unwrap_or('\u{fffd}')
                        }
                        other => other as char,
                    };
                    raw.extend_from_slice(character.encode_utf8(&mut [0; 4]).as_bytes());
                }
                _ => raw.push(byte),
            }
        }
    }
}

fn varint(data: &[u8], mut at: usize) -> (u128, usize) {
    let (mut value, mut shift) = (0u128, 0);
    loop {
        value |= ((data[at] & 0x7F) as u128) << shift;
        at += 1;
        if data[at - 1] & 0x80 == 0 {
            return (value, at);
        }
        shift += 7;
    }
}

fn upper(values: &[u128], address: u128) -> usize {
    values.partition_point(|value| *value <= address)
}

struct Section {
    count: usize,
    block: usize,
    group: usize,
    encoding: String,
    read: String,
    tuning: [usize; 3],
    width: usize,
    offsets: Vec<usize>,
    keys: Vec<u128>,
    data: &'static [u8],
    blocks: RefCell<HashMap<usize, Rc<Vec<u8>>>>,
}

impl Section {
    fn new(view: &'static [u8], entry: &Json) -> Section {
        let word =
            |at: usize| u32::from_le_bytes(view[at..at + 4].try_into().unwrap()) as usize;
        let (count, width) = (word(0), word(4));
        let at = 8 + 4 * (count + 1);
        let key = |index: usize| {
            let start = at + index * width;
            view[start..start + width]
                .iter()
                .fold(0u128, |key, byte| key << 8 | *byte as u128)
        };
        let Some(Json::List(tuning)) = entry.get("lzma") else {
            panic!("no tuning")
        };
        let tuning = [0, 1, 2].map(|index| match tuning[index] {
            Json::Integer(value) => value as usize,
            _ => 0,
        });
        Section {
            count: entry.number("count"),
            block: entry.number("block"),
            group: entry.number("group"),
            encoding: entry.get("encoding").map(Json::text).unwrap_or_default(),
            read: entry.get("read").map(Json::text).unwrap_or_default(),
            tuning,
            width,
            offsets: (0..=count).map(|index| word(8 + 4 * index)).collect(),
            keys: (0..count).map(key).collect(),
            data: &view[at + width * count..],
            blocks: RefCell::new(HashMap::new()),
        }
    }

    fn fanout(&self) -> usize {
        self.block / self.group
    }

    fn decoded(&self, index: usize) -> Rc<Vec<u8>> {
        let mut blocks = self.blocks.borrow_mut();
        let packed = &self.data[self.offsets[index]..self.offsets[index + 1]];
        blocks
            .entry(index)
            .or_insert_with(|| Rc::new(decompress(packed, self.tuning)))
            .clone()
    }

    fn number(&self, block: &[u8], place: usize, width: usize) -> i64 {
        let start = 1 + place * width;
        let raw = &block[start..start + width];
        let value = raw
            .iter()
            .rev()
            .fold(0u64, |value, byte| value << 8 | *byte as u64);
        if self.encoding == "fixed" {
            return value as i64;
        }
        let shift = 64 - 8 * width;
        ((value << shift) as i64) >> shift
    }

    fn value(&self, row: usize) -> i64 {
        let block = self.decoded(row / self.block);
        let (place, width) = (row % self.block, block[0] as usize);
        if self.encoding != "delta" {
            return self.number(&block, place, width);
        }
        (0..=place)
            .map(|index| self.number(&block, index, width))
            .sum()
    }

    fn text(&self, identifier: i64) -> String {
        if identifier == 0 {
            return String::new();
        }
        let (group, place) = (
            (identifier as usize - 1) / self.group,
            (identifier as usize - 1) % self.group,
        );
        let (index, at) = (group / self.fanout(), group % self.fanout());
        let block = self.decoded(index);
        let total = self
            .fanout()
            .min((self.count - index * self.block).div_ceil(self.group))
            - 1;
        let (mut cursor, mut start) = (0, 0);
        for step in 0..total {
            let (length, next) = varint(&block, cursor);
            cursor = next;
            start += if step < at { length as usize } else { 0 };
        }
        cursor += start;
        let mut previous = Vec::new();
        for _ in 0..=place {
            previous.truncate(block[cursor] as usize);
            let (fresh, next) = varint(&block, cursor + 1);
            previous.extend_from_slice(&block[next..next + fresh as usize]);
            cursor = next + fresh as usize;
        }
        String::from_utf8_lossy(&previous).into_owned()
    }

    fn heads(&self, index: usize) -> (Vec<u128>, Vec<usize>) {
        let block = self.decoded(index);
        let (count, mut cursor) = varint(&block, 0);
        let total = (count as usize).div_ceil(self.group);
        let mut heads = vec![self.keys[index]];
        for _ in 1..total {
            let (gap, next) = varint(&block, cursor);
            cursor = next;
            heads.push(heads[heads.len() - 1] + gap);
        }
        let mut starts = Vec::new();
        for _ in 1..total {
            let (length, next) = varint(&block, cursor);
            cursor = next;
            starts.push(length as usize);
        }
        let starts = std::iter::once(cursor)
            .chain(starts.iter().scan(cursor, |sum, length| {
                *sum += length;
                Some(*sum)
            }))
            .collect();
        (heads, starts)
    }

    fn values(&self, group: usize) -> Vec<u128> {
        let (index, at) = (group / self.fanout(), group % self.fanout());
        let (heads, starts) = self.heads(index);
        let block = self.decoded(index);
        let size = self.group.min(self.count - group * self.group);
        let host_bits = if self.width == 4 { 0 } else { 64 };
        let (mut network, mut cursor) = (heads[at] >> host_bits, starts[at]);
        let mut networks = vec![network];
        for _ in 1..size {
            let (gap, next) = varint(&block, cursor);
            cursor = next;
            network += gap;
            networks.push(network);
        }
        if host_bits == 0 {
            return networks;
        }
        let hosts = networks.iter().map(|network| {
            let (host, next) = varint(&block, cursor);
            cursor = next;
            network << 64 | host
        });
        hosts.collect()
    }

    fn row(&self, address: u128) -> Option<(usize, bool)> {
        let index = upper(&self.keys, address).checked_sub(1)?;
        let group = index * self.fanout() + upper(&self.heads(index).0, address) - 1;
        let values = self.values(group);
        let spot = upper(&values, address).checked_sub(1)?;
        Some((group * self.group + spot, values[spot] == address))
    }
}

struct Plevin {
    sections: HashMap<String, Section>,
    books: HashMap<String, Vec<String>>,
    tables: HashMap<String, Vec<(String, bool, String)>>,
}

impl Plevin {
    fn open(path: &str) -> Plevin {
        let data: &'static [u8] = std::fs::read(path).unwrap_or_default().leak();
        if !data.starts_with(b"PLEVIN\0\x02") {
            fail(&format!("{path} is not a plevin 2 database"));
        }
        let size = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        let head = Parser {
            text: &data[12..12 + size],
            at: 0,
        }
        .value();
        let mut plevin = Plevin {
            sections: HashMap::new(),
            books: HashMap::new(),
            tables: HashMap::new(),
        };
        let Some(Json::Object(sections)) = head.get("sections") else {
            panic!("no sections")
        };
        for (name, entry) in sections {
            let at = 12 + size + entry.number("offset");
            let section = Section::new(&data[at..at + entry.number("bytes")], entry);
            plevin.sections.insert(name.clone(), section);
            let parts: Vec<&str> = name.split('.').collect();
            if parts.len() == 3 && (parts[0] == "col" || parts[0] == "link") {
                let column = (parts[2].to_string(), parts[0] == "link", name.clone());
                plevin
                    .tables
                    .entry(parts[1].to_string())
                    .or_default()
                    .push(column);
            }
        }
        for (field, book) in BOOKS {
            if let Some(Json::List(words)) =
                head.get("vocabularies").and_then(|all| all.get(book))
            {
                plevin
                    .books
                    .insert(field.to_string(), words.iter().map(Json::text).collect());
            }
        }
        plevin
    }

    fn read(&self, name: &str, section: &Section, value: i64) -> Json {
        if name == "abuse.risk" {
            return if value == 255 {
                Json::Null
            } else {
                Json::Float(value as f64 / 100.0)
            };
        }
        if name == "abuse.is_anycast" || name == "abuse.is_satellite" {
            return Json::Bool(value != 0);
        }
        if let Some(book) = self.books.get(name) {
            return Json::Text(book.get(value as usize).cloned().unwrap_or_default());
        }
        match section.read.as_str() {
            "text" => Json::Text(self.sections["strings"].text(value)),
            "" => Json::Integer(value),
            _ => Json::Float(value as f64 / 10000.0),
        }
    }

    fn row(&self, table: &str, row: usize) -> Json {
        let mut out = Vec::new();
        for (field, link, name) in self.tables.get(table).into_iter().flatten() {
            let section = &self.sections[name];
            let value = section.value(row);
            if !link {
                out.push((
                    field.clone(),
                    self.read(&format!("{table}.{field}"), section, value),
                ));
            } else if value != 0 {
                out.push((field.clone(), self.row(field, value as usize - 1)));
            }
        }
        let mut object = Json::Object(out);
        let cut = match (object.get("postal_partial"), object.get("postal")) {
            (Some(Json::Integer(partial)), Some(Json::Text(postal))) => {
                postal.chars().take(*partial as usize).collect()
            }
            _ => return object,
        };
        object.set("postal_partial", Json::Text(cut));
        object
    }

    fn lookup(&self, text: &str) -> Json {
        let (version, address) = match text.parse::<IpAddr>() {
            Ok(IpAddr::V4(address)) => ("v4", u32::from(address) as u128),
            Ok(IpAddr::V6(address)) => ("v6", u128::from(address)),
            Err(_) => fail(&format!("{text} is not an address")),
        };
        let found = self
            .sections
            .get(&format!("spine.{version}"))
            .and_then(|spine| spine.row(address));
        let Some((row, _)) = found else {
            return Json::Null;
        };
        let hosts = self.sections.get(&format!("hosts.{version}"));
        let records = self.sections.get(&format!("hosts.{version}.abuse"));
        let mut override_abuse = 0;
        if let (Some(hosts), Some(records)) = (hosts, records) {
            if let Some((at, true)) = hosts.row(address) {
                override_abuse = records.value(at) + 1;
            }
        }
        self.answer(version, row, override_abuse)
    }

    fn answer(&self, version: &str, row: usize, override_abuse: i64) -> Json {
        let mut out = Json::Object(Vec::new());
        for name in CARRIED {
            let Some(column) = self.sections.get(&format!("spine.{version}.{name}"))
            else {
                continue;
            };
            let mut value = column.value(row);
            if override_abuse != 0 && name == "abuse" {
                value = override_abuse;
            }
            if matches!(name, "place" | "network" | "abuse") {
                if value != 0 {
                    out.set(name, self.row(name, value as usize - 1));
                }
                continue;
            }
            if out.get("network").is_none() {
                out.set("network", Json::Object(Vec::new()));
            }
            let network = out.get_mut("network").unwrap();
            network.set(name, self.read(name, column, value));
        }
        out
    }
}

fn fail(reason: &str) -> ! {
    eprintln!("{reason}");
    std::process::exit(1)
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 3 {
        fail("usage: plevin path address");
    }
    let mut out = String::new();
    Plevin::open(&arguments[1])
        .lookup(&arguments[2])
        .write(0, &mut out);
    println!("{out}");
}
