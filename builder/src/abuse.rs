//! The feeds as data, folded into one record per span, per host and per ASN.

use crate::gazetteer::fold;
use crate::network::Systems;
use crate::read::{self, two};
use crate::{CATEGORIES, EVIDENCE, SERVICES, SPECIFIC, UNSEEN, word, worded};
use regex::Regex;
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Default)]
pub struct Source {
    pub name: String,
    pub provider: String,
    pub user: u8,
    pub service: u8,
    pub evidence: u8,
    pub risk: f32,
    pub network_risk: f32,
    pub group: u16,
    pub window: u16,
    pub weak: bool,
    pub anycast: bool,
    pub satellite: bool,
}

pub struct Carrier {
    pub mcc: u16,
    pub mnc: u16,
    pub country: [u8; 2],
    pub brand: String,
    pub operator: String,
}

struct Shape {
    at: usize,
    kind: String,
    pattern: String,
    scope: bool,
    suffix: u8,
}

#[derive(Default)]
pub struct Feeds {
    pub sources: Vec<Source>,
    pub asn: Vec<(u32, u16)>,
    pub spans: [Vec<(u128, u128, u16)>; 2],
    pub hosts: [Vec<(u128, u16)>; 2],
    pub users: HashMap<u32, u32>,
    pub classes: HashMap<u32, String>,
    pub names: HashMap<u32, String>,
    pub carriers: Vec<Carrier>,
    pub brands: HashMap<String, Vec<String>>,
    pub satellites: Vec<u32>,
}

#[derive(Default)]
struct Harvest {
    asn: Vec<(u32, u16)>,
    spans: [Vec<(u128, u128, u16)>; 2],
    hosts: [Vec<(u128, u16)>; 2],
}

#[derive(Clone, Default, PartialEq, Eq, Hash)]
pub struct Record {
    pub name: String,
    pub user_type: u8,
    pub service: u8,
    pub evidence: u8,
    pub anycast: u8,
    pub satellite: u8,
    pub risk: u8,
    pub last_seen: u16,
}

pub struct Records {
    pub rows: Vec<Record>,
    pub spans: [Vec<(u128, u32)>; 2],
    pub effective: [Vec<(u128, u32)>; 2],
    pub hosts: [Vec<(u128, u32)>; 2],
}

#[derive(Clone, Default)]
struct Folded {
    provider: String,
    user: u8,
    weak: bool,
    service: u8,
    evidence: u8,
    anycast: bool,
    satellite: bool,
    window: u16,
    risks: Vec<(u16, f32)>,
}

const PROXIES: &[(&str, &str)] = &[
    ("TOR", "tor_exit_node"),
    ("VPN", "anonymous_vpn"),
    ("RES", "residential_proxy"),
    ("PUB", "public_proxy"),
    ("WEB", "public_proxy"),
];

const USAGE: &[(&str, &str)] = &[
    ("DCH", "hosting"),
    ("SES", "hosting"),
    ("CDN", "cdn"),
    ("ISP", "residential"),
    ("MOB", "cellular"),
    ("EDU", "education"),
    ("GOV", "government"),
    ("MIL", "military"),
    ("COM", "business"),
    ("ORG", "non-profit"),
];

impl Feeds {
    pub fn read(inputs: &Path) -> Feeds {
        let operators = read::data("operators.json");
        let listed = read::data("feeds.json");
        let mut feeds = Feeds::default();
        for (kind, names) in operators["brands"].as_object().into_iter().flatten() {
            let held = names.as_array().into_iter().flatten();
            let brands = held.filter_map(|name| name.as_str()).map(fold).collect();
            feeds.brands.insert(kind.clone(), brands);
        }
        for asn in operators["satellite_asns"].as_array().into_iter().flatten() {
            feeds.satellites.push(asn.as_u64().unwrap_or(0) as u32);
        }
        let mut groups: HashMap<String, u16> = HashMap::new();
        let mut shapes: Vec<Shape> = Vec::new();
        for entry in listed.as_array().into_iter().flatten() {
            let text = |name: &str| entry[name].as_str().unwrap_or("").to_string();
            let number = |name: &str| entry[name].as_f64().unwrap_or(0.0);
            let flags = entry["flags"].as_array().cloned().unwrap_or_default();
            let marked =
                |name: &str| flags.iter().any(|held| held.as_str() == Some(name));
            let named = text("group");
            let next = groups.len() as u16 + 1;
            feeds.sources.push(Source {
                name: text("name"),
                provider: text("provider"),
                user: word(CATEGORIES, &text("user")),
                service: word(SERVICES, &text("service")),
                evidence: word(EVIDENCE, &text("evidence")),
                risk: number("risk") as f32,
                network_risk: number("network_risk") as f32,
                group: match named.is_empty() {
                    true => 0,
                    false => *groups.entry(named).or_insert(next),
                },
                window: number("window") as u16,
                weak: entry["weak"].as_bool().unwrap_or(false),
                anycast: marked("is_anycast"),
                satellite: marked("is_satellite"),
            });
            shapes.push(Shape {
                at: feeds.sources.len() - 1,
                kind: text("format"),
                pattern: text("regex"),
                scope: entry["scope"].as_str() == Some("asn"),
                suffix: entry["suffix"].as_u64().unwrap_or(0) as u8,
            });
        }
        feeds.gather(inputs, &shapes);
        feeds
    }

    fn gather(&mut self, inputs: &Path, shapes: &[Shape]) {
        let matched: Vec<&Shape> =
            shapes.iter().filter(|held| held.kind.is_empty()).collect();
        let threads =
            std::thread::available_parallelism().map(|held| held.get()).unwrap_or(4);
        let sources = &self.sources;
        let harvested: Vec<Harvest> = std::thread::scope(|scope| {
            let running: Vec<_> = (0..threads)
                .map(|slot| {
                    let mine: Vec<&Shape> =
                        matched.iter().skip(slot).step_by(threads).copied().collect();
                    scope.spawn(move || reap(inputs, sources, &mine))
                })
                .collect();
            running.into_iter().map(|held| held.join().unwrap()).collect()
        });
        for held in harvested {
            self.asn.extend(held.asn);
            for family in 0..2 {
                self.spans[family].extend(&held.spans[family]);
                self.hosts[family].extend(&held.hosts[family]);
            }
        }
        for shape in shapes.iter().filter(|held| !held.kind.is_empty()) {
            self.shaped(inputs, shape);
        }
    }

    fn shaped(&mut self, inputs: &Path, shape: &Shape) {
        let path = inputs.join(&self.sources[shape.at].name);
        match shape.kind.as_str() {
            "iptoasn" => self.iptoasn(&path),
            "asns" => self.asns(&path),
            "aspop" => self.aspop(&path),
            "mccmnc" => self.mccmnc(&path),
            "mcctable" => self.mcctable(&path),
            "px11" => self.proxies(&path, shape.at),
            "ipsum" => self.ipsum(&path, shape.at),
            other => eprintln!("unknown format {other}"),
        }
    }

    fn iptoasn(&mut self, path: &Path) {
        for line in read::slurp(path).lines() {
            let row: Vec<&str> = line.split('\t').collect();
            if row.len() > 4 && row[4] != "Not routed" {
                let asn = row[2].parse().unwrap_or(0);
                self.names.entry(asn).or_insert_with(|| row[4].to_string());
            }
        }
    }

    fn asns(&mut self, path: &Path) {
        for line in read::slurp(path).lines().skip(1) {
            let row = read::row(line);
            if row.len() < 4 {
                continue;
            }
            let asn = row[0].trim_start_matches("AS").parse().unwrap_or(0);
            if asn > 0 {
                self.classes.insert(asn, row[2].clone());
            }
        }
    }

    fn aspop(&mut self, path: &Path) {
        let listed: serde_json::Value =
            serde_json::from_str(&read::slurp(path)).unwrap_or_default();
        for row in listed["Data"].as_array().into_iter().flatten() {
            let asn = row["AS"].as_u64().unwrap_or(0) as u32;
            self.users.insert(asn, row["Users"].as_u64().unwrap_or(0) as u32);
        }
    }

    fn mccmnc(&mut self, path: &Path) {
        let listed: serde_json::Value =
            serde_json::from_str(&read::slurp(path)).unwrap_or_default();
        for row in listed.as_array().into_iter().flatten() {
            let text = |name: &str| row[name].as_str().unwrap_or("");
            let code = text("countryCode");
            self.carriers.push(Carrier {
                mcc: text("mcc").parse().unwrap_or(0),
                mnc: text("mnc").parse().unwrap_or(0),
                country: two(&code[..code.len().min(2)]),
                brand: fold(text("brand")),
                operator: fold(text("operator")),
            });
        }
    }

    fn mcctable(&mut self, path: &Path) {
        for line in read::slurp(path).lines().skip(1) {
            let row = read::row(line);
            if row.len() < 8 {
                continue;
            }
            self.carriers.push(Carrier {
                mcc: row[0].parse().unwrap_or(0),
                mnc: row[2].parse().unwrap_or(0),
                country: two(&row[4].to_uppercase()),
                brand: String::new(),
                operator: fold(&row[7]),
            });
        }
    }

    /// A proxy database naming its own service and provider, so every row is a source.
    fn proxies(&mut self, path: &Path, at: usize) {
        let body = read::slurp(path);
        let mut minted: HashMap<(u8, u8, u16, String), u16> = HashMap::new();
        for line in body.lines() {
            let row: Vec<&str> = line.trim_matches('"').split("\",\"").collect();
            if row.len() < 15 {
                continue;
            }
            let Ok(first) = row[0].parse::<u128>() else { continue };
            let Ok(last) = row[1].parse::<u128>() else { continue };
            let held = PROXIES.iter().find(|(code, _)| *code == row[2]);
            let usage = USAGE.iter().find(|(code, _)| *code == row[9]);
            let key = (
                word(SERVICES, held.map(|(_, name)| *name).unwrap_or("")),
                word(CATEGORIES, usage.map(|(_, name)| *name).unwrap_or("")),
                window(row[12].parse().unwrap_or(0)),
                row[14].to_string(),
            );
            let source = *minted.entry(key.clone()).or_insert_with(|| {
                let held = Source {
                    service: key.0,
                    user: key.1,
                    window: key.2,
                    provider: match key.3.as_str() {
                        "-" => String::new(),
                        named => named.to_string(),
                    },
                    evidence: word(EVIDENCE, "reported"),
                    ..self.sources[at].clone()
                };
                self.sources.push(held);
                self.sources.len() as u16 - 1
            });
            let (first, last) = (mapped(first), mapped(last));
            let wide = first > u32::MAX as u128;
            match first == last {
                true => self.hosts[wide as usize].push((first, source)),
                false => self.spans[wide as usize].push((first, last, source)),
            }
        }
    }

    /// The count of lists an address is on, which is the risk this feed asserts.
    fn ipsum(&mut self, path: &Path, at: usize) {
        let body = read::slurp(path);
        let mut minted: HashMap<u16, u16> = HashMap::new();
        for line in body.lines().filter(|line| !line.starts_with('#')) {
            let Some((address, count)) = line.split_once('\t') else { continue };
            let Some((first, _, wide)) = read::span(address) else { continue };
            let listed: u16 = count.trim().parse().unwrap_or(1);
            let source = *minted.entry(listed).or_insert_with(|| {
                let held = Source {
                    risk: (listed.min(10) as f32) / 10.0,
                    evidence: word(EVIDENCE, "reported"),
                    ..self.sources[at].clone()
                };
                self.sources.push(held);
                self.sources.len() as u16 - 1
            });
            self.hosts[wide as usize].push((first, source));
        }
    }
}

/// A feed reporting days since it last saw an address declares the window it kept.
fn window(days: u16) -> u16 {
    *WINDOWS.iter().find(|held| **held >= days).unwrap_or(WINDOWS.last().unwrap())
}

const WINDOWS: &[u16] = &[1, 3, 7, 14, 30, 60, 90, 120, 180, 365];

/// IP2Proxy writes v4 addresses inside the v6 space, which is not where they answer.
fn mapped(value: u128) -> u128 {
    match value >> 32 == 0xFFFF {
        true => value & 0xFFFF_FFFF,
        false => value,
    }
}

fn reap(inputs: &Path, sources: &[Source], mine: &[&Shape]) -> Harvest {
    let mut found = Harvest::default();
    for shape in mine {
        let Ok(hunting) = Regex::new(&format!("(?m){}", shape.pattern)) else {
            eprintln!("bad regex in {}", sources[shape.at].name);
            continue;
        };
        let body = read::slurp(&inputs.join(&sources[shape.at].name));
        for caught in hunting.captures_iter(&body) {
            let Some(held) = caught.get(1).or_else(|| caught.get(0)) else { continue };
            if shape.scope {
                if let Ok(asn) = held.as_str().parse::<u32>() {
                    found.asn.push((asn, shape.at as u16));
                }
                continue;
            }
            let text = match shape.suffix {
                0 => held.as_str().to_string(),
                bits => format!("{}/{bits}", held.as_str()),
            };
            let Some((first, last, wide)) = read::span(&text) else { continue };
            match first == last {
                true => found.hosts[wide as usize].push((first, shape.at as u16)),
                false => found.spans[wide as usize].push((first, last, shape.at as u16)),
            }
        }
    }
    found
}

struct Pool {
    rows: Vec<Record>,
    index: HashMap<Record, u32>,
}

impl Pool {
    fn new() -> Pool {
        let empty = Record { risk: UNSEEN, ..Record::default() };
        Pool { rows: vec![empty.clone()], index: HashMap::from([(empty, 0)]) }
    }

    fn intern(&mut self, folded: &Folded) -> u32 {
        let record = folded.record();
        match self.index.get(&record) {
            Some(at) => *at,
            None => {
                self.rows.push(record.clone());
                let at = self.rows.len() as u32 - 1;
                self.index.insert(record, at);
                at
            }
        }
    }

    /// A record link, which is absence where the record says nothing at all.
    fn link(&mut self, folded: &Folded) -> u32 {
        match self.intern(folded) {
            0 => 0,
            at => at + 1,
        }
    }
}

impl Folded {
    fn take(&mut self, claim: &Source) {
        if claim.user > 0 && (self.user == 0 || (self.weak && !claim.weak)) {
            self.user = claim.user;
            self.weak = claim.weak;
        }
        if claim.service > 0 && self.stronger(claim.evidence, claim.service) {
            self.service = claim.service;
            self.evidence = claim.evidence;
            self.provider = claim.provider.clone();
        }
        self.anycast |= claim.anycast;
        self.satellite |= claim.satellite;
        if claim.window > 0 && (self.window == 0 || claim.window < self.window) {
            self.window = claim.window;
        }
        if claim.risk > 0.0 {
            self.risk(claim.group, claim.risk);
        }
    }

    fn absorb(&mut self, other: &Folded) {
        if other.user > 0 && (self.user == 0 || (self.weak && !other.weak)) {
            self.user = other.user;
            self.weak = other.weak;
        }
        if other.service > 0 && self.stronger(other.evidence, other.service) {
            self.service = other.service;
            self.evidence = other.evidence;
            self.provider = other.provider.clone();
        }
        self.anycast |= other.anycast;
        self.satellite |= other.satellite;
        if other.window > 0 && (self.window == 0 || other.window < self.window) {
            self.window = other.window;
        }
        for (group, risk) in &other.risks {
            self.risk(*group, *risk);
        }
    }

    /// Feeds sharing an upstream count once, so risk takes the most of a group.
    fn risk(&mut self, group: u16, risk: f32) {
        match self.risks.iter_mut().find(|(held, _)| *held == group) {
            Some(held) if group != 0 => held.1 = held.1.max(risk),
            _ => self.risks.push((group, risk)),
        }
    }

    /// Best evidence first, then the more specific service of the two.
    fn stronger(&self, evidence: u8, service: u8) -> bool {
        if self.service == 0 {
            return true;
        }
        let rank = |service: u8| {
            SPECIFIC
                .iter()
                .position(|held| *held == SERVICES[service as usize])
                .unwrap_or(9)
        };
        (evidence, rank(service)) < (self.evidence, rank(self.service))
    }

    fn record(&self) -> Record {
        let left = self.risks.iter().fold(1.0f32, |held, (_, risk)| held * (1.0 - risk));
        Record {
            name: self.provider.clone(),
            user_type: self.user,
            service: self.service,
            evidence: self.evidence,
            anycast: self.anycast as u8,
            satellite: self.satellite as u8,
            risk: match self.risks.is_empty() {
                true => UNSEEN,
                false => ((1.0 - left) * 100.0).round() as u8,
            },
            last_seen: self.window,
        }
    }
}

impl Records {
    pub fn fold(feeds: &Feeds, systems: &mut Systems) -> Records {
        let mut pool = Pool::new();
        let mut folded: HashMap<u32, Folded> = HashMap::new();
        for (asn, source) in &feeds.asn {
            folded.entry(*asn).or_default().take(&feeds.sources[*source as usize]);
        }
        let inferred = [
            (word(SERVICES, "anonymous_vpn"), feeds.brands.get("vpn")),
            (word(SERVICES, "residential_proxy"), feeds.brands.get("residential_proxy")),
        ];
        for system in &mut systems.rows {
            let mut held = folded.get(&system.asn).cloned().unwrap_or_default();
            let name = fold(&format!("{} {}", system.handle, system.company));
            for (service, brands) in &inferred {
                let listed = brands.map(|held| held.as_slice()).unwrap_or_default();
                if listed.iter().any(|brand| worded(&name, brand)) {
                    held.take(&Source {
                        service: *service,
                        evidence: word(EVIDENCE, "inferred"),
                        ..Source::default()
                    });
                }
            }
            held.satellite |= system.satellite != 0;
            if system.network_risk != UNSEEN {
                held.risk(0, system.network_risk as f32 / 100.0);
            }
            system.record = pool.link(&held);
        }
        drop(folded);
        let mut spans = [Vec::new(), Vec::new()];
        let mut effective = [Vec::new(), Vec::new()];
        let mut hosts = [Vec::new(), Vec::new()];
        for family in 0..2 {
            let ceiling = if family == 1 { u128::MAX } else { u32::MAX as u128 };
            let sweep = overlay(&feeds.spans[family], &feeds.sources, ceiling);
            let (runs, whole) = carried(&sweep, systems, &mut pool, family);
            hosts[family] = single(&feeds.hosts[family], feeds, &whole, &mut pool);
            effective[family] = whole.iter().map(|(at, _, row)| (*at, *row)).collect();
            spans[family] = runs;
        }
        Records { rows: pool.rows, spans, effective, hosts }
    }
}

/// The boundaries a family stores, and the host records that fall through them.
type Carried = (Vec<(u128, u32)>, Vec<(u128, Folded, u32)>);

/// What each boundary stores, and the record the address answers once it falls through.
fn carried(
    sweep: &[(u128, Folded)],
    systems: &Systems,
    pool: &mut Pool,
    family: usize,
) -> Carried {
    let mut runs: Vec<(u128, u32)> = Vec::new();
    let mut whole: Vec<(u128, Folded, u32)> = Vec::new();
    together(sweep, &systems.runs[family], |at, held, route| {
        let system = systems.rows.get(route.system.wrapping_sub(1) as usize);
        let row = pool.intern(held);
        let falls = system.map(|held| held.record).unwrap_or(0);
        let link = match row {
            0 => 0,
            at => at + 1,
        };
        let stored = match link == falls {
            true => 0,
            false => link,
        };
        let answer = match stored {
            0 => falls.saturating_sub(1),
            _ => row,
        };
        match runs.last() {
            Some((_, last)) if *last == stored => {}
            _ => runs.push((at, stored)),
        }
        match whole.last() {
            Some((_, _, last)) if *last == answer => {}
            _ => whole.push((at, held.clone(), answer)),
        }
    });
    (runs, whole)
}

/// One row per address a feed names on its own, where it says more than its span does.
fn single(
    claims: &[(u128, u16)],
    feeds: &Feeds,
    whole: &[(u128, Folded, u32)],
    pool: &mut Pool,
) -> Vec<(u128, u32)> {
    let mut held: Vec<(u128, u16)> = claims.to_vec();
    held.sort_unstable();
    let mut out: Vec<(u128, u32)> = Vec::new();
    let mut at = 0;
    while at < held.len() {
        let address = held[at].0;
        let mut folded = Folded::default();
        while at < held.len() && held[at].0 == address {
            folded.take(&feeds.sources[held[at].1 as usize]);
            at += 1;
        }
        let spot = whole.partition_point(|(start, _, _)| *start <= address);
        let standing = match spot {
            0 => 0,
            spot => {
                folded.absorb(&whole[spot - 1].1);
                whole[spot - 1].2
            }
        };
        let row = pool.intern(&folded);
        if row != standing {
            out.push((address, row));
        }
    }
    out
}

/// Every claim over a span, folded where the set of claims covering it changes.
fn overlay(
    claims: &[(u128, u128, u16)],
    sources: &[Source],
    ceiling: u128,
) -> Vec<(u128, Folded)> {
    let mut events: Vec<(u128, bool, u16)> = Vec::with_capacity(claims.len() * 2);
    for (first, last, source) in claims {
        events.push((*first, true, *source));
        if *last < ceiling {
            events.push((*last + 1, false, *source));
        }
    }
    events.sort_unstable();
    let mut active: Vec<u16> = Vec::new();
    let mut runs: Vec<(u128, Folded)> = vec![(0, Folded::default())];
    let mut at = 0;
    while at < events.len() {
        let here = events[at].0;
        while at < events.len() && events[at].0 == here {
            let (_, opening, source) = events[at];
            match (opening, active.iter().position(|held| *held == source)) {
                (true, _) => active.push(source),
                (false, Some(spot)) => {
                    active.swap_remove(spot);
                }
                (false, None) => {}
            }
            at += 1;
        }
        let mut held = Folded::default();
        for source in &active {
            held.take(&sources[*source as usize]);
        }
        runs.push((here, held));
    }
    runs
}

/// Two run lists read as one, so a boundary in either is a boundary in both.
pub fn together<A, B: Copy + Default>(
    one: &[(u128, A)],
    other: &[(u128, B)],
    mut each: impl FnMut(u128, &A, B),
) {
    let (mut here, mut there) = (0usize, 0usize);
    let mut at = 0u128;
    loop {
        while here + 1 < one.len() && one[here + 1].0 <= at {
            here += 1;
        }
        while there + 1 < other.len() && other[there + 1].0 <= at {
            there += 1;
        }
        let standing = other.get(there).map(|held| held.1).unwrap_or_default();
        if let Some((_, held)) = one.get(here) {
            each(at, held, standing);
        }
        let next = [
            one.get(here + 1).map(|held| held.0),
            other.get(there + 1).map(|held| held.0),
        ];
        match next.into_iter().flatten().min() {
            Some(step) => at = step,
            None => return,
        }
    }
}
