/** What the estimator needs to know about one database, counted once, a few kilobytes. */

import {
  ABUSE_LEAVES,
  HOST_SHIFT,
  LEAVES,
  type Masks,
  OPERATOR_LOW,
  POINT_LOW,
  RECORD_COLUMNS,
} from "./leaves.ts";
import { type Carried, COLUMNS, section, TABLES } from "./selection.ts";
import { indexSize, type Keys } from "./writer.ts";

export type Columns = Record<Carried, ArrayLike<number>>;
export type Spine = { columns: Columns; whole: ArrayLike<number> };

/** The decoded database as the counter reads it. */
export type Kit = {
  head: {
    built: string;
    fields: string[];
    sections: Record<string, { bytes: number; count: number }>;
  };
  has: (name: string) => boolean;
  numbers: (name: string) => ArrayLike<number>;
  pool: () => string[];
  spine: (version: number, coarse: boolean) => Spine | null;
  hosts: (version: number) => ArrayLike<number>;
  keys: (version: number) => {
    hosts: ArrayLike<number | bigint>;
    spine: ArrayLike<number | bigint>;
  };
};

export type Stats = {
  built: string;
  fields: string[];
  bytes: Record<string, number>;
  tables: Record<string, { rows: number; columns: Record<string, [number, number]> }>;
  strings: [number, number];
  spines: Record<string, Variants>;
  reach: { refined: Record<string, number>; snapped: Record<string, number> };
  hosts: Record<
    string,
    { count: number; masks: Masks; rates: Record<string, [number, number]> }
  >;
};

type Variant = { masks: Masks; served: number };
type Variants = { stops: number; refined: Variant; snapped: Variant | null };
type Leaves = Map<string, Float64Array>;
type Sides = { place: Leaves; network: Leaves; abuse: Leaves };

const encoder = new TextEncoder();
const SERVERS = [3, 7, 8];
const KIND_RANGES: [string, (value: number) => boolean][] = [
  ["kind.cellular", (value) => value === 10],
  ["kind.crawler", (value) => value === 11],
  ["kind.servers", (value) => SERVERS.includes(value)],
];

const padded = (kit: Kit, name: string, size = 0): Float64Array => {
  if (!kit.has(name)) return new Float64Array(size + 1);
  const values = kit.numbers(name);
  const out = new Float64Array(values.length + 1);
  out.set(values, 1);
  return out;
};

const through = (links: Float64Array, values: Float64Array): Float64Array =>
  links.map((link) => values[link] ?? 0);

const marks = (values: Float64Array, test: (value: number) => boolean): Float64Array =>
  values.map((value) => (test(value) ? 1 : 0));

const tupled = (columns: Float64Array[]): Float64Array => {
  const known = new Map<string, number>();
  return columns[0].map((_, at) => {
    const key = columns.map((column) => column[at]).join(",");
    if (!known.has(key)) known.set(key, known.size);
    return known.get(key) as number;
  });
};

const identity = (values: Float64Array): Float64Array =>
  Float64Array.from(values, (_, at) => at);

const kindLeaves = (values: Float64Array, prefix = ""): Leaves => {
  const leaves: Leaves = new Map();
  for (const [name, test] of KIND_RANGES) leaves.set(prefix + name, marks(values, test));
  leaves.set(`${prefix}kind.any`, values);
  return leaves;
};

const abuseSide = (kit: Kit): Leaves => {
  const service = padded(kit, "col.abuse.service");
  const rows = service.length - 1;
  const leaves = kindLeaves(padded(kit, "col.abuse.user_type", rows));
  for (const value of [1, 2, 3, 4, 5]) {
    leaves.set(
      `service${value}`,
      marks(service, (held) => held === value),
    );
  }
  for (const [name, columns] of Object.entries(RECORD_COLUMNS)) {
    leaves.set(name, tupled(columns.map((id) => padded(kit, `col.${id}`, rows))));
  }
  return leaves;
};

const placeSide = (kit: Kit): Leaves => {
  const points = padded(kit, "link.place.city");
  const cities = (name: string) => padded(kit, `col.city.${name}`);
  const links = (name: string) => padded(kit, `link.city.${name}`);
  const leaves: Leaves = new Map();
  leaves.set("point", identity(points));
  for (const name of POINT_LOW) {
    leaves.set(`place.${name}`, padded(kit, `col.place.${name}`, points.length - 1));
  }
  leaves.set("city", points);
  leaves.set("city.postal_partial", through(points, cities("postal_partial")));
  leaves.set("city.type", through(points, cities("type")));
  leaves.set("city.timezone", through(points, cities("timezone")));
  leaves.set("city.country", through(points, cities("country")));
  leaves.set("region", through(points, links("region")));
  leaves.set("district", through(points, links("district")));
  leaves.set("metro", through(points, links("metro")));
  return leaves;
};

const networkSide = (kit: Kit, abuse: Leaves): Leaves => {
  const operators = padded(kit, "link.network.operator");
  const leaves: Leaves = new Map();
  leaves.set("network", identity(operators));
  const asns = padded(kit, "col.network.asn", operators.length - 1);
  leaves.set(
    "network.asn",
    identity(operators).map((row, at) => (asns[at] ? row : 0)),
  );
  leaves.set("operator", operators);
  for (const name of OPERATOR_LOW) {
    leaves.set(
      `operator.${name}`,
      through(operators, padded(kit, `col.operator.${name}`)),
    );
  }
  const carriers = padded(kit, "link.network.carrier", operators.length - 1);
  leaves.set("carrier", carriers);
  for (const name of ["mcc", "mnc"]) {
    leaves.set(`carrier.${name}`, through(carriers, padded(kit, `col.carrier.${name}`)));
  }
  const category = through(operators, padded(kit, "col.operator.category"));
  for (const [name, values] of kindLeaves(category, "category."))
    leaves.set(name, values);
  const linked = padded(kit, "link.network.abuse", operators.length - 1);
  for (const name of ABUSE_LEAVES) {
    leaves.set(`net.${name}`, through(linked, abuse.get(name) as Float64Array));
  }
  return leaves;
};

const KEPT = 1500;

const distance = (one: number[], two: number[]): number => {
  let bits = 0;
  for (let at = 0; at < one.length - 1; at += 1) {
    for (let rest = (one[at] ^ two[at]) >>> 0; rest; rest &= rest - 1) bits += 1;
  }
  return bits;
};

const folded = (masks: Masks): Masks => {
  const sorted = [...masks].sort((one, two) => two[one.length - 1] - one[one.length - 1]);
  const kept = sorted.slice(0, KEPT);
  for (const rare of sorted.slice(KEPT)) {
    let best = kept[0];
    let nearest = Number.POSITIVE_INFINITY;
    for (const mask of kept) {
      const apart = distance(mask, rare);
      if (apart < nearest) [best, nearest] = [mask, apart];
    }
    best[best.length - 1] += rare[rare.length - 1];
  }
  return kept;
};

const pattern = (masks: Map<string, number[]>, words: number[]): void => {
  const key = words.join(",");
  const found = masks.get(key);
  if (found) found[words.length] += 1;
  else masks.set(key, [...words, 1]);
};

const leafValues = (sides: Sides, id: string): Float64Array => {
  if (/^(stop|whole)\./.test(id)) {
    return sides.abuse.get(id.replace(/^(stop|whole)\./, "")) as Float64Array;
  }
  return (sides.place.get(id) ?? sides.network.get(id)) as Float64Array;
};

const histogram = (spine: Spine, sides: Sides): Masks => {
  const links = {
    place: spine.columns.place,
    network: spine.columns.network,
    stop: spine.columns.abuse,
    whole: spine.whole,
  };
  const owned = LEAVES.map((leaf, bit) => ({ leaf, bit }));
  const groups = Object.entries(links).map(([owner, held]) => ({
    links: held,
    leaves: owned
      .filter(({ leaf }) => leaf.owner === owner)
      .map(({ leaf, bit }) => ({ bit, values: leafValues(sides, leaf.id) })),
  }));
  const carried = owned
    .filter(({ leaf }) => leaf.owner === "spine")
    .map(({ leaf, bit }) => ({ bit, name: leaf.id }));
  const masks = new Map<string, number[]>();
  const words = [0, 0, 0, 0];
  for (let at = 1; at < spine.columns.place.length; at += 1) {
    words.fill(0);
    for (const group of groups) {
      const now = group.links[at];
      const before = group.links[at - 1];
      if (now === before) continue;
      for (const { bit, values } of group.leaves) {
        if (values[now] !== values[before]) words[bit >> 5] |= 1 << (bit & 31);
      }
    }
    for (const { bit, name } of carried) {
      const values = spine.columns[name as Carried];
      if (values[at] !== values[at - 1]) words[bit >> 5] |= 1 << (bit & 31);
    }
    pattern(masks, words);
  }
  return folded([...masks.values()]);
};

const served = (spine: Spine, kit: Kit): number => {
  const service = padded(kit, "col.abuse.service");
  let total = 0;
  for (let at = 0; at < spine.whole.length; at += 1) {
    if (service[spine.whole[at]] > 0) total += 1;
  }
  return total;
};

const flagged = (links: ArrayLike<number>, size: number, into = new Uint8Array(size)) => {
  for (let at = 0; at < links.length; at += 1) if (links[at] > 0) into[links[at] - 1] = 1;
  return into;
};

const follow = (from: Uint8Array, links: Float64Array, into: Uint8Array): void => {
  for (let at = 0; at < from.length; at += 1) {
    if (from[at] && links[at + 1] > 0) into[links[at + 1] - 1] = 1;
  }
};

const total = (flags: Uint8Array): number => flags.reduce((sum, flag) => sum + flag, 0);

const reached = (
  kit: Kit,
  spines: Spine[],
  hosts: ArrayLike<number>[],
): Record<string, number> => {
  const size = (name: string): number => (kit.has(name) ? kit.numbers(name).length : 0);
  const places = new Uint8Array(size("link.place.city"));
  const networks = new Uint8Array(size("link.network.operator"));
  const abuse = new Uint8Array(size("col.abuse.service"));
  for (const spine of spines) {
    flagged(spine.columns.place, places.length, places);
    flagged(spine.columns.network, networks.length, networks);
    flagged(spine.columns.abuse, abuse.length, abuse);
    flagged(spine.whole, abuse.length, abuse);
  }
  for (const links of hosts) flagged(links, abuse.length, abuse);
  const operators = new Uint8Array(size("col.operator.company"));
  const carriers = new Uint8Array(size("col.carrier.user_count"));
  const cities = new Uint8Array(size("col.city.name"));
  follow(networks, padded(kit, "link.network.operator"), operators);
  follow(networks, padded(kit, "link.network.carrier"), carriers);
  follow(networks, padded(kit, "link.network.abuse"), abuse);
  follow(operators, padded(kit, "link.operator.city"), cities);
  follow(places, padded(kit, "link.place.city"), cities);
  const regions = new Uint8Array(size("col.region.name"));
  const districts = new Uint8Array(size("col.district.name"));
  const metros = new Uint8Array(size("col.metro.code"));
  follow(cities, padded(kit, "link.city.region"), regions);
  follow(cities, padded(kit, "link.city.district"), districts);
  follow(cities, padded(kit, "link.city.metro"), metros);
  return {
    place: total(places),
    network: total(networks),
    abuse: total(abuse),
    operator: total(operators),
    carrier: total(carriers),
    city: total(cities),
    region: total(regions),
    district: total(districts),
    metro: total(metros),
  };
};

const variant = (spine: Spine, sides: Sides, kit: Kit): Variant => ({
  masks: histogram(spine, sides),
  served: served(spine, kit),
});

const standing = (keys: ArrayLike<number | bigint>, address: number | bigint): number => {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (keys[middle] <= address) low = middle + 1;
    else high = middle;
  }
  return low - 1;
};

const hostRates = (
  kit: Kit,
  version: number,
  abuse: Leaves,
): Record<string, [number, number]> => {
  const links = kit.hosts(version);
  const { hosts } = kit.keys(version);
  const rates: Record<string, [number, number]> = {};
  for (const name of ABUSE_LEAVES) {
    const values = abuse.get(name) as Float64Array;
    const keys: (number | bigint)[] = [];
    for (let at = 0; at < links.length; at += 1)
      if (values[links[at]]) keys.push(hosts[at]);
    rates[name] = [keys.length, keys.length ? indexSize(keys as Keys, version === 6) : 0];
  }
  return rates;
};

const hostMasks = (kit: Kit, version: number, spine: Spine, abuse: Leaves): Masks => {
  const links = kit.hosts(version);
  const { hosts, spine: keys } = kit.keys(version);
  const masks = new Map<string, number[]>();
  const held = ABUSE_LEAVES.map((name, bit) => ({
    bit,
    values: abuse.get(name) as Float64Array,
  }));
  const words = [0, 0, 0, 0];
  const set = (bit: number): void => {
    words[bit >> 5] |= 1 << (bit & 31);
  };
  for (let at = 0; at < links.length; at += 1) {
    words.fill(0);
    const stop = standing(keys, hosts[at]);
    const beside = {
      stop: spine.columns.abuse[stop] ?? 0,
      whole: spine.whole[stop] ?? 0,
    };
    for (const { bit, values } of held) {
      const own = values[links[at]];
      if (own) set(bit);
      if (own !== values[beside.stop]) set(HOST_SHIFT.stop + bit);
      if (own !== values[beside.whole]) set(HOST_SHIFT.whole + bit);
    }
    pattern(masks, words);
  }
  return folded([...masks.values()]);
};

const tableStats = (kit: Kit): Stats["tables"] => {
  const pool = kit.pool();
  const lengths = new Map<number, number>();
  const length = (id: number): number => {
    if (!lengths.has(id)) lengths.set(id, encoder.encode(pool[id - 1]).length);
    return lengths.get(id) as number;
  };
  const tables: Stats["tables"] = {};
  for (const name of TABLES) {
    tables[name] = { rows: 0, columns: {} };
    for (const column of COLUMNS.filter((one) => one.table === name)) {
      if (!kit.has(section(column))) continue;
      const values = kit.numbers(section(column));
      const distinct = new Set<number>(Array.from(values));
      distinct.delete(0);
      let mass = 0;
      if (column.kind === "text") for (const id of distinct) mass += length(id);
      tables[name].rows = values.length;
      tables[name].columns[column.id] = [distinct.size, mass];
    }
  }
  return tables;
};

/** Counts everything the estimator reads: the one slow step, done when a file is built. */
export const collect = (kit: Kit): Stats => {
  const abuse = abuseSide(kit);
  const sides: Sides = { place: placeSide(kit), network: networkSide(kit, abuse), abuse };
  const spines: Stats["spines"] = {};
  const hosts: Stats["hosts"] = {};
  const kept = {
    refined: [] as Spine[],
    snapped: [] as Spine[],
    hosts: [] as ArrayLike<number>[],
  };
  for (const version of [4, 6]) {
    const refined = kit.spine(version, false);
    if (!refined) continue;
    const coarse = kit.spine(version, true);
    const links = kit.hosts(version);
    kept.refined.push(refined);
    kept.snapped.push(coarse ?? refined);
    kept.hosts.push(links);
    spines[`v${version}`] = {
      stops: refined.columns.place.length,
      refined: variant(refined, sides, kit),
      snapped: coarse ? variant(coarse, sides, kit) : null,
    };
    hosts[`v${version}`] = {
      count: links.length,
      masks: hostMasks(kit, version, refined, abuse),
      rates: hostRates(kit, version, abuse),
    };
  }
  const sections = kit.head.sections;
  return {
    built: kit.head.built,
    fields: kit.head.fields,
    bytes: Object.fromEntries(
      Object.entries(sections).map(([name, one]) => [name, one.bytes]),
    ),
    tables: tableStats(kit),
    strings: [sections.strings?.count ?? 0, sections.strings?.bytes ?? 0],
    spines,
    hosts,
    reach: {
      refined: reached(kit, kept.refined, kept.hosts),
      snapped: reached(kit, kept.snapped, kept.hosts),
    },
  };
};
