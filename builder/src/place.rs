//! One interned point per coordinate, and the address space that resolves to it.

use crate::ceiling;
use crate::gazetteer::{Gazetteer, kilometres};
use crate::network::{WHOIS, objects, runs_of};
use crate::read::{self, CITY, COUNTRY, Coarse, Location, Mmdb, NOWHERE, REGION, two};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub struct Point {
    pub lat: i32,
    pub lon: i32,
    pub accuracy: u16,
    pub grain: u8,
    pub confidence: u8,
    pub city: u32,
}

pub struct Places {
    pub points: Vec<Point>,
    pub runs: [Vec<(u128, u32)>; 2],
}

const DEGREES: f64 = 10_000.0;
const BLOCK: [u32; 2] = [8, 88];
const FAR: [(f64, u8); 4] = [(25.0, 80), (100.0, 65), (500.0, 50), (f64::MAX, 35)];
const DECLARED: u16 = 10;
const SECONDED: u8 = 90;
const NEARBY: f64 = 25.0;
const LACNIC: &str = "https://milacnic.lacnic.net/lacnic/geofeeds";

type Authorities = HashMap<(String, bool), Vec<(u128, u128)>>;

struct Interning<'a> {
    gazetteer: &'a Gazetteer,
    points: Vec<Point>,
    weight: Vec<(u64, u32)>,
    index: HashMap<(i32, i32, u8), u32>,
    snapped: HashMap<(i32, i32, u32), (u32, f64)>,
    spread: [Vec<u32>; 3],
    metros: HashMap<u32, HashMap<u16, u128>>,
}

impl Places {
    pub fn read(inputs: &Path, gazetteer: &mut Gazetteer) -> Places {
        let fine = Mmdb::open(&inputs.join("GeoLite2-City.mmdb"));
        let coarse = Location::open(&inputs.join("IP2LOCATION-LITE-DB11.IPV6.BIN"));
        let third = Mmdb::open(&inputs.join("dbip-city-lite.mmdb"));
        let declared = declared(inputs, gazetteer);
        let mut interning = Interning {
            gazetteer,
            points: Vec::new(),
            weight: Vec::new(),
            index: HashMap::new(),
            snapped: HashMap::new(),
            spread: [Vec::new(), Vec::new(), Vec::new()],
            metros: HashMap::new(),
        };
        let mut runs = [Vec::new(), Vec::new()];
        for (family, wide) in [(0, false), (1, true)] {
            let measured =
                fine.as_ref().map(|held| held.ranges(wide)).unwrap_or_default();
            let backing = coarse.as_ref().map(|held| held.rows(wide)).unwrap_or_default();
            let voting = third.as_ref().map(|held| held.ranges(wide)).unwrap_or_default();
            let lists = [&declared[family][..], &measured, &backing, &voting];
            let mut segments = Vec::new();
            walk(lists, ceiling(family), |first, last, held| {
                let point = interning.resolve(held, last - first + 1);
                segments.push((first, last, point));
            });
            runs[family] = collapse(&segments, BLOCK[family]);
        }
        let floors = interning.floors();
        let Interning { mut points, weight, metros, .. } = interning;
        for (at, point) in points.iter_mut().enumerate() {
            let (sum, count) = weight[at];
            point.confidence = (sum / count.max(1) as u64) as u8;
            point.accuracy = point.accuracy.max(floors[point.grain as usize]);
        }
        let codes: HashMap<u16, u32> = gazetteer
            .metros
            .iter()
            .enumerate()
            .map(|(at, metro)| (metro.code, at as u32 + 1))
            .collect();
        for (city, votes) in metros {
            let winner = votes.into_iter().max_by_key(|(code, mass)| (*mass, *code));
            if let Some(row) = winner.and_then(|(code, _)| codes.get(&code)) {
                gazetteer.cities[city as usize].metro = *row;
            }
        }
        Places { points, runs }
    }
}

impl Interning<'_> {
    fn resolve(&mut self, held: [Option<&Coarse>; 4], mass: u128) -> u32 {
        let [declared, measured, other, third] = held;
        let one = declared.or(measured);
        let leading = one.filter(|held| held.grain <= REGION);
        let chosen = match (leading, other) {
            (Some(held), _) => held,
            (None, Some(held)) if held.grain <= REGION => held,
            (None, _) => match one.filter(|held| held.grain < NOWHERE) {
                Some(held) => held,
                None => match other.filter(|held| held.grain < NOWHERE) {
                    Some(held) => held,
                    None => return 0,
                },
            },
        };
        let chosen = match declared {
            None => self.outvoted(chosen, other, third),
            Some(_) => chosen,
        };
        let (city, snap) = self.snap(chosen);
        let confidence = self.agreement(one, other, chosen.grain);
        let confidence = match self.seconds(chosen, third) {
            true => confidence.max(SECONDED),
            false => confidence,
        };
        let accuracy = chosen.radius.max(snap.round() as u16);
        let key = (round(chosen.lat), round(chosen.lon), chosen.grain);
        let at = match self.index.get(&key) {
            Some(at) => *at,
            None => {
                self.points.push(Point {
                    lat: key.0,
                    lon: key.1,
                    accuracy: 0,
                    grain: chosen.grain,
                    confidence: 0,
                    city,
                });
                self.weight.push((0, 0));
                self.index.insert(key, self.points.len() as u32 - 1);
                self.points.len() as u32 - 1
            }
        };
        let point = &mut self.points[at as usize];
        point.accuracy = point.accuracy.max(accuracy);
        self.weight[at as usize].0 += confidence as u64;
        self.weight[at as usize].1 += 1;
        self.spread[chosen.grain as usize].push(accuracy as u32);
        if let Some(metro) =
            one.filter(|held| held.metro > 0 && std::ptr::eq(*held, chosen))
            && city > 0
        {
            *self.metros.entry(city - 1).or_default().entry(metro.metro).or_default() +=
                mass;
        }
        at + 1
    }

    fn outvoted<'a>(
        &mut self,
        chosen: &'a Coarse,
        other: Option<&'a Coarse>,
        third: Option<&'a Coarse>,
    ) -> &'a Coarse {
        let (Some(other), Some(third)) = (other, third) else { return chosen };
        if chosen.grain != CITY || other.grain != CITY || third.grain != CITY {
            return chosen;
        }
        let near = kilometres((chosen.lat, chosen.lon), (other.lat, other.lon)) <= NEARBY;
        let (mine, theirs) = (self.snap(chosen).0, self.snap(other).0);
        match near && mine != theirs && theirs != 0 && self.snap(third).0 == theirs {
            true => other,
            false => chosen,
        }
    }

    fn seconds(&mut self, chosen: &Coarse, third: Option<&Coarse>) -> bool {
        let Some(third) = third.filter(|held| held.grain == chosen.grain) else {
            return false;
        };
        let here = self.snap(chosen).0;
        here != 0 && self.snap(third).0 == here
    }

    fn snap(&mut self, row: &Coarse) -> (u32, f64) {
        let key = (round(row.lat), round(row.lon), self.gazetteer.country(row.country));
        if let Some(held) = self.snapped.get(&key) {
            return *held;
        }
        let code = match key.2 {
            0 => self.gazetteer.holder(row.lat, row.lon),
            _ => row.country,
        };
        let found = self.gazetteer.nearest(row.lat, row.lon, code);
        let held = found.map(|(city, far)| (city + 1, far)).unwrap_or((0, 0.0));
        self.snapped.insert(key, held);
        held
    }

    fn agreement(
        &mut self,
        one: Option<&Coarse>,
        other: Option<&Coarse>,
        grain: u8,
    ) -> u8 {
        fn spoke(held: Option<&Coarse>) -> Option<&Coarse> {
            held.filter(|row| row.grain < NOWHERE)
        }
        let (Some(fine), Some(coarse)) = (spoke(one), spoke(other)) else {
            return match spoke(one).or(spoke(other)) {
                Some(held) if held.grain <= REGION => 60,
                _ => 55,
            };
        };
        if grain == COUNTRY {
            return match fine.country == coarse.country {
                true => 70,
                false => 40,
            };
        }
        let (here, _) = self.snap(fine);
        let (there, _) = self.snap(coarse);
        if here == there && here != 0 {
            return 100;
        }
        let far = kilometres((fine.lat, fine.lon), (coarse.lat, coarse.lon));
        FAR.iter().find(|(reach, _)| far < *reach).map(|(_, score)| *score).unwrap_or(35)
    }

    fn floors(&mut self) -> [u16; 4] {
        let mut floors = [0u16; 4];
        for (floor, held) in floors.iter_mut().zip(&mut self.spread) {
            if held.is_empty() {
                continue;
            }
            held.sort_unstable();
            *floor = held[held.len() * 9 / 10] as u16;
        }
        floors
    }
}

fn declared(inputs: &Path, gazetteer: &Gazetteer) -> [Vec<Coarse>; 2] {
    let authorities = authorities(inputs);
    let mut spans: [Vec<(u128, u128, u8, u32)>; 2] = [Vec::new(), Vec::new()];
    for line in read::lines(&inputs.join("geofeeds")) {
        let row: Vec<&str> = line.split(',').map(str::trim).collect();
        if row.len() < 5 || row[4].is_empty() {
            continue;
        }
        let Some((first, last, wide)) = read::span(row[1]) else { continue };
        let vouched = authorities
            .get(&(row[0].to_string(), wide))
            .is_some_and(|held| inside(held, first, last));
        if !vouched && row[0] != LACNIC {
            continue;
        }
        let code = two(&row[2].to_uppercase());
        let city = gazetteer.locate(row[4], &row[3].to_uppercase(), code);
        if city > 0 {
            spans[wide as usize].push((first, last, 0, city));
        }
    }
    [0, 1].map(|family| {
        let runs = runs_of(&mut spans[family], ceiling(family), |_, city, _| city);
        let mut rows = Vec::new();
        for (at, (first, city)) in runs.iter().enumerate() {
            let Some(held) = city.checked_sub(1).map(|at| &gazetteer.cities[at as usize])
            else {
                continue;
            };
            rows.push(Coarse {
                first: *first,
                last: runs.get(at + 1).map(|next| next.0 - 1).unwrap_or(ceiling(family)),
                lat: held.lat,
                lon: held.lon,
                radius: DECLARED,
                grain: CITY,
                country: two(gazetteer.code(held.country)),
                metro: 0,
            });
        }
        rows
    })
}

fn authorities(inputs: &Path) -> Authorities {
    let mut owned: HashMap<String, Vec<(u128, u128, bool)>> = HashMap::new();
    let mut vouched: HashSet<(String, String)> = HashSet::new();
    let mut held: Authorities = HashMap::new();
    for (name, _) in WHOIS {
        objects(&inputs.join(name), |object| {
            let Some((first, last, wide)) = object.span() else { return };
            if !object.org.is_empty() {
                owned.entry(object.org.clone()).or_default().push((first, last, wide));
            }
            if !object.geofeed.is_empty() {
                let key = (object.geofeed.clone(), wide);
                held.entry(key).or_default().push((first, last));
                vouched.insert((object.geofeed.clone(), object.org.clone()));
            }
        });
    }
    for (url, org) in vouched {
        for &(first, last, wide) in owned.get(&org).into_iter().flatten() {
            held.entry((url.clone(), wide)).or_default().push((first, last));
        }
    }
    for spans in held.values_mut() {
        spans.sort_unstable();
        let mut merged: Vec<(u128, u128)> = Vec::with_capacity(spans.len());
        for &(first, last) in spans.iter() {
            match merged.last_mut() {
                Some(open) if first <= open.1.saturating_add(1) => {
                    open.1 = open.1.max(last)
                }
                _ => merged.push((first, last)),
            }
        }
        *spans = merged;
    }
    held
}

fn inside(spans: &[(u128, u128)], first: u128, last: u128) -> bool {
    let spot = spans.partition_point(|(start, _)| *start <= first);
    spot > 0 && spans[spot - 1].1 >= last
}

fn round(degrees: f64) -> i32 {
    (degrees * DEGREES).round() as i32
}

fn walk<const N: usize>(
    lists: [&[Coarse]; N],
    ceiling: u128,
    mut each: impl FnMut(u128, u128, [Option<&Coarse>; N]),
) {
    let mut cursors = [0usize; N];
    let mut at = 0u128;
    loop {
        let mut stop = ceiling;
        let mut holding: [Option<&Coarse>; N] = [None; N];
        for (side, rows) in lists.into_iter().enumerate() {
            while cursors[side] < rows.len() && rows[cursors[side]].last < at {
                cursors[side] += 1;
            }
            match rows.get(cursors[side]) {
                Some(row) if row.first <= at => {
                    holding[side] = Some(row);
                    stop = stop.min(row.last);
                }
                Some(row) => stop = stop.min(row.first - 1),
                None => {}
            }
        }
        each(at, stop, holding);
        if stop >= ceiling {
            return;
        }
        at = stop + 1;
    }
}

fn collapse(segments: &[(u128, u128, u32)], shift: u32) -> Vec<(u128, u32)> {
    let mut runs: Vec<(u128, u32)> = Vec::new();
    let mut open: Option<(u128, u32, u128)> = None;
    for &(first, last, point) in segments {
        let (head, tail) = (first >> shift, last >> shift);
        if let Some((block, held, _)) = open
            && block < head
        {
            mark(&mut runs, block, held, shift);
            open = None;
        }
        if head == tail {
            let weight = last - first + 1;
            open = match open {
                Some((block, held, mass)) if block == head && mass >= weight => {
                    Some((block, held, mass))
                }
                _ => Some((head, point, weight)),
            };
            continue;
        }
        let reach = ((head + 1) << shift) - first;
        let winner = match open {
            Some((block, held, mass)) if block == head && mass >= reach => held,
            _ => point,
        };
        mark(&mut runs, head, winner, shift);
        mark(&mut runs, head + 1, point, shift);
        open = Some((tail, point, last - (tail << shift) + 1));
    }
    if let Some((block, point, _)) = open {
        mark(&mut runs, block, point, shift);
    }
    let mut held: Vec<(u128, u32)> = Vec::with_capacity(runs.len());
    for run in runs {
        if held.last().map(|last| last.1) != Some(run.1) {
            held.push(run);
        }
    }
    held
}

fn mark(runs: &mut Vec<(u128, u32)>, block: u128, point: u32, shift: u32) {
    let at = block << shift;
    match runs.last_mut() {
        Some(last) if last.0 == at => last.1 = point,
        Some(last) if last.1 == point => {}
        _ => runs.push((at, point)),
    }
}
