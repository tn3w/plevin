//! The inputs that are not lines of text: two IP databases, a routing table, shapes.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// One row of an IP geolocation database: a span, where it lands, how well it knows.
#[derive(Clone, Default)]
pub struct Coarse {
    pub first: u128,
    pub last: u128,
    pub lat: f64,
    pub lon: f64,
    pub radius: u16,
    pub grain: u8,
    pub country: [u8; 2],
    pub metro: u16,
}

pub const CITY: u8 = 0;
pub const REGION: u8 = 1;
pub const COUNTRY: u8 = 2;
pub const NOWHERE: u8 = 3;

pub fn raw(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|_| {
        eprintln!("missing {}", path.display());
        Vec::new()
    })
}

pub fn slurp(path: &Path) -> String {
    String::from_utf8_lossy(&raw(path)).into_owned()
}

/// One of the builder's own tables, which are JSON and live beside its source.
pub fn data(name: &str) -> serde_json::Value {
    let body = slurp(&Path::new("data").join(name));
    serde_json::from_str(&body).unwrap_or_else(|_| panic!("{name}"))
}

/// One comma separated row, keeping what quotes hold together.
pub fn row(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut quoted = false;
    for point in line.chars() {
        match point {
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(String::new()),
            _ => fields.last_mut().unwrap().push(point),
        }
    }
    fields
}

/// An address or a prefix as the span it covers.
pub fn span(text: &str) -> Option<(u128, u128, bool)> {
    let text = text.trim().trim_start_matches('[').replace(']', "");
    let (head, tail) = match text.split_once('/') {
        Some((head, tail)) => (head, tail.parse::<u32>().ok()?),
        None => (text.as_str(), u32::MAX),
    };
    let (first, bits) = match head.parse::<std::net::IpAddr>().ok()? {
        std::net::IpAddr::V4(address) => (u32::from(address) as u128, 32),
        std::net::IpAddr::V6(address) => (u128::from(address), 128),
    };
    let spare = bits - tail.min(bits);
    let first = first >> spare << spare;
    Some((first, first | fill(spare), bits == 128))
}

/// Every bit below a prefix, set.
pub fn fill(spare: u32) -> u128 {
    1u128.checked_shl(spare).unwrap_or(0).wrapping_sub(1)
}

/// A MaxMind database, walked whole rather than looked up one address at a time.
pub struct Mmdb {
    data: Vec<u8>,
    nodes: u32,
    stride: usize,
    body: usize,
}

impl Mmdb {
    pub fn open(path: &Path) -> Option<Mmdb> {
        let data = raw(path);
        let mark = b"\xab\xcd\xefMaxMind.com";
        let at = data.windows(mark.len()).rposition(|window| window == mark)?;
        let head = Mmdb { data, nodes: 0, stride: 0, body: 0 };
        let meta = head.map(at + mark.len());
        let nodes = head.number(*meta.get("node_count")?) as u32;
        let bits = head.number(*meta.get("record_size")?) as usize;
        let stride = bits * 2 / 8;
        let body = nodes as usize * stride + 16;
        Some(Mmdb { data: head.data, nodes, stride, body })
    }

    fn record(&self, node: u32, side: usize) -> u32 {
        let at = node as usize * self.stride;
        let bytes = &self.data[at..at + self.stride];
        match self.stride {
            6 => u32::from_be_bytes([
                0,
                bytes[side * 3],
                bytes[side * 3 + 1],
                bytes[side * 3 + 2],
            ]),
            8 => u32::from_be_bytes(bytes[side * 4..side * 4 + 4].try_into().unwrap()),
            _ => match side {
                0 => u32::from_be_bytes([bytes[3] >> 4, bytes[0], bytes[1], bytes[2]]),
                _ => u32::from_be_bytes([bytes[3] & 0xF, bytes[4], bytes[5], bytes[6]]),
            },
        }
    }

    fn head(&self, at: usize) -> (u8, usize, usize) {
        let control = self.data[at];
        let mut kind = control >> 5;
        let mut next = at + 1;
        if kind == 0 {
            kind = 7 + self.data[next];
            next += 1;
        }
        let mut size = (control & 0x1F) as usize;
        if kind != 1 && size >= 29 {
            let extra = size - 28;
            let mut value = 0usize;
            for step in 0..extra {
                value = value << 8 | self.data[next + step] as usize;
            }
            size = value + [0, 29, 285, 65821][extra];
            next += extra;
        }
        (kind, size, next)
    }

    fn follow(&self, at: usize) -> usize {
        let (kind, size, next) = self.head(at);
        if kind != 1 {
            return at;
        }
        let width = (size >> 3) & 3;
        let mut value = size & 7;
        for step in 0..=width {
            value = value << 8 | self.data[next + step] as usize;
        }
        if width == 3 {
            value &= 0xFFFF_FFFF;
        }
        self.body + value + [0, 2048, 526_336, 0][width]
    }

    fn skip(&self, at: usize) -> usize {
        let (kind, size, next) = self.head(at);
        match kind {
            1 => next + ((size >> 3) & 3) + 1,
            7 => (0..size).fold(next, |at, _| self.skip(self.skip(at))),
            11 => (0..size).fold(next, |at, _| self.skip(at)),
            14 => next,
            _ => next + size,
        }
    }

    fn map(&self, at: usize) -> HashMap<String, usize> {
        let at = self.follow(at);
        let (kind, size, mut next) = self.head(at);
        let mut entries = HashMap::new();
        if kind != 7 {
            return entries;
        }
        for _ in 0..size {
            let key = self.text(next);
            next = self.skip(next);
            entries.insert(key, next);
            next = self.skip(next);
        }
        entries
    }

    fn text(&self, at: usize) -> String {
        let at = self.follow(at);
        let (kind, size, next) = self.head(at);
        match kind {
            2 => String::from_utf8_lossy(&self.data[next..next + size]).into_owned(),
            _ => String::new(),
        }
    }

    fn number(&self, at: usize) -> f64 {
        let at = self.follow(at);
        let (kind, size, next) = self.head(at);
        if kind == 14 {
            return size as f64;
        }
        let bytes = &self.data[next..next + size];
        match kind {
            3 => f64::from_be_bytes(bytes.try_into().unwrap_or([0; 8])),
            15 => f32::from_be_bytes(bytes.try_into().unwrap_or([0; 4])) as f64,
            8 => bytes.iter().fold(0i64, |value, byte| value << 8 | *byte as i64) as f64,
            _ => bytes.iter().fold(0u64, |value, byte| value << 8 | *byte as u64) as f64,
        }
    }

    fn place(&self, at: usize) -> Coarse {
        let row = self.map(at);
        let named = row.get("country").or_else(|| row.get("registered_country"));
        let code = match named {
            Some(at) => self.word(&self.map(*at), "iso_code"),
            None => String::new(),
        };
        let grain = match (row.contains_key("city"), row.contains_key("subdivisions")) {
            (true, _) => CITY,
            (_, true) => REGION,
            _ => COUNTRY,
        };
        let spot = row.get("location").map(|at| self.map(*at)).unwrap_or_default();
        let (lat, lon) = (self.count(&spot, "latitude"), self.count(&spot, "longitude"));
        Coarse {
            first: 0,
            last: 0,
            lat,
            lon,
            radius: self.count(&spot, "accuracy_radius") as u16,
            grain: match code.is_empty() || (lat == 0.0 && lon == 0.0) {
                true => NOWHERE,
                false => grain,
            },
            country: two(&code),
            metro: self.count(&spot, "metro_code") as u16,
        }
    }

    fn word(&self, row: &HashMap<String, usize>, key: &str) -> String {
        row.get(key).map(|at| self.text(*at)).unwrap_or_default()
    }

    fn count(&self, row: &HashMap<String, usize>, key: &str) -> f64 {
        row.get(key).map(|at| self.number(*at)).unwrap_or(0.0)
    }

    /// Every span the tree names, the v4 half read out of the subtree it is aliased to.
    pub fn ranges(&self, wide: bool) -> Vec<Coarse> {
        let mut stack = match wide {
            true => vec![(0, 0u128, 0u32)],
            false => vec![(self.descend(), 0u128, 96)],
        };
        let mut leaves = Vec::new();
        while let Some((node, prefix, depth)) = stack.pop() {
            if wide && ALIASED.contains(&(prefix, depth)) {
                continue;
            }
            for side in [1, 0] {
                let value = self.record(node, side);
                let below = prefix | (side as u128) << (127 - depth);
                match (value == self.nodes, value < self.nodes) {
                    (true, _) => continue,
                    (_, true) => stack.push((value, below, depth + 1)),
                    _ => leaves.push((below, depth + 1, value)),
                }
            }
        }
        let mut store: HashMap<u32, Coarse> = HashMap::new();
        let mut ranges = Vec::with_capacity(leaves.len());
        for (prefix, depth, value) in leaves {
            let place = store.entry(value).or_insert_with(|| {
                self.place(self.body + value as usize - self.nodes as usize - 16)
            });
            ranges.push(Coarse {
                first: prefix,
                last: prefix | fill(128 - depth),
                ..place.clone()
            });
        }
        ranges.sort_by_key(|place| place.first);
        ranges
    }

    fn descend(&self) -> u32 {
        let mut node = 0;
        for _ in 0..96 {
            node = self.record(node, 0);
            if node >= self.nodes {
                return 0;
            }
        }
        node
    }
}

const ALIASED: &[(u128, u32)] =
    &[(0, 96), (0xFFFF_0000_0000, 96), (0x2002 << 112, 16), (0x2001 << 112, 32)];

pub fn two(code: &str) -> [u8; 2] {
    let bytes = code.as_bytes();
    match bytes.len() {
        2 => [bytes[0], bytes[1]],
        _ => [0, 0],
    }
}

/// An IP2Location binary, both of its tables read straight out of the rows.
pub struct Location {
    data: Vec<u8>,
}

impl Location {
    pub fn open(path: &Path) -> Option<Location> {
        let data = raw(path);
        match data.len() > 64 {
            true => Some(Location { data }),
            false => None,
        }
    }

    fn word(&self, at: usize) -> u32 {
        u32::from_le_bytes(self.data[at..at + 4].try_into().unwrap())
    }

    fn text(&self, at: usize) -> &str {
        let at = self.word(at) as usize;
        match at + 1 < self.data.len() {
            true => {
                let size = self.data[at] as usize;
                std::str::from_utf8(&self.data[at + 1..at + 1 + size]).unwrap_or("")
            }
            false => "",
        }
    }

    pub fn rows(&self, wide: bool) -> Vec<Coarse> {
        let columns = self.data[1] as usize;
        let (count, base) = match wide {
            true => (self.word(13), self.word(17)),
            false => (self.word(5), self.word(9)),
        };
        let step = columns * 4 + if wide { 12 } else { 0 };
        let mut rows = Vec::with_capacity(count as usize);
        for index in 0..count as usize {
            let at = base as usize - 1 + index * step;
            let first = match wide {
                true => u128::from_le_bytes(self.data[at..at + 16].try_into().unwrap()),
                false => self.word(at) as u128,
            };
            let at = at + if wide { 16 } else { 4 };
            let city = self.text(at + 8);
            let grain = match (known(city), known(self.text(at + 4))) {
                (true, _) => CITY,
                (_, true) => REGION,
                _ => COUNTRY,
            };
            let code = self.text(at);
            let lat = f32::from_le_bytes(self.data[at + 12..at + 16].try_into().unwrap())
                as f64;
            let lon = f32::from_le_bytes(self.data[at + 16..at + 20].try_into().unwrap())
                as f64;
            rows.push(Coarse {
                first,
                last: 0,
                lat,
                lon,
                radius: 0,
                grain: match known(code) && (lat != 0.0 || lon != 0.0) {
                    true => grain,
                    false => NOWHERE,
                },
                country: two(code),
                metro: 0,
            });
        }
        let ceiling = if wide { u128::MAX } else { u32::MAX as u128 };
        for index in 0..rows.len() {
            rows[index].last = match rows.get(index + 1) {
                Some(next) => next.first - 1,
                None => ceiling,
            };
        }
        rows
    }
}

fn known(text: &str) -> bool {
    !text.is_empty() && text != "-" && !text.starts_with("Invalid ")
}

pub struct Announce {
    pub first: u128,
    pub length: u8,
    pub wide: bool,
    pub asn: u32,
}

/// The routing table dump, one announcement per prefix by majority of its peers.
pub fn announcements(path: &Path) -> Vec<Announce> {
    let Ok(handle) = File::open(path) else {
        eprintln!("missing {}", path.display());
        return Vec::new();
    };
    let mut reader = BufReader::with_capacity(1 << 22, handle);
    let mut head = [0u8; 12];
    let mut body = Vec::new();
    let mut found = Vec::new();
    while reader.read_exact(&mut head).is_ok() {
        let kind = u16::from_be_bytes([head[4], head[5]]);
        let subtype = u16::from_be_bytes([head[6], head[7]]);
        let length = u32::from_be_bytes(head[8..12].try_into().unwrap()) as usize;
        body.resize(length, 0);
        if reader.read_exact(&mut body).is_err() {
            break;
        }
        if kind == 13
            && (subtype == 2 || subtype == 4)
            && let Some(seen) = table(&body, subtype == 4)
        {
            found.push(seen);
        }
    }
    found
}

fn table(body: &[u8], wide: bool) -> Option<Announce> {
    let length = *body.get(4)? as usize;
    let bytes = length.div_ceil(8);
    let mut cell = [0u8; 16];
    cell[..bytes].copy_from_slice(body.get(5..5 + bytes)?);
    let first = match wide {
        true => u128::from_be_bytes(cell),
        false => u32::from_be_bytes(cell[..4].try_into().unwrap()) as u128,
    };
    let mut at = 5 + bytes;
    let entries = u16::from_be_bytes(body.get(at..at + 2)?.try_into().ok()?);
    at += 2;
    let mut tally: Vec<(u32, u32)> = Vec::new();
    for _ in 0..entries {
        let size =
            u16::from_be_bytes(body.get(at + 6..at + 8)?.try_into().ok()?) as usize;
        at += 8;
        let asn = origin(body.get(at..at + size)?);
        at += size;
        match tally.iter_mut().find(|(held, _)| *held == asn) {
            Some(seen) => seen.1 += 1,
            None => tally.push((asn, 1)),
        }
    }
    let (asn, _) = tally.into_iter().max_by_key(|(asn, count)| (*count, !*asn))?;
    match length == 0 || asn == 0 {
        true => None,
        false => Some(Announce { first, length: length as u8, wide, asn }),
    }
}

fn origin(attributes: &[u8]) -> u32 {
    let mut at = 0;
    while at + 3 <= attributes.len() {
        let flags = attributes[at];
        let kind = attributes[at + 1];
        let wide = flags & 0x10 != 0;
        let size = match wide {
            true => u16::from_be_bytes([attributes[at + 2], attributes[at + 3]]) as usize,
            false => attributes[at + 2] as usize,
        };
        at += if wide { 4 } else { 3 };
        if kind == 2 {
            return last(&attributes[at..(at + size).min(attributes.len())]);
        }
        at += size;
    }
    0
}

fn last(path: &[u8]) -> u32 {
    let mut at = 0;
    let mut found = 0;
    while at + 2 <= path.len() {
        let count = path[at + 1] as usize;
        let set = path[at] == 1;
        at += 2;
        let hops = (at..at + count * 4).step_by(4).filter(|spot| spot + 4 <= path.len());
        let reading: Vec<u32> = hops
            .map(|spot| u32::from_be_bytes(path[spot..spot + 4].try_into().unwrap()))
            .collect();
        if let Some(hop) = if set { reading.first() } else { reading.last() } {
            found = *hop;
        }
        at += count * 4;
    }
    found
}

/// The attribute table beside a shapefile, read as text columns.
pub struct Table {
    pub names: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl Table {
    pub fn at(&self, row: usize, name: &str) -> &str {
        match self.names.iter().position(|held| held == name) {
            Some(column) => self.rows[row][column].as_str(),
            None => "",
        }
    }
}

pub fn dbf(path: &Path) -> Table {
    let data = raw(path);
    if data.len() < 32 {
        return Table { names: Vec::new(), rows: Vec::new() };
    }
    let count = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
    let head = u16::from_le_bytes(data[8..10].try_into().unwrap()) as usize;
    let width = u16::from_le_bytes(data[10..12].try_into().unwrap()) as usize;
    let (mut names, mut sizes, mut at) = (Vec::new(), Vec::new(), 32);
    while at < head && data[at] != 0x0D {
        let name = data[at..at + 11].split(|byte| *byte == 0).next().unwrap_or(&[]);
        names.push(String::from_utf8_lossy(name).into_owned());
        sizes.push(data[at + 16] as usize);
        at += 32;
    }
    let mut rows = Vec::with_capacity(count);
    for index in 0..count {
        let mut at = head + index * width + 1;
        if at + width > data.len() {
            break;
        }
        let mut row = Vec::with_capacity(sizes.len());
        for &size in &sizes {
            let text = String::from_utf8_lossy(&data[at..at + size]).into_owned();
            row.push(
                text.trim_matches(|point| point == '\0' || point == ' ').to_string(),
            );
            at += size;
        }
        rows.push(row);
    }
    Table { names, rows }
}

/// The rings of every shape, in the order the attribute table names them.
pub fn shapes(path: &Path) -> Vec<Vec<Vec<[f64; 2]>>> {
    let data = raw(path);
    let mut shapes = Vec::new();
    let mut at = 100;
    while at + 8 <= data.len() {
        let size =
            u32::from_be_bytes(data[at + 4..at + 8].try_into().unwrap()) as usize * 2;
        let body = &data[at + 8..(at + 8 + size).min(data.len())];
        at += 8 + size;
        if body.len() < 44 || u32::from_le_bytes(body[0..4].try_into().unwrap()) != 5 {
            shapes.push(Vec::new());
            continue;
        }
        let parts = u32::from_le_bytes(body[36..40].try_into().unwrap()) as usize;
        let points = u32::from_le_bytes(body[40..44].try_into().unwrap()) as usize;
        let starts: Vec<usize> = (0..parts)
            .map(|part| {
                let at = 44 + part * 4;
                u32::from_le_bytes(body[at..at + 4].try_into().unwrap()) as usize
            })
            .collect();
        let base = 44 + parts * 4;
        let read = |index: usize| {
            let at = base + index * 16;
            [
                f64::from_le_bytes(body[at..at + 8].try_into().unwrap()),
                f64::from_le_bytes(body[at + 8..at + 16].try_into().unwrap()),
            ]
        };
        let rings = (0..parts)
            .map(|part| {
                let stop = starts.get(part + 1).copied().unwrap_or(points);
                (starts[part]..stop).map(read).collect()
            })
            .collect();
        shapes.push(rings);
    }
    shapes
}
