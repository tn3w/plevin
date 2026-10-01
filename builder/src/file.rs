//! The file: fixed blocks, one codec, and a header that says how to read them all.

use crate::Selection;
use crate::spine::{Part, Written};
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use xz2::stream::{LzmaOptions, Stream};
use xz2::write::XzEncoder;

const MAGIC: &[u8] = b"PLEVIN\0";
pub const FORMAT: u8 = 2;
pub const RAW: u8 = 3;
const PRESET: u32 = 9;
const WINDOW: u32 = 1 << 20;
const ALONE: usize = 13;
const PROBE: usize = 16;
const WIDTHS: [usize; 4] = [1, 2, 4, 8];
const VALUES: usize = 16384;
const KEYS: usize = 32768;
const GROUP: usize = 128;
const NAMES: usize = 4096;
const RUN: usize = 64;

type Tuning = [u32; 3];
const TUNINGS: [Tuning; 5] = [[3, 0, 0], [0, 0, 0], [0, 1, 1], [0, 2, 2], [0, 3, 3]];

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

pub fn write(path: &Path, format: u8, selection: &Selection, written: Written) -> Report {
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
                match name.starts_with("hosts") {
                    true => hosts[wide as usize] = count,
                    false => spine[wide as usize] += count,
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
            format,
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
    out.push(format);
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
    format: u8,
    selection: &Selection,
    fields: &[String],
    carries: [bool; 3],
    books: &[(&'static str, Vec<String>)],
    sections: &serde_json::Map<String, serde_json::Value>,
    length: usize,
) -> String {
    json!({
        "format": format,
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

pub fn today() -> String {
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

fn narrowest(values: &[i64], encoding: &'static str) -> (Vec<Vec<u8>>, &'static str) {
    let plain = numbers(values, encoding == "signed");
    let Some(stepped) = steps(values) else {
        return (plain, encoding);
    };
    match tuned(&stepped).1 < tuned(&plain).1 {
        true => (stepped, "delta"),
        false => (plain, encoding),
    }
}

fn numbers(values: &[i64], signed: bool) -> Vec<Vec<u8>> {
    values.chunks(VALUES).map(|chunk| array(chunk, signed)).collect()
}

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

fn coded(pool: &[String]) -> Vec<Vec<u8>> {
    pool.chunks(NAMES)
        .map(|chunk| {
            let mut block = Vec::new();
            indexed(&mut block, &chunk.chunks(RUN).map(group).collect::<Vec<_>>());
            block
        })
        .collect()
}

fn indexed(out: &mut Vec<u8>, groups: &[Vec<u8>]) {
    for held in groups.iter().take(groups.len().saturating_sub(1)) {
        varint(out, held.len() as u128);
    }
    for held in groups {
        out.extend_from_slice(held);
    }
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
        indexed(&mut body, &held);
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
    let (tuning, _) = tuned(&blocks);
    let stored = squeeze(&blocks, tuning);
    let mut body = Vec::new();
    body.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
    body.extend_from_slice(&(width as u32).to_le_bytes());
    let mut at = 0u32;
    body.extend_from_slice(&at.to_le_bytes());
    for held in &stored {
        at += held.len() as u32;
        body.extend_from_slice(&at.to_le_bytes());
    }
    for head in &heads {
        body.extend_from_slice(&head.to_be_bytes()[16 - width..]);
    }
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
        "lzma": tuning,
    });
    Packed { name, entry, raw, body }
}

fn tuned(blocks: &[Vec<u8>]) -> (Tuning, usize) {
    let step = (blocks.len() / PROBE).max(1);
    let sample: Vec<Vec<u8>> = blocks.iter().step_by(step).cloned().collect();
    TUNINGS
        .iter()
        .map(|tuning| {
            let stored: usize =
                squeeze(&sample, *tuning).iter().map(|held| held.len()).sum();
            (*tuning, stored * step)
        })
        .min_by_key(|(_, weight)| *weight)
        .unwrap()
}

fn squeeze(blocks: &[Vec<u8>], tuning: Tuning) -> Vec<Vec<u8>> {
    if blocks.is_empty() {
        return Vec::new();
    }
    let threads =
        std::thread::available_parallelism().map(|held| held.get()).unwrap_or(4);
    let step = blocks.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let workers: Vec<_> = blocks
            .chunks(step)
            .map(|share| {
                scope.spawn(move || {
                    share.iter().map(|block| lzma(block, tuning)).collect::<Vec<_>>()
                })
            })
            .collect();
        workers.into_iter().flat_map(|worker| worker.join().expect("worker")).collect()
    })
}

fn lzma(block: &[u8], [context, position, matches]: Tuning) -> Vec<u8> {
    let mut options = LzmaOptions::new_preset(PRESET).expect("preset");
    options
        .dict_size(WINDOW)
        .literal_context_bits(context)
        .literal_position_bits(position)
        .position_bits(matches);
    let stream = Stream::new_lzma_encoder(&options).expect("encoder");
    let mut encoder = XzEncoder::new_stream(Vec::new(), stream);
    encoder.write_all(block).expect("compress");
    encoder.finish().expect("compress").split_off(ALONE)
}
