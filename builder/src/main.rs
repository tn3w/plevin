//! plevin: one file answering where an address is, who announces it, what it has done.

mod abuse;
mod file;
mod gazetteer;
mod network;
mod place;
mod read;
mod spine;

use Kind::{Degrees, Link, Number, Signed, Text};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::time::Instant;

fn main() {
    let asked: Vec<String> = std::env::args().skip(1).collect();
    let terms = match asked.is_empty() {
        true => vec!["full".to_string()],
        false => asked,
    };
    let selections: Vec<Selection> =
        terms.iter().map(|term| Selection::parse(term)).collect();

    let inputs = Path::new("inputs");
    let dist = Path::new("dist");
    std::fs::create_dir_all(dist).expect("dist directory");

    let started = Instant::now();
    let feeds = abuse::Feeds::read(inputs);
    say(started, &format!("feeds: {} sources", feeds.sources.len()));

    let mut gazetteer = gazetteer::Gazetteer::read(inputs);
    say(started, &format!("gazetteer: {} places", gazetteer.cities.len()));

    let places = place::Places::read(inputs, &mut gazetteer);
    say(started, &format!("place: {} points", places.points.len()));

    let mut systems = network::Systems::read(inputs, &gazetteer, &feeds);
    say(started, &format!("network: {} systems", systems.rows.len()));

    let records = abuse::Records::fold(&feeds, &mut systems);
    say(started, &format!("abuse: {} records", records.rows.len()));

    let world = spine::World::new(gazetteer, places, systems, records);
    for selection in &selections {
        let written = world.write(selection);
        file::write(&dist.join(selection.file()), selection, written)
            .print(&selection.file());
        say(started, &format!("wrote {}", selection.file()));
    }
}

fn say(started: Instant, note: &str) {
    println!("[{:>6.1}s] {note}", started.elapsed().as_secs_f64());
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Number,
    Signed,
    Degrees,
    Text,
    Link,
}

pub struct Column {
    pub id: &'static str,
    pub kind: Kind,
}

impl Column {
    pub fn table(&self) -> &'static str {
        self.id.split_once('.').unwrap().0
    }

    pub fn name(&self) -> &'static str {
        self.id.split_once('.').unwrap().1
    }

    /// Absence at zero is a link and not a value, so the two read differently.
    pub fn section(&self) -> String {
        let head = if self.kind == Kind::Link { "link" } else { "col" };
        format!("{head}.{}", self.id)
    }
}

const fn column(id: &'static str, kind: Kind) -> Column {
    Column { id, kind }
}

/// Every column the build can write, in the order the file carries them.
pub const COLUMNS: &[Column] = &[
    column("region.name", Text),
    column("region.code", Text),
    column("region.iso", Text),
    column("region.type", Text),
    column("region.id", Number),
    column("region.country", Text),
    column("district.name", Text),
    column("district.code", Text),
    column("district.id", Number),
    column("metro.code", Number),
    column("metro.label", Text),
    column("city.name", Text),
    column("city.ascii", Text),
    column("city.id", Number),
    column("city.population", Number),
    column("city.type", Number),
    column("city.postal", Text),
    column("city.postal_partial", Number),
    column("city.timezone", Number),
    column("city.elevation", Signed),
    column("city.country", Text),
    column("city.metro", Link),
    column("city.region", Link),
    column("city.district", Link),
    column("place.lat", Degrees),
    column("place.lon", Degrees),
    column("place.accuracy", Number),
    column("place.granularity", Number),
    column("place.confidence", Number),
    column("place.city", Link),
    column("operator.company", Text),
    column("operator.website", Text),
    column("operator.category", Number),
    column("operator.tier", Number),
    column("operator.peering", Number),
    column("operator.scope", Text),
    column("operator.rir", Text),
    column("operator.since", Number),
    column("operator.street", Text),
    column("operator.state", Text),
    column("operator.postal", Text),
    column("operator.abuse_email", Text),
    column("operator.country", Text),
    column("operator.city", Link),
    column("carrier.user_count", Number),
    column("carrier.mcc", Number),
    column("carrier.mnc", Number),
    column("abuse.name", Text),
    column("abuse.user_type", Number),
    column("abuse.service", Number),
    column("abuse.evidence", Number),
    column("abuse.is_anycast", Number),
    column("abuse.is_satellite", Number),
    column("abuse.risk", Number),
    column("abuse.last_seen_days", Number),
    column("network.asn", Number),
    column("network.handle", Text),
    column("network.operator", Link),
    column("network.carrier", Link),
    column("network.abuse", Link),
];

/// The order rows collapse in: a table comes after everything its links point at.
pub const TABLES: &[&str] = &[
    "region", "district", "metro", "city", "place", "operator", "carrier", "abuse",
    "network",
];

/// What a boundary carries, the first three as rows and the rest as values.
pub const CARRIED: &[&str] = &["place", "network", "abuse", "prefix", "rpki", "roas"];

const COUNTRY: &[&str] = &["place.city", "city.country"];

/// Every field the model answers, and the columns each one is read from.
pub const FIELDS: &[(&str, &[&str])] = &[
    ("abuse.evidence", &["abuse.evidence"]),
    ("abuse.is_anonymous", &["abuse.service"]),
    ("abuse.is_anonymous_vpn", &["abuse.service"]),
    ("abuse.is_anycast", &["abuse.is_anycast"]),
    ("abuse.is_hosting_provider", &["abuse.user_type", "operator.category"]),
    ("abuse.is_private_relay", &["abuse.service"]),
    ("abuse.is_proxy", &["abuse.service"]),
    ("abuse.is_public_proxy", &["abuse.service"]),
    ("abuse.is_residential_proxy", &["abuse.service"]),
    ("abuse.is_satellite", &["network.abuse", "abuse.is_satellite"]),
    ("abuse.is_tor_exit_node", &["abuse.service"]),
    ("abuse.last_seen_days", &["abuse.last_seen_days"]),
    ("abuse.name", &["abuse.name"]),
    ("abuse.network_risk", &["network.abuse", "abuse.risk"]),
    ("abuse.risk", &["abuse.risk"]),
    ("abuse.service", &["abuse.service"]),
    ("metro.code", &["place.city", "city.metro", "metro.code"]),
    ("metro.label", &["place.city", "city.metro", "metro.label"]),
    ("network.asn", &["network.asn"]),
    ("network.carrier.is_mobile", &["abuse.user_type", "operator.category"]),
    ("network.carrier.mcc", &["network.carrier", "carrier.mcc"]),
    ("network.carrier.mnc", &["network.carrier", "carrier.mnc"]),
    ("network.carrier.user_count", &["network.carrier", "carrier.user_count"]),
    ("network.carrier.user_type", &["abuse.user_type", "operator.category"]),
    ("network.handle", &["network.handle"]),
    ("network.operator.abuse_email", &["network.operator", "operator.abuse_email"]),
    (
        "network.operator.brand",
        &["network.handle", "network.operator", "operator.company"],
    ),
    ("network.operator.category", &["network.operator", "operator.category"]),
    (
        "network.operator.city",
        &["network.operator", "operator.city", "city.name", "city.id"],
    ),
    ("network.operator.company", &["network.operator", "operator.company"]),
    ("network.operator.country", &["network.operator", "operator.country"]),
    (
        "network.operator.domain",
        &["network.operator", "operator.website", "operator.abuse_email"],
    ),
    ("network.operator.peering", &["network.operator", "operator.peering"]),
    ("network.operator.postal", &["network.operator", "operator.postal"]),
    ("network.operator.rir", &["network.operator", "operator.rir"]),
    ("network.operator.scope", &["network.operator", "operator.scope"]),
    ("network.operator.since", &["network.operator", "operator.since"]),
    ("network.operator.state", &["network.operator", "operator.state"]),
    ("network.operator.street", &["network.operator", "operator.street"]),
    ("network.operator.tier", &["network.operator", "operator.tier"]),
    ("network.operator.website", &["network.operator", "operator.website"]),
    ("network.prefix", &["spine.prefix"]),
    ("network.roas", &["spine.roas"]),
    ("network.rpki", &["spine.rpki"]),
    ("place.city.ascii", &["place.city", "city.ascii"]),
    ("place.city.elevation", &["place.city", "city.elevation"]),
    ("place.city.id", &["place.city", "city.id"]),
    ("place.city.name", &["place.city", "city.name"]),
    ("place.city.population", &["place.city", "city.population"]),
    ("place.city.postal", &["place.city", "city.postal"]),
    ("place.city.postal_partial", &["place.city", "city.postal", "city.postal_partial"]),
    ("place.city.timezone", &["place.city", "city.timezone"]),
    ("place.city.type", &["place.city", "city.type"]),
    ("place.country.code", COUNTRY),
    ("place.country.common", COUNTRY),
    ("place.country.driving_side", COUNTRY),
    ("place.country.european_union", COUNTRY),
    ("place.country.flag", COUNTRY),
    ("place.country.iso3", COUNTRY),
    ("place.country.name", COUNTRY),
    ("place.country.numeric", COUNTRY),
    ("place.country.official", COUNTRY),
    ("place.district.code", &["place.city", "city.district", "district.code"]),
    ("place.district.id", &["place.city", "city.district", "district.id"]),
    ("place.district.name", &["place.city", "city.district", "district.name"]),
    ("place.point.accuracy", &["place.accuracy"]),
    ("place.point.confidence", &["place.confidence"]),
    ("place.point.granularity", &["place.granularity"]),
    ("place.point.lat", &["place.lat"]),
    ("place.point.lon", &["place.lon"]),
    ("place.region.code", &["place.city", "city.region", "region.code"]),
    ("place.region.id", &["place.city", "city.region", "region.id"]),
    ("place.region.iso", &["place.city", "city.region", "region.iso"]),
    ("place.region.name", &["place.city", "city.region", "region.name"]),
    ("place.region.type", &["place.city", "city.region", "region.type"]),
];

/// A derived boolean is one value of its column: a build for it keeps only that value.
pub const NARROW: &[(&str, &str, &[&str])] = &[
    ("abuse.is_tor_exit_node", "abuse.service", &["tor_exit_node"]),
    ("abuse.is_private_relay", "abuse.service", &["private_relay"]),
    ("abuse.is_anonymous_vpn", "abuse.service", &["anonymous_vpn"]),
    ("abuse.is_public_proxy", "abuse.service", &["public_proxy"]),
    ("abuse.is_residential_proxy", "abuse.service", &["residential_proxy"]),
    ("abuse.is_proxy", "abuse.service", &["public_proxy", "residential_proxy"]),
    ("abuse.is_hosting_provider", "abuse.user_type", SERVERS),
    ("abuse.is_hosting_provider", "operator.category", SERVERS),
    ("network.carrier.is_mobile", "abuse.user_type", &["cellular"]),
    ("network.carrier.is_mobile", "operator.category", &["cellular"]),
];

const SERVERS: &[&str] = &["hosting", "cdn", "content"];

pub const CATEGORIES: &[&str] = &[
    "",
    "residential",
    "business",
    "hosting",
    "education",
    "government",
    "military",
    "cdn",
    "content",
    "infrastructure",
    "cellular",
    "search_engine_spider",
    "traveler",
    "transit",
    "exchange",
    "non-profit",
];
pub const SERVICES: &[&str] = &[
    "",
    "public_proxy",
    "residential_proxy",
    "anonymous_vpn",
    "tor_exit_node",
    "private_relay",
];
pub const EVIDENCE: &[&str] = &["", "published", "measured", "reported", "inferred"];
pub const GRANULARITY: &[&str] = &["city", "region", "country"];
pub const RPKI: &[&str] = &["unknown", "valid", "invalid"];
pub const PLACE_TYPES: &[&str] = &[
    "city",
    "regional capital",
    "district capital",
    "third-order capital",
    "fourth-order capital",
    "fifth-order capital",
    "national capital",
    "former national capital",
    "farming village",
    "seat of government",
    "former settlement",
    "populated locality",
    "abandoned settlement",
    "religious settlement",
    "populated places",
    "destroyed settlement",
    "section of city",
    "israeli settlement",
];

/// The services, most specific first: a claim only loses to one further left.
pub const SPECIFIC: &[&str] = &[
    "tor_exit_node",
    "private_relay",
    "anonymous_vpn",
    "residential_proxy",
    "public_proxy",
];

pub const UNSEEN: u8 = 255;

/// Where a word sits in its vocabulary, which is what the file stores.
pub fn word(book: &[&str], value: &str) -> u8 {
    book.iter().position(|name| *name == value).unwrap_or(0) as u8
}

/// A name inside another, on word boundaries: `metro` is not `metropolitan`.
pub fn worded(text: &str, needle: &str) -> bool {
    if needle.len() < 3 {
        return false;
    }
    let edge = |point: Option<char>| point.is_none_or(|held| !held.is_alphanumeric());
    text.match_indices(needle).any(|(at, _)| {
        edge(text[..at].chars().next_back())
            && edge(text[at + needle.len()..].chars().next())
    })
}

/// The vocabularies a file carries, timezones only where a column stores one.
pub fn vocabularies(zones: Option<&[String]>) -> Vec<(&'static str, Vec<String>)> {
    let named = |book: &[&str]| book.iter().map(|held| held.to_string()).collect();
    let mut books = vec![
        ("categories", named(CATEGORIES)),
        ("services", named(SERVICES)),
        ("evidence", named(EVIDENCE)),
        ("granularity", named(GRANULARITY)),
        ("rpki", named(RPKI)),
        ("place_types", named(PLACE_TYPES)),
    ];
    if let Some(zones) = zones {
        books.push(("timezones", zones.to_vec()));
    }
    books
}

fn covers(term: &str, field: &str) -> bool {
    field == term || field.strip_prefix(term).is_some_and(|rest| rest.starts_with('.'))
}

fn book(column: &str) -> &'static [&'static str] {
    match column {
        "abuse.service" => SERVICES,
        "abuse.user_type" | "operator.category" => CATEGORIES,
        _ => &[],
    }
}

/// What a field needs of a column: every value it reads, or the one it asks about.
fn asks(field: &str, column: &str) -> Option<Vec<i64>> {
    let held: Vec<&&[&str]> = NARROW
        .iter()
        .filter(|(one, two, _)| *one == field && *two == column)
        .map(|(_, _, values)| values)
        .collect();
    match held.is_empty() {
        true => None,
        false => Some(
            held.iter()
                .flat_map(|values| values.iter())
                .map(|value| word(book(column), value) as i64)
                .collect(),
        ),
    }
}

/// A build: the terms asked for, the columns they need, the fields they answer.
pub struct Selection {
    pub name: String,
    pub columns: BTreeSet<String>,
    pub narrow: HashMap<String, Option<Vec<i64>>>,
    pub fields: Vec<String>,
}

impl Selection {
    pub fn parse(terms: &str) -> Selection {
        let mut parts: Vec<&str> =
            terms.split('+').filter(|term| !term.is_empty()).collect();
        parts.sort_unstable();
        parts.dedup();
        let chosen: Vec<&'static str> = FIELDS
            .iter()
            .filter(|(field, _)| {
                terms == "full" || parts.iter().any(|term| covers(term, field))
            })
            .map(|(field, _)| *field)
            .collect();
        let mut columns = BTreeSet::new();
        for (_, needs) in FIELDS.iter().filter(|(field, _)| chosen.contains(field)) {
            columns.extend(needs.iter().map(|need| need.to_string()));
        }
        let name = match terms {
            "full" => "full".to_string(),
            _ => parts.join("+"),
        };
        Selection::over(name, columns, &chosen)
    }

    fn over(name: String, mut columns: BTreeSet<String>, chosen: &[&str]) -> Selection {
        if columns.iter().any(|id| id.starts_with("region."))
            && columns.contains("city.country")
        {
            columns.insert("region.country".into());
        }
        let mut narrow: HashMap<String, Option<Vec<i64>>> = HashMap::new();
        for (field, needs) in FIELDS.iter().filter(|(field, _)| chosen.contains(field)) {
            for need in *needs {
                let held =
                    narrow.entry(need.to_string()).or_insert_with(|| asks(field, need));
                match (held.as_mut(), asks(field, need)) {
                    (Some(kept), Some(more)) => kept.extend(more),
                    _ => *held = None,
                }
            }
        }
        let answers = |field: &str, needs: &[&str]| {
            needs.iter().all(|need| match narrow.get(*need) {
                None => false,
                Some(None) => true,
                Some(Some(kept)) => asks(field, need)
                    .is_some_and(|mine| mine.iter().all(|one| kept.contains(one))),
            })
        };
        let fields = FIELDS
            .iter()
            .filter(|(field, needs)| answers(field, needs))
            .map(|(field, _)| field.to_string())
            .collect();
        Selection { name, columns, narrow, fields }
    }

    pub fn has(&self, id: &str) -> bool {
        self.columns.contains(id)
    }

    pub fn table(&self, table: &str) -> bool {
        COLUMNS.iter().any(|held| held.table() == table && self.has(held.id))
    }

    pub fn file(&self) -> String {
        match self.name.as_str() {
            "full" => "plevin.plv".into(),
            other => format!("plevin.{}.plv", other.replace(['.', '+'], "-")),
        }
    }
}
