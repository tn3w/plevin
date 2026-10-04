//! Who announces each span, and everything known about that operator.

use crate::abuse::{Feeds, together};
use crate::derive::{Rules, host};
use crate::gazetteer::{Gazetteer, fold};
use crate::read::{self, Announce, two};
use crate::{CATEGORIES, RIRS, UNSEEN, ceiling, push_changed, word, worded};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Default)]
pub struct System {
    pub asn: u32,
    pub handle: String,
    pub company: String,
    pub alias: String,
    pub website: String,
    pub cone: u32,
    pub tier: u8,
    pub peering: u16,
    pub scope: String,
    pub rir: String,
    pub since: u16,
    pub street: String,
    pub state: String,
    pub postal: String,
    pub abuse_email: String,
    pub users: u32,
    pub mcc: u16,
    pub mnc: u16,
    pub network_risk: u8,
    pub satellite: u8,
    pub category: u8,
    pub country: u32,
    pub city: u32,
    pub record: u32,
}

#[derive(Clone, Copy, Default, PartialEq)]
pub struct Route {
    pub system: u32,
    pub prefix: u8,
    pub rpki: u8,
    pub roas: u16,
    pub rir: u8,
    pub country: u16,
    pub since: u16,
}

#[derive(Clone, Copy, Default, PartialEq)]
pub struct Block {
    pub rir: u8,
    pub prefix: u8,
    pub country: u16,
    pub since: u16,
}

pub struct Systems {
    pub rows: Vec<System>,
    pub index: HashMap<u32, u32>,
    pub runs: [Vec<(u128, Route)>; 2],
}

const KINDS: &[(&str, &str)] = &[
    ("NSP", "transit"),
    ("Content", "content"),
    ("Cable/DSL/ISP", "residential"),
    ("Enterprise", "business"),
    ("Educational/Research", "education"),
    ("Non-Profit", "non-profit"),
    ("Government", "government"),
    ("Route Server", "infrastructure"),
    ("Route Collector", "infrastructure"),
    ("Network Services", "infrastructure"),
];

const FIRST_REGISTRY_YEAR: u16 = 1980;

const CLASSES: &[(&str, &str)] =
    &[("Eyeball", "residential"), ("Content", "content"), ("Carrier", "transit")];

impl Systems {
    pub fn read(inputs: &Path, gazetteer: &Gazetteer, feeds: &Feeds) -> Systems {
        let announced = read::announcements(&inputs.join("bview"));
        let mut seen: HashSet<u32> = HashSet::new();
        let mut rows: Vec<System> = Vec::new();
        for span in &announced {
            if seen.insert(span.asn) {
                rows.push(System {
                    asn: span.asn,
                    network_risk: UNSEEN,
                    ..System::default()
                });
            }
        }
        rows.sort_by_key(|system| system.asn);
        let index =
            rows.iter().enumerate().map(|(at, held)| (held.asn, at as u32 + 1)).collect();
        let mut systems = Systems { rows, index, runs: [Vec::new(), Vec::new()] };
        systems.registries(inputs, gazetteer);
        systems.ranks(inputs);
        systems.peers(inputs, gazetteer, &feeds.rules);
        systems.lacnic(inputs, gazetteer);
        systems.tidy(&feeds.rules);
        systems.habits(feeds, gazetteer);
        systems.routes(inputs, gazetteer, announced);
        systems.tidy(&feeds.rules);
        systems
    }

    fn tidy(&mut self, rules: &Rules) {
        for system in &mut self.rows {
            system.company = rules.tidy(&system.company);
            system.handle = rules.tidy(&system.handle);
            system.street = rules.tidy(&system.street);
            system.state = rules.tidy(&system.state);
            system.postal = rules.tidy(&system.postal);
            system.abuse_email = rules.mailbox(&system.abuse_email);
            if system.postal.chars().all(|point| point == '0' || point == '-') {
                system.postal.clear();
            }
            if system.since < FIRST_REGISTRY_YEAR {
                system.since = 0;
            }
        }
    }

    fn at(&mut self, asn: u32) -> Option<&mut System> {
        let at = *self.index.get(&asn)?;
        self.rows.get_mut(at as usize - 1)
    }

    fn registries(&mut self, inputs: &Path, gazetteer: &Gazetteer) {
        for line in read::slurp(&inputs.join("nro-delegated-stats")).lines() {
            let row: Vec<&str> = line.split('|').collect();
            if row.len() < 7 || row[2] != "asn" || row[6] != "assigned" {
                continue;
            }
            let first: u32 = row[3].parse().unwrap_or(0);
            let count: u32 = row[4].parse().unwrap_or(0);
            for asn in first..first.saturating_add(count) {
                let country = gazetteer.country(two(row[1]));
                let rir = row[0].to_string();
                let since = row[5][..4].parse().unwrap_or(0);
                if let Some(system) = self.at(asn) {
                    system.country = country;
                    system.rir = rir;
                    system.since = since;
                }
            }
        }
        for line in read::slurp(&inputs.join("asn.txt")).lines() {
            let Some((asn, rest)) = line.split_once(' ') else { continue };
            let Ok(asn) = asn.parse::<u32>() else { continue };
            let body = match rest.rsplit_once(", ") {
                Some((body, code)) if code.len() == 2 => body,
                _ => rest,
            };
            let (handle, tail) = match body.split_once(" - ") {
                Some(pair) => pair,
                None => body.split_once(' ').unwrap_or((body, "")),
            };
            if let Some(system) = self.at(asn) {
                system.handle = handle.to_string();
                if !addressed(tail) {
                    system.company = tail.to_string();
                }
            }
        }
        let mut orgs: HashMap<String, String> = HashMap::new();
        let mut named: Vec<(u32, String, String, String)> = Vec::new();
        for line in read::slurp(&inputs.join("as-org2info.txt")).lines() {
            let row: Vec<&str> = line.split('|').collect();
            match (line.starts_with('#'), row.len()) {
                (true, _) => continue,
                (_, 5) => {
                    orgs.insert(row[0].to_string(), row[2].to_string());
                }
                (_, 6) => match row[0].parse::<u32>() {
                    Ok(asn) => named.push((
                        asn,
                        row[3].to_string(),
                        row[2].to_string(),
                        registry(row[5]).to_string(),
                    )),
                    Err(_) => continue,
                },
                _ => continue,
            }
        }
        for (asn, org, handle, rir) in named {
            let company = orgs
                .get(&org)
                .filter(|held| !held.is_empty() && !addressed(held))
                .cloned();
            let Some(system) = self.at(asn) else { continue };
            if let Some(company) = company {
                system.company = company;
            }
            if system.handle.is_empty() {
                system.handle = handle;
            }
            if system.rir.is_empty() {
                system.rir = rir;
            }
        }
        self.graph(inputs);
        for line in read::slurp(&inputs.join("abuse-contacts.tsv")).lines() {
            let Some((asn, mailbox)) = line.split_once('\t') else { continue };
            let Ok(asn) = asn.parse::<u32>() else { continue };
            if let Some(system) = self.at(asn) {
                system.abuse_email = mailbox.trim().to_string();
            }
        }
    }

    fn graph(&mut self, inputs: &Path) {
        let mut sells: HashSet<u32> = HashSet::new();
        let mut buys: HashSet<u32> = HashSet::new();
        for line in read::slurp(&inputs.join("as-rel2.txt")).lines() {
            let row: Vec<&str> = line.split('|').collect();
            if line.starts_with('#') || row.len() < 3 || row[2] != "-1" {
                continue;
            }
            if let (Ok(one), Ok(other)) = (row[0].parse::<u32>(), row[1].parse::<u32>()) {
                sells.insert(one);
                buys.insert(other);
            }
        }
        for system in &mut self.rows {
            system.tier = match (sells.contains(&system.asn), buys.contains(&system.asn))
            {
                (true, false) => 1,
                (true, true) => 2,
                (false, true) => 3,
                (false, false) => 0,
            };
        }
    }

    fn ranks(&mut self, inputs: &Path) {
        for line in read::slurp(&inputs.join("asrank")).lines() {
            let row: Vec<&str> = line.split('\t').collect();
            let [asn, cone, exchange] = row[..] else { continue };
            let Ok(asn) = asn.parse::<u32>() else { continue };
            let Some(system) = self.at(asn) else { continue };
            system.cone = cone.parse().unwrap_or(0);
            if exchange == "1" {
                system.category = word(CATEGORIES, "exchange");
            }
        }
    }

    fn peers(&mut self, inputs: &Path, gazetteer: &Gazetteer, rules: &Rules) {
        let nets = read::slurp(&inputs.join("peeringdb_net.json"));
        let orgs = read::slurp(&inputs.join("peeringdb_org.json"));
        let links = read::slurp(&inputs.join("peeringdb_netixlan.json"));
        let nets: serde_json::Value = serde_json::from_str(&nets).unwrap_or_default();
        let orgs: serde_json::Value = serde_json::from_str(&orgs).unwrap_or_default();
        let links: serde_json::Value = serde_json::from_str(&links).unwrap_or_default();
        let none = Vec::new();
        let mut exchanges: HashMap<u32, HashSet<i64>> = HashMap::new();
        for row in links["data"].as_array().unwrap_or(&none) {
            let asn = row["asn"].as_i64().unwrap_or(0) as u32;
            exchanges.entry(asn).or_default().insert(row["ix_id"].as_i64().unwrap_or(0));
        }
        let mut places: HashMap<i64, &serde_json::Value> = HashMap::new();
        for row in orgs["data"].as_array().unwrap_or(&none) {
            places.insert(row["id"].as_i64().unwrap_or(0), row);
        }
        for row in nets["data"].as_array().unwrap_or(&none) {
            let asn = row["asn"].as_i64().unwrap_or(0) as u32;
            let peering = exchanges.get(&asn).map(|held| held.len()).unwrap_or(0) as u16;
            let kind = row["info_type"].as_str().unwrap_or("");
            let category = KINDS.iter().find(|(held, _)| *held == kind);
            let scope = match row["info_scope"].as_str().unwrap_or("") {
                "Not Disclosed" => "",
                held => held,
            };
            let org = places.get(&row["org_id"].as_i64().unwrap_or(0)).copied();
            let text = |name: &str| {
                org.map(|held| held[name].as_str().unwrap_or(""))
                    .unwrap_or("")
                    .to_string()
            };
            let code = two(&text("country"));
            let state = text("state");
            let city = gazetteer.town_in(&text("city"), &state, code);
            let country = gazetteer.country(code);
            let street = text("address1");
            let postal = text("zipcode");
            let website = match row["website"].as_str().unwrap_or("").trim() {
                "" => rules.site(&text("website")),
                held => rules.site(held),
            };
            let company = text("name");
            let net = |name: &str| row[name].as_str().unwrap_or("").to_string();
            let alias = format!("{} {} {}", net("name"), net("aka"), net("name_long"));
            let Some(system) = self.at(asn) else { continue };
            system.alias = fold(&alias);
            system.peering = peering;
            system.scope = scope.to_string();
            system.website = website;
            system.street = street;
            system.state = state;
            system.postal = postal;
            if let Some((_, name)) = category {
                system.category = word(CATEGORIES, name);
            }
            if country != 0 {
                system.country = country;
                system.city = city;
            }
            if system.company.is_empty() {
                system.company = company;
            }
        }
    }

    fn lacnic(&mut self, inputs: &Path, gazetteer: &Gazetteer) {
        let raw = read::raw(&inputs.join("lacnic_db"));
        let body: String = raw.iter().map(|byte| *byte as char).collect();
        for object in body.split("\n\n") {
            let field = |key: &str| {
                let found = object.lines().find_map(|line| line.strip_prefix(key));
                found.unwrap_or("").trim()
            };
            let Ok(asn) = field("aut-num:").parse::<u32>() else { continue };
            let code = two(field("country:"));
            let city = gazetteer.town(field("city:"), code);
            let Some(system) = self.at(asn).filter(|held| held.city == 0) else {
                continue;
            };
            system.city = city;
            if system.country == 0 {
                system.country = gazetteer.country(code);
            }
        }
    }

    fn habits(&mut self, feeds: &Feeds, gazetteer: &Gazetteer) {
        for (asn, users) in &feeds.users {
            if let Some(system) = self.at(*asn) {
                system.users = *users;
            }
        }
        for (asn, domains) in &feeds.domains {
            let Some(system) = self.at(*asn).filter(|held| held.website.is_empty())
            else {
                continue;
            };
            let common = domains.iter().max_by_key(|(domain, count)| (*count, *domain));
            if let Some((domain, _)) = common {
                system.website = domain.clone();
            }
        }
        for (asn, class) in &feeds.classes {
            let named = CLASSES.iter().find(|(held, _)| held == class);
            if let (Some((_, name)), Some(system)) = (named, self.at(*asn))
                && system.category == 0
            {
                system.category = word(CATEGORIES, name);
            }
        }
        for (asn, source) in &feeds.asn {
            let claim = &feeds.sources[*source as usize];
            let Some(system) = self.at(*asn) else { continue };
            let held = system.category;
            let looser = feeds
                .rules
                .beats(CATEGORIES[claim.user as usize], CATEGORIES[held as usize]);
            if claim.user > 0 && (held == 0 || (looser && !claim.weak)) {
                system.category = claim.user;
            }
            system.satellite |= claim.satellite as u8;
            if claim.network_risk > 0.0 {
                let held = match system.network_risk {
                    UNSEEN => 0.0,
                    value => value as f32 / 100.0,
                };
                let joined = 1.0 - (1.0 - held) * (1.0 - claim.network_risk);
                system.network_risk = (joined * 100.0).round() as u8;
            }
        }
        for asn in &feeds.satellites {
            if let Some(system) = self.at(*asn) {
                system.satellite = 1;
            }
        }
        let brands: Vec<String> =
            feeds.brands.get("satellite").cloned().unwrap_or_default();
        for system in &mut self.rows {
            let name = fold(&format!("{} {}", system.handle, system.company));
            if brands.iter().any(|brand| worded(&name, brand)) {
                system.satellite = 1;
            }
        }
        for system in &mut self.rows {
            let host = host(&system.website, &system.abuse_email);
            let guess = feeds.rules.guess(
                &system.handle,
                &system.company,
                &host,
                system.users,
                system.tier,
            );
            if system.category == 0 {
                system.category = guess;
            }
        }
        self.carriers(feeds, gazetteer);
    }

    fn carriers(&mut self, feeds: &Feeds, gazetteer: &Gazetteer) {
        let cellular = word(CATEGORIES, "cellular");
        let residential = word(CATEGORIES, "residential");
        let mut codes: HashMap<u32, HashSet<u16>> = HashMap::new();
        for carrier in &feeds.carriers {
            let country = gazetteer.country(carrier.country);
            codes.entry(country).or_default().insert(carrier.mcc);
        }
        for system in &mut self.rows {
            let mobile = system.category == cellular;
            let eyeball = mobile || system.category == residential;
            if !eyeball || system.country == 0 || (!mobile && system.users == 0) {
                continue;
            }
            let name =
                fold(&format!("{} {} {}", system.handle, system.company, system.alias));
            let mut seen: HashSet<(u16, u16)> = HashSet::new();
            for carrier in &feeds.carriers {
                if gazetteer.country(carrier.country) != system.country {
                    continue;
                }
                if worded(&name, &carrier.brand) || worded(&name, &carrier.operator) {
                    seen.insert((carrier.mcc, carrier.mnc));
                }
            }
            let mut by_code: HashMap<u16, Vec<u16>> = HashMap::new();
            for (mcc, mnc) in seen {
                by_code.entry(mcc).or_default().push(mnc);
            }
            let best = by_code
                .iter()
                .max_by_key(|(mcc, mncs)| (mncs.len(), std::cmp::Reverse(**mcc)));
            if let Some((mcc, mncs)) = best {
                system.mcc = *mcc;
                system.mnc = if let [only] = mncs[..] { only } else { 0 };
                continue;
            }
            let sole = codes.get(&system.country).filter(|held| held.len() == 1);
            if let (true, Some(held)) = (mobile, sole) {
                system.mcc = held.iter().copied().next().unwrap_or(0);
            }
        }
    }

    fn routes(&mut self, inputs: &Path, gazetteer: &Gazetteer, announced: Vec<Announce>) {
        let roas = Roas::read(inputs);
        let allocated = allocations(inputs, gazetteer);
        let mut announces: [Vec<(u128, Route)>; 2] = [Vec::new(), Vec::new()];
        for (family, wide) in [(0, false), (1, true)] {
            let mut spans: Vec<(u128, u128, u8, u32)> = announced
                .iter()
                .filter(|span| span.wide == wide && span.length >= WIDEST_ROUTE[family])
                .map(|span| {
                    let spare = if wide { 128 } else { 32 } - span.length as u32;
                    (span.first, span.first | read::fill(spare), span.length, span.asn)
                })
                .collect();
            announces[family] =
                runs_of(&mut spans, ceiling(family), |at, asn, length| match asn {
                    0 => Route::default(),
                    _ => {
                        let (rpki, count) = roas.verdict(at, length, asn, wide);
                        Route {
                            system: self.index.get(&asn).copied().unwrap_or(0),
                            prefix: length,
                            rpki,
                            roas: count,
                            ..Route::default()
                        }
                    }
                });
        }
        let held = self.holders(inputs, gazetteer, &announces, &allocated);
        for family in 0..2 {
            self.runs[family] =
                registered(&announces[family], &allocated[family], &held[family]);
        }
    }

    fn holders(
        &mut self,
        inputs: &Path,
        gazetteer: &Gazetteer,
        announces: &[Vec<(u128, Route)>; 2],
        allocated: &[Vec<(u128, Block)>; 2],
    ) -> [Vec<(u128, Holder)>; 2] {
        let named = organisations(inputs);
        let mut spans: [Vec<(u128, u128, u8, u32)>; 2] = [Vec::new(), Vec::new()];
        let mut seen: HashMap<Whois, u32> = HashMap::new();
        let mut held: Vec<Whois> = Vec::new();
        for (name, rir) in WHOIS {
            let code = word(RIRS, rir);
            objects(&inputs.join(name), |object| {
                let Some((first, last, wide)) = object.span() else { return };
                let family = wide as usize;

                if first + WIDEST < last
                    || delegated(&allocated[family], first) != code
                    || covered(&announces[family], first, last)
                {
                    return;
                }
                let who = object.whois(&named, rir);
                let at = *seen.entry(who.clone()).or_insert_with(|| {
                    held.push(who);
                    held.len() as u32
                });
                spans[family].push((first, last, prefix(first, last, wide), at));
            });
        }
        let first = self.rows.len() as u32;
        self.rows.extend(held.into_iter().map(|who| System {
            handle: who.netname,
            company: who.company,
            country: gazetteer.country(two(&who.country)),
            rir: who.rir,
            network_risk: UNSEEN,
            ..System::default()
        }));
        [0, 1].map(|family| {
            runs_of(&mut spans[family], ceiling(family), |_, who, prefix| match who {
                0 => Holder::default(),
                _ => Holder { system: first + who, prefix },
            })
        })
    }
}

const STREETS: [&str; 16] = [
    "street",
    "road",
    "avenue",
    "floor",
    "building",
    "quay",
    "lane",
    "plaza",
    "tower",
    "boulevard",
    "blvd",
    "drive",
    "square",
    "highway",
    "suite",
    "block",
];

fn addressed(company: &str) -> bool {
    let lower = company.to_lowercase();
    let numbered =
        lower.starts_with("no.") || lower.starts_with(|one: char| one.is_ascii_digit());
    numbered && STREETS.iter().any(|street| lower.contains(street))
}

fn registry(source: &str) -> &'static str {
    match source {
        "ARIN" => "arin",
        "RIPE" => "ripencc",
        "LACNIC" => "lacnic",
        "AFRINIC" => "afrinic",
        "APNIC" | "JPNIC" | "KRNIC" | "TWNIC" | "CNNIC" | "IDNIC" => "apnic",
        _ => "",
    }
}

pub const WHOIS: &[(&str, &str)] = &[
    ("ripe_inetnum", "ripencc"),
    ("ripe_inet6num", "ripencc"),
    ("apnic_inetnum", "apnic"),
    ("apnic_inet6num", "apnic"),
    ("afrinic_db", "afrinic"),
];

const WIDEST: u128 = (1 << 24) - 1;

const WIDEST_ROUTE: [u8; 2] = [8, 16];

#[derive(Clone, Copy, Default, PartialEq)]
struct Holder {
    system: u32,
    prefix: u8,
}

#[derive(Clone, Default, PartialEq, Eq, Hash)]
struct Whois {
    netname: String,
    company: String,
    country: String,
    rir: String,
}

#[derive(Default)]
pub struct Object {
    inetnum: String,
    pub geofeed: String,
    netname: String,
    descr: String,
    country: String,
    pub org: String,
    organisation: String,
    org_name: String,
}

impl Object {
    fn take(&mut self, key: &str, value: &str) {
        let value = match key {
            "remarks" => linked(value),
            _ => value,
        };
        let held = match key {
            "inetnum" | "inet6num" => &mut self.inetnum,
            "geofeed" | "remarks" => &mut self.geofeed,
            "netname" => &mut self.netname,
            "descr" => &mut self.descr,
            "country" => &mut self.country,
            "org" => &mut self.org,
            "organisation" => &mut self.organisation,
            "org-name" => &mut self.org_name,
            _ => return,
        };
        if held.is_empty() {
            *held = value.to_string();
        }
    }

    pub fn span(&self) -> Option<(u128, u128, bool)> {
        let Some((first, last)) = self.inetnum.split_once(" - ") else {
            return read::span(&self.inetnum);
        };
        let (first, _, wide) = read::span(first)?;
        let (_, last, _) = read::span(last)?;
        (first <= last).then_some((first, last, wide))
    }

    fn whois(&self, named: &HashMap<String, String>, rir: &str) -> Whois {
        let company = named.get(&self.org).unwrap_or(&self.descr);
        Whois {
            netname: self.netname.clone(),
            company: if addressed(company) { String::new() } else { company.clone() },
            country: self.country.split_whitespace().next().unwrap_or("").to_string(),
            rir: rir.to_string(),
        }
    }
}

fn organisations(inputs: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for name in ["ripe_organisation", "apnic_organisation", "afrinic_db"] {
        objects(&inputs.join(name), |object| {
            if !object.organisation.is_empty() && !object.org_name.is_empty() {
                out.insert(object.organisation.clone(), object.org_name.clone());
            }
        });
    }
    out
}

fn linked(remark: &str) -> &str {
    let Some(at) = remark.find("http") else { return "" };
    remark[at..].split_whitespace().next().unwrap_or("")
}

pub fn objects(path: &Path, mut each: impl FnMut(&Object)) {
    let mut held = Object::default();
    let mut open = false;
    for line in read::lines(path) {
        if line.trim().is_empty() {
            if open {
                each(&held);
                held = Object::default();
                open = false;
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        if key.starts_with(['#', ' ', '\t', '+']) {
            continue;
        }
        held.take(key, value.trim());
        open = true;
    }
    if open {
        each(&held);
    }
}

fn delegated(blocks: &[(u128, Block)], at: u128) -> u8 {
    let spot = blocks.partition_point(|(start, _)| *start <= at);
    blocks.get(spot.saturating_sub(1)).map(|(_, held)| held.rir).unwrap_or(0)
}

fn covered(runs: &[(u128, Route)], first: u128, last: u128) -> bool {
    let mut at = runs.partition_point(|(start, _)| *start <= first).saturating_sub(1);
    while let Some((start, route)) = runs.get(at) {
        if *start > last {
            break;
        }
        if route.system == 0 {
            return false;
        }
        at += 1;
    }
    true
}

fn prefix(first: u128, last: u128, wide: bool) -> u8 {
    let bits: u32 = if wide { 128 } else { 32 };
    let spare = (128 - (last - first).leading_zeros()).min(bits);
    (bits - spare) as u8
}

fn registered(
    runs: &[(u128, Route)],
    blocks: &[(u128, Block)],
    holders: &[(u128, Holder)],
) -> Vec<(u128, Route)> {
    let mut named: Vec<(u128, Route)> = Vec::new();
    together(runs, holders, |at, route, holder| {
        let mut held = *route;
        if held.system == 0 && holder.system != 0 {
            held.system = holder.system;
            held.prefix = holder.prefix;
        }
        push_changed(&mut named, at, held);
    });
    let mut out: Vec<(u128, Route)> = Vec::new();
    together(&named, blocks, |at, route, block| {
        let mut held = *route;
        held.rir = block.rir;
        held.country = block.country;
        held.since = block.since;
        if held.prefix == 0 {
            held.prefix = block.prefix;
        }
        push_changed(&mut out, at, held);
    });
    out
}

fn allocations(inputs: &Path, gazetteer: &Gazetteer) -> [Vec<(u128, Block)>; 2] {
    let mut spans: [Vec<(u128, u128, u8, u32)>; 2] = [Vec::new(), Vec::new()];
    let mut kinds: Vec<Block> = Vec::new();
    let mut seen: HashMap<(u8, u16, u16), u32> = HashMap::new();
    for line in read::slurp(&inputs.join("nro-delegated-stats")).lines() {
        let row: Vec<&str> = line.split('|').collect();
        if row.len() < 7 || row[6] != "assigned" {
            continue;
        }
        let key = (
            word(RIRS, row[0]),
            gazetteer.country(two(row[1])) as u16,
            row[5].get(..4).and_then(|year| year.parse().ok()).unwrap_or(0),
        );
        let rir = *seen.entry(key).or_insert_with(|| {
            kinds.push(Block { rir: key.0, prefix: 0, country: key.1, since: key.2 });
            kinds.len() as u32
        });
        let count: u32 = row[4].parse().unwrap_or(0);
        match row[2] {
            "ipv4" => spans[0].extend(cidrs(row[3], count as u128, rir)),
            "ipv6" if count > 0 && count <= 128 => {
                let Some((first, _, _)) = read::span(&format!("{}/{count}", row[3]))
                else {
                    continue;
                };
                let spare = 128 - count;
                spans[1].push((first, first | read::fill(spare), count as u8, rir));
            }
            _ => continue,
        }
    }
    [0, 1].map(|family| {
        runs_of(&mut spans[family], ceiling(family), |_, kind, prefix| match kind {
            0 => Block::default(),
            _ => Block { prefix, ..kinds[kind as usize - 1] },
        })
    })
}

fn cidrs(first: &str, count: u128, rir: u32) -> Vec<(u128, u128, u8, u32)> {
    let Some((mut at, _, _)) = read::span(first) else { return Vec::new() };
    let (mut left, mut out) = (count, Vec::new());
    while left > 0 && at <= u32::MAX as u128 {
        let aligned = if at == 0 { 32 } else { at.trailing_zeros().min(32) };
        let spare = aligned.min(127 - left.leading_zeros());
        let width = read::fill(spare) + 1;
        out.push((at, at + width - 1, (32 - spare) as u8, rir));
        at += width;
        left -= width;
    }
    out
}

pub fn runs_of<T: PartialEq>(
    spans: &mut [(u128, u128, u8, u32)],
    ceiling: u128,
    value: impl Fn(u128, u32, u8) -> T,
) -> Vec<(u128, T)> {
    let mut runs: Vec<(u128, T)> = Vec::new();
    partition(spans, ceiling, |at, held, prefix| {
        push_changed(&mut runs, at, value(at, held, prefix));
    });
    runs
}

fn partition(
    spans: &mut [(u128, u128, u8, u32)],
    ceiling: u128,
    mut each: impl FnMut(u128, u32, u8),
) {
    spans.sort_unstable_by(|one, other| {
        one.0.cmp(&other.0).then(other.1.cmp(&one.1)).then(one.3.cmp(&other.3))
    });
    let mut stack: Vec<(u128, u8, u32)> = Vec::new();
    let mut at = 0u128;
    for &(first, last, length, asn) in spans.iter() {
        while let Some(top) = stack.last().copied() {
            if top.0 >= first {
                break;
            }
            if at <= top.0 {
                each(at, top.2, top.1);
                at = top.0 + 1;
            }
            stack.pop();
        }
        if at < first {
            match stack.last() {
                Some(top) => each(at, top.2, top.1),
                None => each(at, 0, 0),
            }
            at = first;
        }
        stack.push((last, length, asn));
    }
    while let Some(top) = stack.pop() {
        if at <= top.0 {
            each(at, top.2, top.1);
            at = top.0 + 1;
        }
    }
    if at <= ceiling {
        each(at, 0, 0);
    }
}

struct Roas {
    held: HashMap<(u128, u8, bool), Vec<(u8, u32)>>,
}

impl Roas {
    fn read(inputs: &Path) -> Roas {
        let mut held: HashMap<(u128, u8, bool), Vec<(u8, u32)>> = HashMap::new();
        for line in read::slurp(&inputs.join("vrps.csv")).lines().skip(1) {
            let row: Vec<&str> = line.split(',').collect();
            if row.len() < 3 {
                continue;
            }
            let Ok(asn) = row[0].trim_start_matches("AS").parse::<u32>() else {
                continue;
            };
            let Some((first, _, wide)) = read::span(row[1]) else { continue };
            let Some((_, length)) = row[1].split_once('/') else { continue };
            let Ok(length) = length.parse::<u8>() else { continue };
            let ceiling = row[2].parse().unwrap_or(length);
            held.entry((first, length, wide)).or_default().push((ceiling, asn));
        }
        Roas { held }
    }

    fn verdict(&self, first: u128, length: u8, asn: u32, wide: bool) -> (u8, u16) {
        let bits: u8 = if wide { 128 } else { 32 };
        let (mut covering, mut matching) = (0u16, 0u16);
        for shorter in (0..=length).rev() {
            let key = (first & !read::fill((bits - shorter) as u32), shorter, wide);
            let Some(held) = self.held.get(&key) else { continue };
            covering = covering.saturating_add(held.len() as u16);
            let mine = held
                .iter()
                .filter(|(ceiling, holder)| *holder == asn && length <= *ceiling);
            matching = matching.saturating_add(mine.count() as u16);
        }
        match (covering, matching) {
            (0, _) => (1, 0),
            (_, 0) => (3, covering),
            _ => (2, matching),
        }
    }
}
