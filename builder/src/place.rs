//! One interned point per coordinate, and the address space that resolves to it.

use crate::gazetteer::{Gazetteer, kilometres};
use crate::read::{COUNTRY, Coarse, Location, Mmdb, NOWHERE, REGION};
use std::collections::HashMap;
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
            let leading = fine.as_ref().map(|held| held.ranges(wide)).unwrap_or_default();
            let backing = coarse.as_ref().map(|held| held.rows(wide)).unwrap_or_default();
            let ceiling = if wide { u128::MAX } else { u32::MAX as u128 };
            let mut segments = Vec::new();
            walk(&leading, &backing, ceiling, |first, last, one, other| {
                let point = interning.resolve(one, other, last - first + 1);
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
    /// Which source answers this span, the city it snaps to, and how well they agree.
    fn resolve(
        &mut self,
        one: Option<&Coarse>,
        other: Option<&Coarse>,
        mass: u128,
    ) -> u32 {
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
        let (city, snap) = self.snap(chosen);
        let confidence = self.agreement(one, other, chosen.grain);
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
        if let Some(metro) = one.filter(|held| held.metro > 0)
            && city > 0
        {
            *self.metros.entry(city - 1).or_default().entry(metro.metro).or_default() +=
                mass;
        }
        at + 1
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

    /// The floor every accuracy in a granularity is held to, measured at nine tenths.
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

fn round(degrees: f64) -> i32 {
    (degrees * DEGREES).round() as i32
}

/// Both databases read together, one segment per span where either of them changes.
fn walk(
    fine: &[Coarse],
    coarse: &[Coarse],
    ceiling: u128,
    mut each: impl FnMut(u128, u128, Option<&Coarse>, Option<&Coarse>),
) {
    let mut cursors = [0usize, 0usize];
    let mut at = 0u128;
    loop {
        let mut stop = ceiling;
        let mut holding: [Option<&Coarse>; 2] = [None, None];
        for (side, rows) in [fine, coarse].into_iter().enumerate() {
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
        each(at, stop, holding[0], holding[1]);
        if stop >= ceiling {
            return;
        }
        at = stop + 1;
    }
}

/// Runs no finer than a block, each block taking the point that covers most of it.
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
