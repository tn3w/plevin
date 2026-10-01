import { readFileSync, writeFileSync } from "node:fs";
import { Plevin } from "../src/index.ts";
import { File } from "../src/reader.ts";
import { FIELD_NAMES, parse } from "../src/selection.ts";

const [path = "../plevin.plv", output = "../site/fields.js"] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(path));
const db = new Plevin(bytes);
const file = new File(bytes);

type Row = Record<string, unknown>;
type Info = { about: string; needs?: string[] };
type Preset = { id: string; title: string; about: string; terms: string[]; ip: string };

const ABOUT: Record<string, string> = {
  "place.point.lat": "Latitude of the place, in degrees.",
  "place.point.lon": "Longitude of the place, in degrees.",
  "place.point.accuracy": "Radius of the area the address sits in, in kilometres.",
  "place.point.confidence": "How sure the database is of the place, 0 to 100.",
  "place.point.granularity": "Whether the place is known to the city, region or country.",
  "place.city.id": "GeoNames id of the city.",
  "place.city.name": "City name.",
  "place.city.ascii": "City name in plain ASCII.",
  "place.city.population": "People living in the city.",
  "place.city.elevation": "Metres above sea level.",
  "place.city.postal": "Postal code of the city.",
  "place.city.postal_partial": "The part of the postal code the database is sure of.",
  "place.city.timezone": "IANA timezone name.",
  "place.city.type": "What kind of place: regional capital, national capital and so on.",
  "place.city.capital": "Whether the city is a capital, and of what.",
  "place.region.id": "GeoNames id of the state or region.",
  "place.region.code": "Region code within its country.",
  "place.region.iso": "ISO 3166-2 code, like AU-QLD.",
  "place.region.name": "State or region name.",
  "place.region.type": "State, province, county and so on.",
  "place.district.id": "GeoNames id of the district.",
  "place.district.code": "District code.",
  "place.district.name": "District or county name.",
  "metro.code": "US market code (DMA) of the place.",
  "metro.label": "US market name.",
  "place.country.code": "ISO 3166-1 alpha-2 code.",
  "place.country.iso3": "ISO 3166-1 alpha-3 code.",
  "place.country.numeric": "ISO 3166-1 numeric code.",
  "place.country.name": "Country name.",
  "place.country.official": "Official long name, where it differs.",
  "place.country.common": "Everyday name, where it differs.",
  "place.country.flag": "Flag emoji.",
  "place.country.european_union": "Member of the European Union.",
  "place.country.driving_side": "Side of the road traffic keeps to.",
  "place.country.currency": "Currency code, from the country code.",
  "place.country.calling_code": "International dialling prefix, from the country code.",
  "place.country.languages": "Languages spoken, from the country code.",
  "place.time":
    "Local time, UTC offset, abbreviation and daylight saving, from the timezone.",
  "network.asn": "Autonomous system number announcing the address.",
  "network.handle": "Registry name of the network.",
  "network.prefix": "Length of the announced prefix.",
  "network.cidr": "Announced block with its first and last address, from the prefix.",
  "network.rir": "Regional internet registry that holds the block.",
  "network.country": "Country the block is registered in.",
  "network.since": "Year the block was first registered.",
  "network.rpki": "Whether route origin validation says valid, invalid or unknown.",
  "network.roas": "Route origin authorisations covering the block.",
  "network.operator.company": "Legal name of the company behind the network.",
  "network.operator.brand": "The name it goes by.",
  "network.operator.domain": "Its web domain.",
  "network.operator.website": "Its website.",
  "network.operator.category":
    "Kind of network: hosting, residential, business, cdn, education.",
  "network.operator.tier": "Place in the routing hierarchy, 1 at the top.",
  "network.operator.peering": "How widely it peers, from PeeringDB.",
  "network.operator.scope": "Geographic reach it declares.",
  "network.operator.rir": "Registry the company is registered with.",
  "network.operator.since": "Year the company first registered.",
  "network.operator.street": "Street of the registered address.",
  "network.operator.state": "State of the registered address.",
  "network.operator.postal": "Postal code of the registered address.",
  "network.operator.country": "Country of the registered address.",
  "network.operator.city": "City of the registered address, with region and district.",
  "network.operator.abuse_email": "Mailbox to report abuse to.",
  "network.carrier.user_type": "Who uses the network: residential, cellular, hosting.",
  "network.carrier.user_count": "Estimated users on the network.",
  "network.carrier.mcc": "Mobile country code.",
  "network.carrier.mnc": "Mobile network code.",
  "network.carrier.is_mobile": "The network is a mobile carrier.",
  "abuse.name": "Name the address is listed under.",
  "abuse.provider": "The service or company behind it: Tor, NordVPN, Cloudflare.",
  "abuse.service":
    "Anonymity service: tor_exit_node, anonymous_vpn, public_proxy and more.",
  "abuse.evidence": "How it is known: published, measured, reported or inferred.",
  "abuse.threat": "Kind of threat reported: botnet, scanner, spam and more.",
  "abuse.level": "Risk bucket: low, medium or high.",
  "abuse.risk": "Risk of this address, 0 to 1.",
  "abuse.network_risk": "Risk of the whole network, 0 to 1.",
  "abuse.last_seen_days": "Days since it was last reported.",
  "abuse.is_malicious": "Listed at any risk level.",
  "abuse.is_anonymous": "Tor, VPN, proxy or relay.",
  "abuse.is_anonymous_vpn": "A commercial VPN exit.",
  "abuse.is_proxy": "A public or residential proxy.",
  "abuse.is_public_proxy": "An open public proxy.",
  "abuse.is_residential_proxy": "A proxy on a home connection.",
  "abuse.is_tor_exit_node": "A Tor exit relay.",
  "abuse.is_private_relay": "An iCloud Private Relay egress.",
  "abuse.is_crawler": "A search engine crawler.",
  "abuse.is_hosting_provider": "Hosting, cloud or CDN space.",
  "abuse.is_anycast": "Announced from many places at once.",
  "abuse.is_satellite": "A satellite network such as Starlink.",
};

const DERIVED: Record<string, string[]> = {
  "place.time": ["place.city.timezone"],
  "place.city.capital": ["place.city.type"],
  "place.country.currency": ["place.country.code"],
  "place.country.calling_code": ["place.country.code"],
  "place.country.languages": ["place.country.code"],
  "network.cidr": ["network.prefix"],
};

const PRESETS: Preset[] = [
  {
    id: "country",
    title: "Country code",
    about: "Two letters per address. The smallest file that still geolocates.",
    terms: ["place.country.code"],
    ip: "8.8.8.8",
  },
  {
    id: "flag",
    title: "Country, flag and currency",
    about: "Name, flag emoji, currency and calling code for a checkout or a signup form.",
    terms: [
      "place.country.code",
      "place.country.name",
      "place.country.flag",
      "place.country.currency",
    ],
    ip: "1.1.1.1",
  },
  {
    id: "tor",
    title: "Only Tor exit nodes",
    about: "One flag, and only the rows it needs: about the size of an image.",
    terms: ["abuse.is_tor_exit_node"],
    ip: "185.220.101.1",
  },
  {
    id: "vpn",
    title: "Only commercial VPNs",
    about: "True for the exits of known VPN providers, nothing else kept.",
    terms: ["abuse.is_anonymous_vpn"],
    ip: "",
  },
  {
    id: "proxy",
    title: "Only proxies",
    about: "Public and residential proxies, with the two flags that split them.",
    terms: ["abuse.is_proxy"],
    ip: "",
  },
  {
    id: "anonymous",
    title: "Anonymisers of any kind",
    about: "Tor, VPN, proxy or relay, and which service it is.",
    terms: ["abuse.is_anonymous", "abuse.service", "abuse.provider"],
    ip: "185.220.101.1",
  },
  {
    id: "crawler",
    title: "Search engine crawlers",
    about: "Tell Googlebot and friends from everyone else.",
    terms: ["abuse.is_crawler"],
    ip: "66.249.66.1",
  },
  {
    id: "hosting",
    title: "Hosting and cloud",
    about: "Data centre, cloud and CDN space, the usual bot filter.",
    terms: ["abuse.is_hosting_provider"],
    ip: "34.117.59.81",
  },
  {
    id: "mobile",
    title: "Mobile carriers",
    about: "Is this a phone network, and which one.",
    terms: ["network.carrier.is_mobile", "network.carrier.mcc", "network.carrier.mnc"],
    ip: "",
  },
  {
    id: "fraud",
    title: "Fraud check",
    about: "Risk, level, anonymiser flags and hosting, plus the country for a geo rule.",
    terms: [
      "abuse.risk",
      "abuse.level",
      "abuse.is_anonymous",
      "abuse.is_hosting_provider",
      "place.country.code",
    ],
    ip: "185.220.101.1",
  },
  {
    id: "asn",
    title: "ASN and operator",
    about: "Who announces the address: number, handle, brand and domain.",
    terms: [
      "network.asn",
      "network.handle",
      "network.operator.brand",
      "network.operator.domain",
    ],
    ip: "1.1.1.1",
  },
  {
    id: "routing",
    title: "Routing and RPKI",
    about: "The announced block, registry, registration year and RPKI state.",
    terms: [
      "network.prefix",
      "network.rir",
      "network.country",
      "network.since",
      "network.rpki",
      "network.roas",
    ],
    ip: "1.1.1.1",
  },
  {
    id: "coordinates",
    title: "Coordinates",
    about: "Latitude, longitude and the radius they are good for.",
    terms: ["place.point.lat", "place.point.lon", "place.point.accuracy"],
    ip: "1.1.1.1",
  },
  {
    id: "city",
    title: "City and region",
    about: "City, region and country names for a display, without any coordinates.",
    terms: ["place.city.name", "place.region.name", "place.country.code"],
    ip: "1.1.1.1",
  },
  {
    id: "time",
    title: "Local time",
    about: "Timezone, local time and offset for any address.",
    terms: ["place.city.timezone", "place.time"],
    ip: "1.1.1.1",
  },
  {
    id: "full",
    title: "Everything",
    about: "Every field: the file you started from.",
    terms: ["full"],
    ip: "1.1.1.1",
  },
];

const hold = (record: Row | null | undefined, path: string[]): unknown =>
  path.reduce<unknown>((one, key) => (one as Row | null)?.[key], record);

const pathOf = (id: string): string[] => {
  const [head, second, ...rest] = id.split(".");
  if (head === "metro") return ["place", "city", "metro", second];
  if (head === "place" && second === "point") return ["place", ...rest];
  if (head === "place" && (second === "region" || second === "district")) {
    return ["place", "city", second, ...rest];
  }
  return id.split(".");
};

const GROUPS: Record<string, string> = {
  point: "Point",
  city: "City",
  region: "Region",
  district: "District",
  metro: "Metro",
  country: "Country",
  time: "Time",
  operator: "Operator",
  carrier: "Carrier",
};

const groupOf = (id: string): [string, string] => {
  const [head, second] = id.split(".");
  if (head === "metro") return ["place", "Metro"];
  if (head === "network") return ["network", GROUPS[second] ?? "Network"];
  if (head === "abuse")
    return ["abuse", id.startsWith("abuse.is_") ? "Flags" : "Standing"];
  return ["place", id === "place.time" ? "Time" : (GROUPS[second] ?? "Place")];
};

const sampled = (): string[] => {
  const sections = file.sections as Record<
    string,
    { at(row: number): number; count: number }
  >;
  const addresses: string[] = [];
  for (const [name, step] of [
    ["hosts.v4", 97],
    ["spine.v4", 211],
  ] as const) {
    for (let at = 0; at < sections[name].count; at += step) {
      const key = sections[name].at(at);
      addresses.push(
        [key >>> 24, (key >>> 16) & 255, (key >>> 8) & 255, key & 255].join("."),
      );
    }
  }
  return addresses;
};

const pool = sampled();
const candidates = ["1.1.1.1", "8.8.8.8", "185.220.101.1", "66.249.66.1", "34.117.59.81"];

const notable = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== "" && value !== false;

const shown = (value: unknown): unknown =>
  Array.isArray(value) ? value.join(", ") : value;

const example = (id: string): { ip: string; value: unknown } | null => {
  const path = id === "place.time" ? ["place", "time", "utc_offset"] : pathOf(id);
  for (const ip of [...candidates, ...pool]) {
    const value = hold(db.lookup(ip) as unknown as Row, path);
    if (notable(value)) return { ip, value: shown(value) };
  }
  return null;
};

const ids = [...FIELD_NAMES, ...Object.keys(DERIVED)];
const missing = ids.filter((id) => !(id in ABOUT));
if (missing.length) throw new Error(`no description for ${missing.join(", ")}`);

const fields = ids
  .map((id) => {
    const [group, part] = groupOf(id);
    const shownExample = example(id);
    if (!shownExample) console.warn(`no example for ${id}`);
    const info: Info & { id: string; group: string; part: string } = {
      id,
      group,
      part,
      about: ABOUT[id],
    };
    if (DERIVED[id]) info.needs = DERIVED[id];
    return { ...info, example: shownExample };
  })
  .sort((one, two) => one.id.localeCompare(two.id));

for (const preset of PRESETS) {
  const terms = preset.terms.flatMap((term) => DERIVED[term] ?? [term]).join("+");
  if (terms !== "full") parse(terms);
  if (!preset.ip) {
    const probe = [...candidates, ...pool].find((ip) => {
      const found = db.lookup(ip) as unknown as Row;
      return preset.terms.some((term) => hold(found, pathOf(term)) === true);
    });
    preset.ip = probe ?? candidates[0];
  }
}

const body = `export const FIELDS = ${JSON.stringify(fields, null, 2)};\n\nexport const PRESETS = ${JSON.stringify(PRESETS, null, 2)};\n`;
writeFileSync(output, body);
console.log(`${fields.length} fields, ${PRESETS.length} presets, ${pool.length} sampled`);
