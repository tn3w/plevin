//! Every place an address can resolve to, and the codes that name it.

use crate::read::{self, two};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

pub struct Region {
    pub name: String,
    pub code: String,
    pub iso: String,
    pub kind: String,
    pub id: u32,
    pub country: u32,
}

pub struct District {
    pub name: String,
    pub code: String,
    pub id: u32,
}

pub struct Metro {
    pub code: u16,
    pub label: String,
}

pub struct City {
    pub name: String,
    pub ascii: String,
    pub id: u32,
    pub population: u32,
    pub kind: u8,
    pub postal: String,
    pub partial: u8,
    pub zone: u16,
    pub elevation: i32,
    pub metro: u32,
    pub region: u32,
    pub district: u32,
    pub country: u32,
    pub lat: f64,
    pub lon: f64,
}

pub struct Gazetteer {
    pub countries: Vec<String>,
    pub regions: Vec<Region>,
    pub districts: Vec<District>,
    pub metros: Vec<Metro>,
    pub cities: Vec<City>,
    pub zones: Vec<String>,
    cells: HashMap<i32, Vec<u32>>,
    borders: Vec<(f64, f64, f64, f64, [u8; 2], Vec<Vec<[f64; 2]>>)>,
    named: HashMap<(u16, String), u32>,
}

const FEATURES: &[&str] = &[
    "PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLA5", "PPLC", "PPLCH", "PPLF", "PPLG",
    "PPLH", "PPLL", "PPLQ", "PPLR", "PPLS", "PPLW", "PPLX", "STLMT",
];

const FOLDS: &[(&str, char)] = &[
    ("àáâãäåāăąǎæ", 'a'),
    ("çćĉċč", 'c'),
    ("ďđ", 'd'),
    ("èéêëēĕėęě", 'e'),
    ("ĝğġģ", 'g'),
    ("ĥħ", 'h'),
    ("ìíîïĩīĭįı", 'i'),
    ("ĵ", 'j'),
    ("ķ", 'k'),
    ("ĺļľŀł", 'l'),
    ("ñńņňŉ", 'n'),
    ("òóôõöøōŏőœ", 'o'),
    ("ŕŗř", 'r'),
    ("śŝşšß", 's'),
    ("ţťŧ", 't'),
    ("ùúûüũūŭůűų", 'u'),
    ("ŵ", 'w'),
    ("ýÿŷ", 'y'),
    ("źżž", 'z'),
];

/// A name with its accents folded away, which is how two gazetteers are compared.
pub fn fold(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|point| match FOLDS.iter().find(|(from, _)| from.contains(point)) {
            Some((_, plain)) => *plain,
            None => point,
        })
        .filter(|point| point.is_alphanumeric() || *point == ' ')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
}

pub fn kilometres(one: (f64, f64), other: (f64, f64)) -> f64 {
    let (lat, lon) = (one.0.to_radians(), one.1.to_radians());
    let (other_lat, other_lon) = (other.0.to_radians(), other.1.to_radians());
    let half = ((other_lat - lat) / 2.0).sin().powi(2)
        + lat.cos() * other_lat.cos() * ((other_lon - lon) / 2.0).sin().powi(2);
    6371.0 * 2.0 * half.sqrt().min(1.0).asin()
}

fn cell(lat: f64, lon: f64) -> i32 {
    (lat.floor() as i32 + 90).clamp(0, 180) * 512
        + (lon.floor() as i32 + 180).clamp(0, 360)
}

impl Gazetteer {
    pub fn read(inputs: &Path) -> Gazetteer {
        let cities = read::slurp(&inputs.join("cities500.txt"));
        let mut codes: BTreeSet<String> = BTreeSet::new();
        let mut zones: BTreeSet<String> = BTreeSet::new();
        for line in cities.lines() {
            let row: Vec<&str> = line.split('\t').collect();
            if row.len() > 17 {
                codes.insert(row[8].to_string());
                zones.insert(row[17].to_string());
            }
        }
        for line in read::slurp(&inputs.join("nro-delegated-stats")).lines() {
            let row: Vec<&str> = line.split('|').collect();
            if row.len() > 6
                && row[1].len() == 2
                && row[1].bytes().all(|b| b.is_ascii_uppercase())
            {
                codes.insert(row[1].to_string());
            }
        }
        codes.remove("");
        zones.remove("");
        let countries: Vec<String> = codes.into_iter().collect();
        let zones: Vec<String> = zones.into_iter().collect();
        let mut gazetteer = Gazetteer {
            countries,
            regions: Vec::new(),
            districts: Vec::new(),
            metros: Vec::new(),
            cities: Vec::new(),
            zones,
            cells: HashMap::new(),
            borders: Vec::new(),
            named: HashMap::new(),
        };
        let regions = gazetteer.read_regions(inputs);
        let districts = gazetteer.read_districts(inputs);
        gazetteer.read_cities(&cities, &regions, &districts);
        gazetteer.read_postal(inputs);
        gazetteer.read_metros();
        gazetteer.read_borders(inputs);
        gazetteer
    }

    /// The code a country link stands for, which is what the file stores of it.
    pub fn code(&self, link: u32) -> &str {
        match link {
            0 => "",
            at => &self.countries[at as usize - 1],
        }
    }

    pub fn country(&self, code: [u8; 2]) -> u32 {
        let code = String::from_utf8_lossy(&code).into_owned();
        match self.countries.binary_search(&code) {
            Ok(at) => at as u32 + 1,
            Err(_) => 0,
        }
    }

    fn read_regions(&mut self, inputs: &Path) -> HashMap<String, u32> {
        let iso = read::slurp(&inputs.join("iso_3166-2.json"));
        let listed: serde_json::Value = serde_json::from_str(&iso).unwrap_or_default();
        let mut by_code: HashMap<String, (String, String)> = HashMap::new();
        let mut by_name: HashMap<(String, String), String> = HashMap::new();
        for row in listed["3166-2"].as_array().unwrap_or(&Vec::new()) {
            let code = row["code"].as_str().unwrap_or("").to_string();
            let name = row["name"].as_str().unwrap_or("").to_string();
            let kind = row["type"].as_str().unwrap_or("").to_string();
            let country = code.split('-').next().unwrap_or("").to_string();
            by_name.insert((country, fold(&name)), code.clone());
            by_code.insert(code, (name, kind));
        }
        let mut fixed: HashMap<String, String> = HashMap::new();
        for (key, region) in read::data("regions.json").as_object().into_iter().flatten()
        {
            fixed.insert(key.clone(), region["iso"].as_str().unwrap_or("").to_string());
        }
        let shapes = read::dbf(&inputs.join("ne_10m_admin_1_states_provinces.dbf"));
        let mut drawn: HashMap<String, String> = HashMap::new();
        for row in 0..shapes.rows.len() {
            let key = shapes.at(row, "gn_a1_code").to_string();
            let code = shapes.at(row, "iso_3166_2").to_string();
            if !key.is_empty() && by_code.contains_key(&code) {
                drawn.insert(key, code);
            }
        }
        let mut index = HashMap::new();
        for line in read::slurp(&inputs.join("admin1CodesASCII.txt")).lines() {
            let row: Vec<&str> = line.split('\t').collect();
            if row.len() < 4 {
                continue;
            }
            let (country, code) = row[0].split_once('.').unwrap_or(("", ""));
            let name = row[1].to_string();
            let listed = fixed
                .get(row[0])
                .cloned()
                .or_else(|| {
                    by_code
                        .contains_key(&format!("{country}-{code}"))
                        .then(|| format!("{country}-{code}"))
                })
                .or_else(|| drawn.get(row[0]).cloned())
                .or_else(|| by_name.get(&(country.to_string(), fold(&name))).cloned())
                .unwrap_or_default();
            let kind =
                by_code.get(&listed).map(|held| held.1.clone()).unwrap_or_default();
            index.insert(row[0].to_string(), self.regions.len() as u32 + 1);
            self.regions.push(Region {
                name,
                code: code.to_string(),
                iso: listed,
                kind,
                id: row[3].parse().unwrap_or(0),
                country: self.country(two(country)),
            });
        }
        index
    }

    fn read_districts(&mut self, inputs: &Path) -> HashMap<String, u32> {
        let mut index = HashMap::new();
        for line in read::slurp(&inputs.join("admin2Codes.txt")).lines() {
            let row: Vec<&str> = line.split('\t').collect();
            if row.len() < 4 {
                continue;
            }
            let code = row[0].rsplit('.').next().unwrap_or("").to_string();
            index.insert(row[0].to_string(), self.districts.len() as u32 + 1);
            self.districts.push(District {
                name: row[1].to_string(),
                code,
                id: row[3].parse().unwrap_or(0),
            });
        }
        index
    }

    fn read_cities(
        &mut self,
        body: &str,
        regions: &HashMap<String, u32>,
        districts: &HashMap<String, u32>,
    ) {
        for line in body.lines() {
            let row: Vec<&str> = line.split('\t').collect();
            if row.len() < 18 {
                continue;
            }
            let country = row[8];
            let region = format!("{country}.{}", row[10]);
            let district = format!("{region}.{}", row[11]);
            let elevation = row[15].parse().or_else(|_| row[16].parse()).unwrap_or(0);
            let zone = self.zones.binary_search(&row[17].to_string());
            let at = self.cities.len() as u32;
            let (lat, lon) =
                (row[4].parse().unwrap_or(0.0), row[5].parse().unwrap_or(0.0));
            self.cells.entry(cell(lat, lon)).or_default().push(at);
            self.cities.push(City {
                name: row[1].to_string(),
                ascii: row[2].to_string(),
                id: row[0].parse().unwrap_or(0),
                population: row[14].parse().unwrap_or(0),
                kind: FEATURES.iter().position(|held| *held == row[7]).unwrap_or(0) as u8,
                postal: String::new(),
                partial: 0,
                zone: zone.map(|at| at as u16).unwrap_or(self.zones.len() as u16),
                elevation: if elevation < -12000 { 0 } else { elevation },
                metro: 0,
                region: regions.get(&region).copied().unwrap_or(0),
                district: districts.get(&district).copied().unwrap_or(0),
                country: self.country(two(country)),
                lat,
                lon,
            });
        }
        for at in 0..self.cities.len() {
            let city = &self.cities[at];
            let key = (city.country as u16, fold(&city.ascii));
            let held =
                self.named.get(&key).map(|other| self.cities[*other as usize].population);
            if held.unwrap_or(0) <= city.population {
                self.named.insert(key, at as u32);
            }
        }
    }

    fn read_postal(&mut self, inputs: &Path) {
        let body = read::slurp(&inputs.join("allCountries.txt"));
        let mut places: HashMap<(u16, String), Vec<(String, f64, f64)>> = HashMap::new();
        for line in body.lines() {
            let row: Vec<&str> = line.split('\t').collect();
            if row.len() < 11 || row[1].is_empty() {
                continue;
            }
            let country = self.country(two(row[0])) as u16;
            let key = (country, fold(row[2]));
            let lat = row[9].parse().unwrap_or(0.0);
            let lon = row[10].parse().unwrap_or(0.0);
            places.entry(key).or_default().push((row[1].to_string(), lat, lon));
        }
        for city in &mut self.cities {
            let key = (city.country as u16, fold(&city.name));
            let held =
                places.get(&key).or_else(|| places.get(&(key.0, fold(&city.ascii))));
            let Some(codes) = held else { continue };
            let far = |held: &(String, f64, f64)| {
                kilometres((city.lat, city.lon), (held.1, held.2))
            };
            let Some(near) =
                codes.iter().min_by(|one, other| far(one).total_cmp(&far(other)))
            else {
                continue;
            };
            let here = codes.iter().filter(|held| far(held) < 25.0);
            city.partial = shared(here.map(|held| held.0.as_str()));
            city.postal = near.0.clone();
        }
    }

    fn read_metros(&mut self) {
        let states: HashMap<String, u32> = self
            .regions
            .iter()
            .enumerate()
            .filter(|(_, region)| region.iso.starts_with("US-"))
            .map(|(at, region)| (region.iso[3..].to_string(), at as u32 + 1))
            .collect();
        let listed = read::data("metros.json");
        let mut labels: Vec<(u16, String)> = listed
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(code, label)| {
                Some((code.parse().ok()?, label.as_str()?.to_string()))
            })
            .collect();
        labels.sort();
        for (code, label) in labels {
            self.metros.push(Metro { code, label: label.clone() });
            let at = self.metros.len() as u32;
            let Some((name, state)) = label.rsplit_once(", ") else { continue };
            let Some(region) = states.get(state) else { continue };
            let key = (self.country(two("US")) as u16, fold(name));
            if let Some(city) = self.named.get(&key)
                && self.cities[*city as usize].region == *region
            {
                self.cities[*city as usize].metro = at;
            }
        }
    }

    fn read_borders(&mut self, inputs: &Path) {
        let table = read::dbf(&inputs.join("ne_10m_admin_0_countries.dbf"));
        let shapes = read::shapes(&inputs.join("ne_10m_admin_0_countries.shp"));
        for (at, rings) in shapes.into_iter().enumerate() {
            if at >= table.rows.len() || rings.is_empty() {
                continue;
            }
            let code = match table.at(at, "ISO_A2_EH") {
                "-99" | "" => table.at(at, "ISO_A2"),
                held => held,
            };
            if code.len() != 2 {
                continue;
            }
            let points = rings.iter().flatten();
            let mut box_of = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for point in points {
                box_of.0 = box_of.0.min(point[0]);
                box_of.1 = box_of.1.min(point[1]);
                box_of.2 = box_of.2.max(point[0]);
                box_of.3 = box_of.3.max(point[1]);
            }
            self.borders.push((box_of.0, box_of.1, box_of.2, box_of.3, two(code), rings));
        }
    }

    /// The country whose border holds a coordinate, for a source that names none.
    pub fn holder(&self, lat: f64, lon: f64) -> [u8; 2] {
        for (west, south, east, north, code, rings) in &self.borders {
            if lon < *west || lon > *east || lat < *south || lat > *north {
                continue;
            }
            if rings.iter().any(|ring| inside(ring, lon, lat)) {
                return *code;
            }
        }
        [0, 0]
    }

    /// The nearest city in the coordinate's own country, else the nearest anywhere.
    pub fn nearest(&self, lat: f64, lon: f64, code: [u8; 2]) -> Option<(u32, f64)> {
        let country = self.country(code);
        let near = [25.0, 100.0, 500.0].into_iter().find_map(|reach| match country {
            0 => None,
            _ => self.sweep(lat, lon, reach, country),
        });
        near.or_else(|| self.sweep(lat, lon, 3000.0, 0))
    }

    fn sweep(&self, lat: f64, lon: f64, reach: f64, country: u32) -> Option<(u32, f64)> {
        let degrees = reach / 111.0;
        let stretch = lat.to_radians().cos().abs().max(0.02);
        let across = (degrees / stretch).ceil().min(180.0) as i32;
        let mut best: Option<(u32, f64)> = None;
        for down in -degrees.ceil() as i32..=degrees.ceil() as i32 {
            for over in -across..=across {
                let key = cell(lat + down as f64, lon + over as f64);
                let Some(held) = self.cells.get(&key) else { continue };
                for at in held {
                    let city = &self.cities[*at as usize];
                    if country != 0 && city.country != country {
                        continue;
                    }
                    let far = kilometres((lat, lon), (city.lat, city.lon));
                    if far <= reach && best.is_none_or(|(_, held)| far < held) {
                        best = Some((*at, far));
                    }
                }
            }
        }
        best
    }

    /// The city an operator's postal address names, matched inside its own country.
    pub fn town(&self, name: &str, code: [u8; 2]) -> u32 {
        let key = (self.country(code) as u16, fold(name));
        self.named.get(&key).map(|at| at + 1).unwrap_or(0)
    }
}

fn inside(ring: &[[f64; 2]], lon: f64, lat: f64) -> bool {
    let mut held = false;
    for pair in ring.windows(2) {
        let (one, other) = (pair[0], pair[1]);
        if (one[1] > lat) != (other[1] > lat) {
            let cut = (other[0] - one[0]) * (lat - one[1]) / (other[1] - one[1]) + one[0];
            held ^= lon < cut;
        }
    }
    held
}

/// How much of a postal code every code in the same place shares, as a length.
fn shared<'a>(codes: impl Iterator<Item = &'a str>) -> u8 {
    let mut common: Option<String> = None;
    for code in codes {
        common = Some(match common {
            None => code.to_string(),
            Some(held) => {
                let width = held
                    .bytes()
                    .zip(code.bytes())
                    .take_while(|(one, other)| one == other)
                    .count();
                held[..width].to_string()
            }
        });
    }
    common.map(|held| held.len() as u8).unwrap_or(0)
}
