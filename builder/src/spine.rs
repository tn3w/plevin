//! One boundary set carrying place, network and abuse together, cut to a selection.

use crate::abuse::Records;
use crate::gazetteer::Gazetteer;
use crate::network::{Route, Systems};
use crate::place::Places;
use crate::{CARRIED, COLUMNS, Column, Kind, Selection, TABLES, vocabularies};
use std::collections::HashMap;

#[derive(Clone, Copy, Default, PartialEq)]
pub struct Stop {
    pub place: u32,
    pub network: u32,
    pub abuse: u32,
    pub whole: u32,
    pub prefix: u8,
    pub rpki: u8,
    pub roas: u16,
    pub rir: u8,
}

pub struct Sheet {
    pub name: String,
    pub encoding: &'static str,
    pub read: &'static str,
    pub values: Vec<i64>,
}

pub enum Part {
    Values(Sheet),
    Index { name: String, keys: Vec<u128>, wide: bool },
    Strings(Vec<String>),
}

pub struct Written {
    pub parts: Vec<Part>,
    pub carries: [bool; 3],
    pub fields: Vec<String>,
    pub books: Vec<(&'static str, Vec<String>)>,
}

pub struct World {
    pub gazetteer: Gazetteer,
    pub places: Places,
    pub systems: Systems,
    pub records: Records,
    pub spine: [Vec<(u128, Stop)>; 2],
}

#[derive(Default)]
struct Words {
    pool: Vec<String>,
    index: HashMap<String, i64>,
}

impl Words {
    fn id(&mut self, text: &str) -> i64 {
        if text.is_empty() {
            return 0;
        }
        if let Some(held) = self.index.get(text) {
            return *held;
        }
        self.pool.push(text.to_string());
        let at = self.pool.len() as i64;
        self.index.insert(text.to_string(), at);
        at
    }
}

struct Slab {
    name: &'static str,
    columns: Vec<&'static Column>,
    keep: Vec<bool>,
    map: Vec<u32>,
    rows: Vec<Vec<i64>>,
    uses: Vec<u64>,
}

impl Slab {
    /// A link as the selection can see it: absence, or the row the target collapsed to.
    fn link(&self, held: u32) -> i64 {
        match held {
            0 => 0,
            at => match self.map.get(at as usize - 1) {
                Some(&u32::MAX) | None => 0,
                Some(at) => *at as i64 + 1,
            },
        }
    }
}

/// What a table is keyed by where its own columns cost more than the links into it.
const ORDERED: &[(&str, &[&str])] = &[
    ("region", &["region.name"]),
    ("district", &["district.name"]),
    ("metro", &["metro.code"]),
    ("city", &["city.country", "city.ascii", "city.name"]),
    ("place", &["place.city", "place.lat", "place.lon"]),
    ("operator", &["operator.country", "operator.company"]),
    ("network", &["network.asn"]),
];

impl World {
    pub fn new(
        gazetteer: Gazetteer,
        places: Places,
        systems: Systems,
        records: Records,
    ) -> World {
        let spine = [0, 1].map(|family| {
            assemble(
                &places.runs[family],
                &systems.runs[family],
                &records.spans[family],
                &records.effective[family],
            )
        });
        World { gazetteer, places, systems, records, spine }
    }

    pub fn write(&self, selection: &Selection) -> Written {
        let mut words = Words::default();
        let mut slabs = self.reach(selection);
        for at in 0..slabs.len() {
            let (done, rest) = slabs.split_at_mut(at);
            self.collapse(&mut rest[0], done, &mut words, selection);
        }
        let mut spines = self.trim(selection, &slabs);
        self.count(&mut slabs, &spines);
        let pool = respell(&mut slabs, &words.pool);
        let mut ranks: Vec<Vec<u32>> = Vec::new();
        for slab in slabs.iter_mut() {
            let placed: HashMap<&str, &Vec<u32>> =
                TABLES.iter().zip(&ranks).map(|(name, held)| (*name, held)).collect();
            relink(slab, &placed);
            let order = rank(slab);
            reorder(slab, &order);
            ranks.push(order);
        }
        let placed: HashMap<&str, &Vec<u32>> =
            TABLES.iter().zip(&ranks).map(|(name, held)| (*name, held)).collect();
        for spine in spines.iter_mut() {
            for (_, stop) in spine.iter_mut() {
                stop.place = ranked(placed["place"], stop.place);
                stop.network = ranked(placed["network"], stop.network);
                stop.abuse = ranked(placed["abuse"], stop.abuse);
            }
        }
        let mut parts = Vec::new();
        for column in COLUMNS {
            let Some(held) = slabs.iter().find(|slab| slab.name == column.table()) else {
                continue;
            };
            let Some(at) = held.columns.iter().position(|one| one.id == column.id) else {
                continue;
            };
            parts.push(Part::Values(Sheet {
                name: column.section(),
                encoding: match column.kind {
                    Kind::Signed | Kind::Degrees => "signed",
                    _ => "fixed",
                },
                read: match column.kind {
                    Kind::Text => "text",
                    Kind::Degrees => "degrees",
                    _ => "",
                },
                values: held.rows.iter().map(|row| row[at]).collect(),
            }));
        }
        parts.extend(self.lay(selection, &spines, &slabs, &ranks));
        parts.push(Part::Strings(pool));
        let zones = selection.has("city.timezone").then(|| self.gazetteer.zones.clone());
        Written {
            parts,
            carries: [
                selection.table("place"),
                selection.table("network"),
                selection.table("abuse"),
            ],
            fields: selection.fields.clone(),
            books: vocabularies(zones.as_deref()),
        }
    }

    /// Which rows of each table the spine still reaches once the selection is cut.
    fn reach(&self, selection: &Selection) -> Vec<Slab> {
        let systems = self.systems.rows.len();
        let sizes: HashMap<&str, usize> = HashMap::from([
            ("region", self.gazetteer.regions.len()),
            ("district", self.gazetteer.districts.len()),
            ("metro", self.gazetteer.metros.len()),
            ("city", self.gazetteer.cities.len()),
            ("place", self.places.points.len()),
            ("operator", systems),
            ("carrier", systems),
            ("abuse", self.records.rows.len()),
            ("network", systems),
        ]);
        let mut slabs: Vec<Slab> = TABLES
            .iter()
            .map(|name| Slab {
                name,
                columns: COLUMNS
                    .iter()
                    .filter(|held| held.table() == *name && selection.has(held.id))
                    .collect(),
                keep: vec![false; sizes[name]],
                map: vec![u32::MAX; sizes[name]],
                rows: Vec::new(),
                uses: Vec::new(),
            })
            .collect();
        let mut wanted: HashMap<&str, Vec<bool>> =
            slabs.iter().map(|slab| (slab.name, slab.keep.clone())).collect();
        touch(wanted.get_mut("abuse").unwrap(), 1);
        for family in 0..2 {
            for (_, stop) in &self.spine[family] {
                touch(wanted.get_mut("place").unwrap(), stop.place);
                touch(wanted.get_mut("network").unwrap(), stop.network);
                touch(wanted.get_mut("abuse").unwrap(), stop.abuse);
                touch(wanted.get_mut("abuse").unwrap(), stop.whole + 1);
            }
            for (_, row) in &self.records.hosts[family] {
                touch(wanted.get_mut("abuse").unwrap(), row + 1);
            }
        }
        for at in 0..systems {
            if !wanted["network"][at] {
                continue;
            }
            for (id, held) in [
                ("network.operator", at as u32 + 1),
                ("network.carrier", at as u32 + 1),
                ("network.abuse", self.systems.rows[at].record),
            ] {
                if selection.has(id) {
                    touch(wanted.get_mut(id.split_once('.').unwrap().1).unwrap(), held);
                }
            }
        }
        for at in 0..systems {
            if wanted["operator"][at] && selection.has("operator.city") {
                touch(wanted.get_mut("city").unwrap(), self.systems.rows[at].city);
            }
        }
        for at in 0..self.places.points.len() {
            if wanted["place"][at] && selection.has("place.city") {
                touch(wanted.get_mut("city").unwrap(), self.places.points[at].city);
            }
        }
        for at in 0..self.gazetteer.cities.len() {
            if !wanted["city"][at] {
                continue;
            }
            let city = &self.gazetteer.cities[at];
            for (id, held) in [
                ("city.region", city.region),
                ("city.district", city.district),
                ("city.metro", city.metro),
            ] {
                if selection.has(id) {
                    touch(wanted.get_mut(id.split_once('.').unwrap().1).unwrap(), held);
                }
            }
        }
        for slab in &mut slabs {
            slab.keep = wanted.remove(slab.name).unwrap();
            if slab.columns.is_empty() {
                slab.keep.iter_mut().for_each(|held| *held = false);
            }
        }
        slabs
    }

    /// Rows the selection cannot tell apart become one row, and a row saying nothing is none.
    fn collapse(
        &self,
        slab: &mut Slab,
        done: &[Slab],
        words: &mut Words,
        selection: &Selection,
    ) {
        let mut seen: HashMap<Vec<i64>, u32> = HashMap::new();
        for at in 0..slab.keep.len() {
            if !slab.keep[at] {
                continue;
            }
            let key: Vec<i64> = slab
                .columns
                .iter()
                .map(|column| {
                    let held = self.cell(column.id, at, words);
                    let held = match selection.narrow.get(column.id) {
                        Some(Some(kept)) if !kept.contains(&held) => 0,
                        _ => held,
                    };
                    match column.kind {
                        Kind::Link => {
                            match done.iter().find(|one| one.name == column.name()) {
                                Some(target) => target.link(held as u32),
                                None => 0,
                            }
                        }
                        _ => held,
                    }
                })
                .collect();
            if key.iter().all(|held| *held == 0) {
                continue;
            }
            let next = seen.len() as u32;
            slab.map[at] = *seen.entry(key.clone()).or_insert_with(|| {
                slab.rows.push(key);
                next
            });
        }
        slab.uses = vec![0; slab.rows.len()];
    }

    fn cell(&self, id: &str, row: usize, words: &mut Words) -> i64 {
        let places = &self.gazetteer;
        let city = |at: usize| &places.cities[at];
        match id {
            "region.name" => words.id(&places.regions[row].name),
            "region.code" => words.id(&places.regions[row].code),
            "region.iso" => words.id(&places.regions[row].iso),
            "region.type" => words.id(&places.regions[row].kind),
            "region.id" => places.regions[row].id as i64,
            "region.country" => words.id(places.code(places.regions[row].country)),
            "district.name" => words.id(&places.districts[row].name),
            "district.code" => words.id(&places.districts[row].code),
            "district.id" => places.districts[row].id as i64,
            "metro.code" => places.metros[row].code as i64,
            "metro.label" => words.id(&places.metros[row].label),
            "city.name" => words.id(&city(row).name),
            "city.ascii" => words.id(&city(row).ascii),
            "city.id" => city(row).id as i64,
            "city.population" => city(row).population as i64,
            "city.type" => city(row).kind as i64,
            "city.postal" => words.id(&city(row).postal),
            "city.postal_partial" => city(row).partial as i64,
            "city.timezone" => city(row).zone as i64,
            "city.elevation" => city(row).elevation as i64,
            "city.country" => words.id(places.code(city(row).country)),
            "city.metro" => city(row).metro as i64,
            "city.region" => city(row).region as i64,
            "city.district" => city(row).district as i64,
            "place.lat" => self.places.points[row].lat as i64,
            "place.lon" => self.places.points[row].lon as i64,
            "place.accuracy" => self.places.points[row].accuracy as i64,
            "place.granularity" => self.places.points[row].grain as i64,
            "place.confidence" => self.places.points[row].confidence as i64,
            "place.city" => self.places.points[row].city as i64,
            "abuse.name" => words.id(&self.records.rows[row].name),
            "abuse.user_type" => self.records.rows[row].user_type as i64,
            "abuse.service" => self.records.rows[row].service as i64,
            "abuse.evidence" => self.records.rows[row].evidence as i64,
            "abuse.is_anycast" => self.records.rows[row].anycast as i64,
            "abuse.is_satellite" => self.records.rows[row].satellite as i64,
            "abuse.risk" => self.records.rows[row].risk as i64,
            "abuse.last_seen_days" => self.records.rows[row].last_seen as i64,
            other => self.holder(other, row, words),
        }
    }

    fn holder(&self, id: &str, row: usize, words: &mut Words) -> i64 {
        let system = &self.systems.rows[row];
        match id {
            "operator.company" => words.id(&system.company),
            "operator.website" => words.id(&system.website),
            "operator.category" => system.category as i64,
            "operator.tier" => system.tier as i64,
            "operator.peering" => system.peering as i64,
            "operator.scope" => words.id(&system.scope),
            "operator.rir" => words.id(&system.rir),
            "operator.since" => system.since as i64,
            "operator.street" => words.id(&system.street),
            "operator.state" => words.id(&system.state),
            "operator.postal" => words.id(&system.postal),
            "operator.abuse_email" => words.id(&system.abuse_email),
            "operator.country" => words.id(self.gazetteer.code(system.country)),
            "operator.city" => system.city as i64,
            "carrier.user_count" => system.users as i64,
            "carrier.mcc" => system.mcc as i64,
            "carrier.mnc" => system.mnc as i64,
            "network.asn" => system.asn as i64,
            "network.handle" => words.id(&system.handle),
            "network.operator" | "network.carrier" => row as i64 + 1,
            "network.abuse" => system.record as i64,
            other => panic!("no column {other}"),
        }
    }

    /// The spine as the selection sees it, with neighbours it cannot tell apart merged.
    fn trim(&self, selection: &Selection, slabs: &[Slab]) -> [Vec<(u128, Stop)>; 2] {
        let held = |name: &str| slabs.iter().find(|slab| slab.name == name).unwrap();
        let falls = selection.has("network.abuse");
        [0, 1].map(|family| {
            let mut out: Vec<(u128, Stop)> = Vec::new();
            for (at, stop) in &self.spine[family] {
                let record = match (selection.table("abuse"), falls) {
                    (false, _) => 0,
                    (true, true) => held("abuse").link(stop.abuse),
                    (true, false) => held("abuse").link(stop.whole + 1),
                };
                let cut = Stop {
                    place: match selection.table("place") {
                        true => held("place").link(stop.place) as u32,
                        false => 0,
                    },
                    network: match selection.table("network") {
                        true => held("network").link(stop.network) as u32,
                        false => 0,
                    },
                    abuse: match record {
                        1 => 0,
                        held => held as u32,
                    },
                    whole: 0,
                    prefix: if selection.has("spine.prefix") { stop.prefix } else { 0 },
                    rpki: if selection.has("spine.rpki") { stop.rpki } else { 0 },
                    roas: if selection.has("spine.roas") { stop.roas } else { 0 },
                    rir: if selection.has("spine.rir") { stop.rir } else { 0 },
                };
                match out.last() {
                    Some((_, last)) if *last == cut => {}
                    _ => out.push((*at, cut)),
                }
            }
            out
        })
    }

    fn count(&self, slabs: &mut [Slab], spines: &[Vec<(u128, Stop)>; 2]) {
        let mut tallies: HashMap<&str, Vec<u64>> =
            slabs.iter().map(|slab| (slab.name, vec![0u64; slab.rows.len()])).collect();
        for (family, spine) in spines.iter().enumerate() {
            for (_, stop) in spine {
                for (name, held) in [
                    ("place", stop.place),
                    ("network", stop.network),
                    ("abuse", stop.abuse),
                ] {
                    if held > 0 {
                        tallies.get_mut(name).unwrap()[held as usize - 1] += 1;
                    }
                }
            }
            let abuse = slabs.iter().find(|slab| slab.name == "abuse").unwrap();
            for (_, row) in &self.records.hosts[family] {
                let held = abuse.link(row + 1);
                if held > 0 {
                    tallies.get_mut("abuse").unwrap()[held as usize - 1] += 1;
                }
            }
        }
        for name in TABLES.iter().rev() {
            let at = slabs.iter().position(|slab| slab.name == *name).unwrap();
            let counted = tallies[name].clone();
            let columns: Vec<(usize, &str)> = slabs[at]
                .columns
                .iter()
                .enumerate()
                .filter(|(_, column)| column.kind == Kind::Link)
                .map(|(spot, column)| (spot, column.name()))
                .collect();
            for (spot, target) in columns {
                let rows = &slabs[at].rows;
                let held = tallies.get_mut(target).unwrap();
                for (row, weight) in rows.iter().zip(&counted) {
                    let link = row[spot];
                    if link > 0 {
                        held[link as usize - 1] += (*weight).max(1);
                    }
                }
            }
            slabs[at].uses = counted;
        }
    }

    /// The address layer and the host layer, in the order the reader finds them.
    fn lay(
        &self,
        selection: &Selection,
        spines: &[Vec<(u128, Stop)>; 2],
        slabs: &[Slab],
        ranks: &[Vec<u32>],
    ) -> Vec<Part> {
        let mut parts = Vec::new();
        let abuse = slabs.iter().find(|slab| slab.name == "abuse").unwrap();
        let order = &ranks[TABLES.iter().position(|name| *name == "abuse").unwrap()];
        let falls = selection.has("network.abuse");
        for (family, wide) in [(0, false), (1, true)] {
            if spines[family].is_empty() {
                continue;
            }
            let version = family * 2 + 4;
            let keys: Vec<u128> = spines[family].iter().map(|held| held.0).collect();
            parts.push(Part::Index { name: format!("spine.v{version}"), keys, wide });
            for name in CARRIED {
                let wanted = match *name {
                    "place" | "network" | "abuse" => selection.table(name),
                    other => selection.has(&format!("spine.{other}")),
                };
                let values: Vec<i64> = spines[family]
                    .iter()
                    .map(|(_, stop)| match *name {
                        "place" => stop.place as i64,
                        "network" => stop.network as i64,
                        "abuse" => stop.abuse as i64,
                        "prefix" => stop.prefix as i64,
                        "rpki" => stop.rpki as i64,
                        "roas" => stop.roas as i64,
                        _ => stop.rir as i64,
                    })
                    .collect();
                if wanted && values.iter().any(|held| *held != 0) {
                    parts.push(Part::Values(Sheet {
                        name: format!("spine.v{version}.{name}"),
                        encoding: "fixed",
                        read: "",
                        values,
                    }));
                }
            }
        }
        if !selection.table("abuse") {
            return parts;
        }
        for (family, wide) in [(0, false), (1, true)] {
            let version = family * 2 + 4;
            let mut keys: Vec<u128> = Vec::new();
            let mut values: Vec<i64> = Vec::new();
            for (address, row) in &self.records.hosts[family] {
                let held = abuse.link(row + 1);
                if held == 0 {
                    continue;
                }
                let mine = order[held as usize - 1] as i64;
                let at = spines[family].partition_point(|(start, _)| *start <= *address);
                let standing =
                    match at.checked_sub(1).map(|at| spines[family][at].1.abuse) {
                        Some(0) | None if falls => None,
                        Some(0) | None => Some(0),
                        Some(link) => Some(link as i64 - 1),
                    };
                if standing == Some(mine) {
                    continue;
                }
                keys.push(*address);
                values.push(mine);
            }
            if keys.is_empty() {
                continue;
            }
            parts.push(Part::Index { name: format!("hosts.v{version}"), keys, wide });
            parts.push(Part::Values(Sheet {
                name: format!("hosts.v{version}.abuse"),
                encoding: "fixed",
                read: "",
                values,
            }));
        }
        parts
    }
}

fn touch(keep: &mut [bool], link: u32) {
    if link > 0 && (link as usize) <= keep.len() {
        keep[link as usize - 1] = true;
    }
}

/// Records rank by how often they are reached; every other table reads in its own order.
fn rank(slab: &Slab) -> Vec<u32> {
    let pinned = slab.name == "abuse" && !slab.rows.is_empty();
    let first = pinned as usize;
    let mut order: Vec<usize> = (first..slab.rows.len()).collect();
    match ORDERED.iter().find(|(name, _)| *name == slab.name) {
        None if pinned => {
            order.sort_by_key(|at| (std::cmp::Reverse(slab.uses[*at]), *at))
        }
        None => {}
        Some((_, by)) => {
            let spots: Vec<usize> = by
                .iter()
                .filter_map(|id| slab.columns.iter().position(|column| column.id == *id))
                .collect();
            order.sort_by_cached_key(|at| {
                let row = &slab.rows[*at];
                let mut key: Vec<i64> = spots.iter().map(|spot| row[*spot]).collect();
                key.extend(row);
                key
            });
        }
    }
    let mut ranks = vec![0u32; slab.rows.len()];
    for (place, at) in order.iter().enumerate() {
        ranks[*at] = (place + first) as u32;
    }
    ranks
}

fn ranked(order: &[u32], link: u32) -> u32 {
    match link {
        0 => 0,
        at => order[at as usize - 1] + 1,
    }
}

/// Links follow the table they point at, which has already settled into its order.
fn relink(slab: &mut Slab, ranks: &HashMap<&str, &Vec<u32>>) {
    let links: Vec<(usize, &str)> = slab
        .columns
        .iter()
        .enumerate()
        .filter(|(_, column)| column.kind == Kind::Link)
        .map(|(at, column)| (at, column.name()))
        .collect();
    for row in slab.rows.iter_mut() {
        for (at, target) in &links {
            let held = row[*at];
            row[*at] = match (held, ranks.get(target)) {
                (0, _) | (_, None) => 0,
                (held, Some(rank)) => rank[held as usize - 1] as i64 + 1,
            };
        }
    }
}

fn reorder(slab: &mut Slab, order: &[u32]) {
    let mut moved: Vec<Vec<i64>> = vec![Vec::new(); slab.rows.len()];
    for (at, row) in slab.rows.drain(..).enumerate() {
        moved[order[at] as usize] = row;
    }
    slab.rows = moved;
}

fn spots(slab: &Slab) -> Vec<usize> {
    slab.columns
        .iter()
        .enumerate()
        .filter(|(_, column)| column.kind == Kind::Text)
        .map(|(at, _)| at)
        .collect()
}

/// One pool for every name in the file, sorted so a group front codes against itself.
fn respell(slabs: &mut [Slab], pool: &[String]) -> Vec<String> {
    let mut keep = vec![false; pool.len() + 1];
    for slab in slabs.iter() {
        let held = spots(slab);
        for row in &slab.rows {
            for spot in &held {
                keep[row[*spot] as usize] = true;
            }
        }
    }
    let mut names: Vec<(&String, i64)> = pool
        .iter()
        .enumerate()
        .filter(|(at, _)| keep[*at + 1])
        .map(|(at, name)| (name, at as i64 + 1))
        .collect();
    names.sort_by(|one, other| one.0.cmp(other.0));
    let mut again = vec![0i64; pool.len() + 1];
    for (place, (_, old)) in names.iter().enumerate() {
        again[*old as usize] = place as i64 + 1;
    }
    for slab in slabs.iter_mut() {
        let held = spots(slab);
        for row in slab.rows.iter_mut() {
            for spot in &held {
                row[*spot] = again[row[*spot] as usize];
            }
        }
    }
    names.into_iter().map(|(name, _)| name.clone()).collect()
}

/// Place, network and abuse read together: one boundary set answering all three.
fn assemble(
    places: &[(u128, u32)],
    routes: &[(u128, Route)],
    spans: &[(u128, u32)],
    whole: &[(u128, u32)],
) -> Vec<(u128, Stop)> {
    let mut marks: Vec<u128> =
        Vec::with_capacity(places.len() + routes.len() + spans.len());
    marks.extend(places.iter().map(|held| held.0));
    marks.extend(routes.iter().map(|held| held.0));
    marks.extend(spans.iter().map(|held| held.0));
    marks.extend(whole.iter().map(|held| held.0));
    marks.sort_unstable();
    marks.dedup();
    let mut cursors = [0usize; 4];
    let mut out: Vec<(u128, Stop)> = Vec::with_capacity(marks.len());
    for at in marks {
        let step = |cursor: &mut usize, starts: &dyn Fn(usize) -> Option<u128>| {
            while starts(*cursor + 1).is_some_and(|start| start <= at) {
                *cursor += 1;
            }
        };
        step(&mut cursors[0], &|spot| places.get(spot).map(|held| held.0));
        step(&mut cursors[1], &|spot| routes.get(spot).map(|held| held.0));
        step(&mut cursors[2], &|spot| spans.get(spot).map(|held| held.0));
        step(&mut cursors[3], &|spot| whole.get(spot).map(|held| held.0));
        let route = routes.get(cursors[1]).map(|held| held.1).unwrap_or_default();
        let stop = Stop {
            place: places.get(cursors[0]).map(|held| held.1).unwrap_or(0),
            network: route.system,
            abuse: spans.get(cursors[2]).map(|held| held.1).unwrap_or(0),
            whole: whole.get(cursors[3]).map(|held| held.1).unwrap_or(0),
            prefix: route.prefix,
            rpki: route.rpki,
            roas: route.roas,
            rir: route.rir,
        };
        match out.last() {
            Some((_, last)) if *last == stop => {}
            _ => out.push((at, stop)),
        }
    }
    out
}
