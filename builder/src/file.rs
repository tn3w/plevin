//! The file: fixed blocks, one codec, and a header that says how to read them all.

use crate::Selection;
use crate::spine::{Part, Written};
use serde_json::json;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAGIC: &[u8] = b"PLEVIN\0";
const FORMAT: u8 = 1;
const LEVEL: i32 = 19;
const PROBE: usize = 32;
const BOOK: usize = 112 * 1024;
const SHARES: [usize; 3] = [256, 64, 1];
const WIDTHS: [usize; 4] = [1, 2, 4, 8];
const VALUES: usize = 8192;
const KEYS: usize = 16384;
const GROUP: usize = 64;
const NAMES: usize = 8192;
const RUN: usize = 32;

pub struct Report {
    pub bytes: usize,
    pub spine: [usize; 2],
    pub hosts: [usize; 2],
    pub sections: Vec<(String, usize, usize, usize)>,
}

impl Report {
    pub fn print(&self, name: &str) {
        println!("{name}: {} bytes", self.bytes);
        println!(
            "  spine {} v4 {} v6, hosts {} v4 {} v6",
            self.spine[0], self.spine[1], self.hosts[0], self.hosts[1]
        );
        for (section, raw, stored, count) in &self.sections {
            let each = *stored as f64 / (*count).max(1) as f64;
            println!(
                "  {section:<26} {raw:>11} raw {stored:>10} stored {count:>9} × {each:.2}"
            );
        }
    }
}

struct Packed {
    name: String,
    entry: serde_json::Value,
    raw: usize,
    body: Vec<u8>,
}

pub fn write(path: &Path, selection: &Selection, written: Written) -> Report {
    let mut packed: Vec<Packed> = Vec::new();
    let mut spine = [0usize; 2];
    let mut hosts = [0usize; 2];
    for part in written.parts {
        let held = match part {
            Part::Values(sheet) => {
                let count = sheet.values.len();
                let (blocks, encoding) = narrowest(&sheet.values, sheet.encoding);
                pack(
                    sheet.name,
                    blocks,
                    Vec::new(),
                    0,
                    count,
                    VALUES,
                    VALUES,
                    encoding,
                    sheet.read,
                )
            }
            Part::Index { name, keys, wide } => {
                let count = keys.len();
                let width = if wide { 16 } else { 4 };
                let (blocks, heads) = addresses(&keys, wide);
                match name.starts_with("spine") {
                    true => spine[wide as usize] = count,
                    false => hosts[wide as usize] = count,
                }
                pack(name, blocks, heads, width, count, KEYS, GROUP, "index", "")
            }
            Part::Strings(pool) => {
                let count = pool.len();
                let blocks = coded(&pool);
                pack(
                    "strings".into(),
                    blocks,
                    Vec::new(),
                    0,
                    count,
                    NAMES,
                    RUN,
                    "front",
                    "",
                )
            }
        };
        packed.push(held);
    }
    let mut sections = serde_json::Map::new();
    let mut at = 0usize;
    for held in &packed {
        let mut entry = held.entry.clone();
        entry["offset"] = json!(at);
        entry["bytes"] = json!(held.body.len());
        sections.insert(held.name.clone(), entry);
        at += held.body.len();
    }
    let body: usize = at;
    let mut head = String::new();
    for _ in 0..8 {
        let total = MAGIC.len() + 5 + head.len() + body;
        let again = header(
            selection,
            &written.fields,
            written.carries,
            &written.books,
            &sections,
            total,
        );
        let settled = again.len() == head.len();
        head = again;
        if settled {
            break;
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(MAGIC.len() + 5 + head.len() + body);
    out.extend_from_slice(MAGIC);
    out.push(FORMAT);
    out.extend_from_slice(&(head.len() as u32).to_le_bytes());
    out.extend_from_slice(head.as_bytes());
    for held in &packed {
        out.extend_from_slice(&held.body);
    }
    std::fs::write(path, &out).expect("write");
    Report {
        bytes: out.len(),
        spine,
        hosts,
        sections: packed
            .iter()
            .map(|held| {
                let count = held.entry["count"].as_u64().unwrap_or(0) as usize;
                (held.name.clone(), held.raw, held.body.len(), count)
            })
            .collect(),
    }
}

fn header(
    selection: &Selection,
    fields: &[String],
    carries: [bool; 3],
    books: &[(&'static str, Vec<String>)],
    sections: &serde_json::Map<String, serde_json::Value>,
    length: usize,
) -> String {
    json!({
        "format": FORMAT,
        "built": today(),
        "selection": selection.name,
        "fields": fields,
        "carries": carries,
        "vocabularies": books
            .iter()
            .map(|(name, held)| (name.to_string(), json!(held)))
            .collect::<serde_json::Map<String, serde_json::Value>>(),
        "sections": sections,
        "length": length,
    })
    .to_string()
}

fn today() -> String {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() / 86400;
    let (mut year, mut left) = (1970i64, days as i64);
    loop {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let length = if leap { 366 } else { 365 };
        if left < length {
            let months =
                [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            let mut month = 0;
            while left >= months[month] {
                left -= months[month];
                month += 1;
            }
            return format!("{year:04}-{:02}-{:02}", month + 1, left + 1);
        }
        left -= length;
        year += 1;
    }
}

/// Values as they stand, or as the steps between them: whichever packs smaller.
fn narrowest(values: &[i64], encoding: &'static str) -> (Vec<Vec<u8>>, &'static str) {
    let plain = numbers(values, encoding == "signed");
    let Some(stepped) = steps(values) else {
        return (plain, encoding);
    };
    match weigh(&stepped, &[]) < weigh(&plain, &[]) {
        true => (stepped, "delta"),
        false => (plain, encoding),
    }
}

/// One block is one array: a width byte, then that many bytes a value.
fn numbers(values: &[i64], signed: bool) -> Vec<Vec<u8>> {
    values.chunks(VALUES).map(|chunk| array(chunk, signed)).collect()
}

/// The step from the value before, restarting at zero every block a reader sums.
fn steps(values: &[i64]) -> Option<Vec<Vec<u8>>> {
    values
        .chunks(VALUES)
        .map(|chunk| {
            let mut held = Vec::with_capacity(chunk.len());
            let mut last = 0i64;
            for value in chunk {
                held.push(value.checked_sub(last)?);
                last = *value;
            }
            Some(array(&held, true))
        })
        .collect()
}

fn array(chunk: &[i64], signed: bool) -> Vec<u8> {
    let width = chunk.iter().map(|value| room(*value, signed)).max().unwrap_or(1);
    let mut block = Vec::with_capacity(1 + chunk.len() * width);
    block.push(width as u8);
    for value in chunk {
        block.extend_from_slice(&value.to_le_bytes()[..width]);
    }
    block
}

fn room(value: i64, signed: bool) -> usize {
    let fits = |width: usize| match signed {
        true => {
            let bits = width as u32 * 8 - 1;
            value >= -(1i64 << bits) && value < 1i64 << bits
        }
        false => width == 8 || (value as u64) < 1u64 << (width as u32 * 8),
    };
    *WIDTHS.iter().find(|width| fits(**width)).unwrap_or(&8)
}

/// The pool, sorted then front coded, restarting every group so a group decodes alone.
fn coded(pool: &[String]) -> Vec<Vec<u8>> {
    pool.chunks(NAMES)
        .map(|chunk| {
            let groups: Vec<Vec<u8>> = chunk.chunks(RUN).map(group).collect();
            let mut block = Vec::new();
            for held in groups.iter().take(groups.len().saturating_sub(1)) {
                varint(&mut block, held.len() as u128);
            }
            for held in &groups {
                block.extend_from_slice(held);
            }
            block
        })
        .collect()
}

fn group(names: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut last = "";
    for name in names {
        let shared = last
            .bytes()
            .zip(name.bytes())
            .take_while(|(one, other)| one == other)
            .count()
            .min(255);
        let shared = boundary(name, shared);
        out.push(shared as u8);
        varint(&mut out, (name.len() - shared) as u128);
        out.extend_from_slice(&name.as_bytes()[shared..]);
        last = name;
    }
    out
}

/// The one section a lookup bisects: block keys, then group heads, then gaps.
fn addresses(keys: &[u128], wide: bool) -> (Vec<Vec<u8>>, Vec<u128>) {
    let mut blocks = Vec::new();
    let mut heads = Vec::new();
    let host = if wide { 64 } else { 0 };
    for chunk in keys.chunks(KEYS) {
        heads.push(chunk[0]);
        let groups: Vec<&[u128]> = chunk.chunks(GROUP).collect();
        let mut body = Vec::new();
        varint(&mut body, chunk.len() as u128);
        for pair in groups.windows(2) {
            varint(&mut body, pair[1][0] - pair[0][0]);
        }
        let held: Vec<Vec<u8>> = groups.iter().map(|group| run(group, host)).collect();
        for one in held.iter().take(held.len().saturating_sub(1)) {
            varint(&mut body, one.len() as u128);
        }
        for one in &held {
            body.extend_from_slice(one);
        }
        blocks.push(body);
    }
    (blocks, heads)
}

fn run(group: &[u128], host: u32) -> Vec<u8> {
    let mut out = Vec::new();
    for pair in group.windows(2) {
        varint(&mut out, (pair[1] >> host) - (pair[0] >> host));
    }
    if host > 0 {
        for value in group {
            varint(&mut out, value & u64::MAX as u128);
        }
    }
    out
}

fn boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn varint(out: &mut Vec<u8>, mut value: u128) {
    while value >= 0x80 {
        out.push(value as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// Blocks compressed against one trained dictionary, and the section they make.
#[allow(clippy::too_many_arguments)]
fn pack(
    name: String,
    blocks: Vec<Vec<u8>>,
    heads: Vec<u128>,
    width: usize,
    count: usize,
    block: usize,
    group: usize,
    encoding: &str,
    read: &str,
) -> Packed {
    let raw: usize = blocks.iter().map(|held| held.len()).sum();
    let book = trained(&blocks, raw);
    let stored = squeeze(&blocks, &book);
    let mut body = Vec::new();
    body.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
    body.extend_from_slice(&(width as u32).to_le_bytes());
    body.extend_from_slice(&(book.len() as u32).to_le_bytes());
    let mut at = 0u32;
    body.extend_from_slice(&at.to_le_bytes());
    for held in &stored {
        at += held.len() as u32;
        body.extend_from_slice(&at.to_le_bytes());
    }
    for head in &heads {
        body.extend_from_slice(&head.to_be_bytes()[16 - width..]);
    }
    body.extend_from_slice(&book);
    for held in &stored {
        body.extend_from_slice(held);
    }
    let entry = json!({
        "offset": 0,
        "bytes": 0,
        "count": count,
        "encoding": encoding,
        "block": block,
        "group": group,
        "read": read,
    });
    Packed { name, entry, raw, body }
}

/// A dictionary is bytes of its own, so it is kept only where it earns them back.
fn trained(blocks: &[Vec<u8>], raw: usize) -> Vec<u8> {
    if blocks.len() < 8 {
        return Vec::new();
    }
    let mut best = (weigh(blocks, &[]), Vec::new());
    let mut last = 0;
    for share in SHARES {
        let size = (raw / share).min(BOOK);
        if size < 1024 || size <= last {
            continue;
        }
        last = size;
        let Ok(book) = zstd::dict::from_samples(blocks, size) else {
            continue;
        };
        let cost = weigh(blocks, &book);
        if cost < best.0 {
            best = (cost, book);
        }
    }
    best.1
}

/// One block in every so many, packed for real: enough to rank two ways of packing.
fn weigh(blocks: &[Vec<u8>], book: &[u8]) -> usize {
    let step = (blocks.len() / PROBE).max(1);
    let sample: Vec<Vec<u8>> = blocks.iter().step_by(step).cloned().collect();
    let stored: usize = squeeze(&sample, book).iter().map(|held| held.len()).sum();
    stored * step + book.len()
}

fn squeeze(blocks: &[Vec<u8>], book: &[u8]) -> Vec<Vec<u8>> {
    if blocks.is_empty() {
        return Vec::new();
    }
    let threads =
        std::thread::available_parallelism().map(|held| held.get()).unwrap_or(4);
    let step = blocks.len().div_ceil(threads);
    let mut stored: Vec<Vec<u8>> = vec![Vec::new(); blocks.len()];
    std::thread::scope(|scope| {
        for (slot, share) in stored.chunks_mut(step).enumerate() {
            let start = slot * step;
            scope.spawn(move || {
                let mut press = match book.is_empty() {
                    true => zstd::bulk::Compressor::new(LEVEL),
                    false => zstd::bulk::Compressor::with_dictionary(LEVEL, book),
                }
                .expect("compressor");
                for (step, out) in share.iter_mut().enumerate() {
                    *out = press.compress(&blocks[start + step]).expect("compress");
                }
            });
        }
    });
    stored
}
