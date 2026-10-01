/** A file's size from counted facts about the database: no decoding, no repacking. */

import {
  ABUSE_LEAVES,
  counted,
  HOST_SHIFT,
  leafAt,
  type Masks,
  type Owner,
  touches,
  wanted,
  wantsAbuse,
  wordsOf,
} from "./leaves.ts";
import {
  COLUMNS,
  type Column,
  ORDERED,
  parse,
  type Selection,
  section,
  TABLES,
} from "./selection.ts";
import type { Stats } from "./stats.ts";

type Variant = Stats["spines"][string]["refined"];
type Rate = Record<string, number>;
export type Parts = Record<string, number>;

export const RATES = {
  index: {
    v4: { dense: 0.582, coarse: 0.812, sparse: 0.759 },
    v6: { dense: 0.0225, coarse: 0.0386, sparse: 0.2 },
  } as Record<string, Rate>,
  place: { change: 0.961, stop: 0.52 },
  network: { change: 0.879, stop: 0.177 },
  abuse: {
    stop: 0.0126,
    service: 0.000635,
    kind: 0.0301,
    risk: 0.15,
    level: 0.402,
    evidence: 0.00317,
    threat: 0.00317,
    name: 0.0038,
    anycast: 0.000635,
    satellite: 0.00063,
    seen: 0.0409,
  } as Rate,
  carried: { change: 0.244, stop: 0.0755 },
  hostIndex: 0.907,
  hostAbuse: {
    service: 0.000506,
    kind: 0.000317,
    risk: 0.166,
    level: 0.0278,
    evidence: 0.00254,
    threat: 0.0851,
    name: 0.00254,
    anycast: 0.00127,
    satellite: 0.00127,
    seen: 0.251,
  } as Rate,
  rows: 7.52,
  brand: 0.4,
  floor: 441,
  primaryText: 0.0014,
  primaryNumber: 2.05,
  secondary: 4.08,
  strings: 1.28,
  header: 4090,
  perSection: 57.9,
  perField: 318,
};

const NON_NETWORK: Owner[] = ["place", "stop", "whole", "spine"];
const ABUSE_OWNERS: Owner[] = ["stop", "whole"];
const SPINE_COLUMNS = ["prefix", "rir", "country", "since", "rpki", "roas"];
const GROUPS = [
  "service",
  "kind",
  "risk",
  "level",
  "evidence",
  "threat",
  "name",
  "anycast",
  "satellite",
  "seen",
];

const log2 = (value: number): number => Math.log2(Math.max(value, 2));

const groupOf = (leaf: string): string => {
  if (leaf.startsWith("service")) return "service";
  return leaf.startsWith("kind.") ? "kind" : leaf;
};

const abuseGroups = (selection: Selection): string[] =>
  GROUPS.filter((group) =>
    ABUSE_LEAVES.some((leaf) => groupOf(leaf) === group && wantsAbuse(selection, leaf)),
  );

const total = (masks: Masks): number => masks.reduce((held, mask) => held + mask[4], 1);

type Counts = {
  stops: number;
  dense: number;
  coarse: number;
  sparse: number;
  place: number;
  network: number;
  abuse: number;
  carried: Record<string, number>;
};

const countsOf = (variant: Variant, selection: Selection): Counts => {
  const { masks } = variant;
  const share = selection.sparse ? variant.served / total(masks) : 1;
  const count = (owners?: Owner[]): number => counted(masks, wanted(selection, owners));
  const settled = count(NON_NETWORK);
  const stops = 1 + settled + share * (count() - settled);
  const abuse = count(ABUSE_OWNERS);
  const sparse = abuse + share * (count(["network", ...ABUSE_OWNERS]) - abuse);
  const coarse = Math.max(
    count(["network", ...ABUSE_OWNERS, "spine"]) - count(["network", ...ABUSE_OWNERS]),
    0,
  );
  const carried: Record<string, number> = {};
  for (const name of SPINE_COLUMNS) {
    carried[name] = selection.has(`spine.${name}`)
      ? counted(masks, wordsOf([leafAt(name)]))
      : 0;
  }
  return {
    stops,
    sparse,
    coarse,
    dense: Math.max(stops - sparse - coarse, 0),
    place: count(["place"]),
    network: share * count(["network"]),
    abuse: count(selection.has("network.abuse") ? ["stop"] : ["whole"]),
    carried,
  };
};

type Known = { distinct: number; mass: number; bytes: number };

const known = (stats: Stats, column: Column): Known | null => {
  const brand = column.id === "network.brand" && !stats.tables.network.columns[column.id];
  const [at, from] = brand
    ? ["operator.company", "col.operator.company"]
    : [column.id, section(column)];
  const held = stats.tables[brand ? "operator" : column.table]?.columns[at];
  if (!held) return null;
  return {
    distinct: held[0],
    mass: held[1],
    bytes: stats.bytes[from] * (brand ? RATES.brand : 1),
  };
};

const rowsOf = (stats: Stats, selection: Selection): Record<string, number> => {
  const reach = selection.has("place.lat") ? stats.reach.refined : stats.reach.snapped;
  const rows: Record<string, number> = {};
  for (const table of TABLES) {
    const columns = COLUMNS.filter((one) => one.table === table && selection.has(one.id));
    const held = stats.tables[table];
    rows[table] = 0;
    if (columns.length === 0 || !held) continue;
    let most = 1;
    for (const column of columns) {
      const distinct = known(stats, column)?.distinct ?? held.rows;
      const narrowed = selection.narrow.get(column.id);
      const target = rows[column.name];
      const size = narrowed ? narrowed.length + 1 : distinct;
      most = Math.max(
        most,
        column.kind === "link" && target !== undefined ? target : size,
      );
    }
    rows[table] = Math.min(most, reach[table] ?? held.rows);
  }
  return rows;
};

const spineParts = (
  stats: Stats,
  selection: Selection,
  rows: Record<string, number>,
): Parts => {
  const parts: Parts = {};
  const coarse = !selection.has("place.lat");
  const groups = abuseGroups(selection);
  for (const [family, held] of Object.entries(stats.spines)) {
    const counts = countsOf((coarse && held.snapped) || held.refined, selection);
    const index = RATES.index[family];
    const keys = counts.dense * index.dense + counts.coarse * index.coarse;
    parts[`spine.${family}`] = keys + counts.sparse * index.sparse;
    const scale = (table: string): number => log2(rows[table]) / 17;
    const still = (changes: number): number => counts.stops - changes;
    if (selection.table("place")) {
      const bytes =
        counts.place * RATES.place.change + still(counts.place) * RATES.place.stop;
      parts[`spine.${family}.place`] = bytes * scale("place");
    }
    if (selection.table("network")) {
      const rate = RATES.network;
      const bytes = counts.network * rate.change + still(counts.network) * rate.stop;
      parts[`spine.${family}.network`] = bytes * scale("network");
    }
    if (selection.table("abuse")) {
      const each = groups.reduce((held, group) => held + RATES.abuse[group], 0);
      parts[`spine.${family}.abuse`] =
        counts.abuse * each + counts.stops * RATES.abuse.stop;
    }
    for (const name of SPINE_COLUMNS) {
      if (!selection.has(`spine.${name}`) || !stats.bytes[`spine.${family}.${name}`])
        continue;
      const changes = counts.carried[name];
      const rate = RATES.carried;
      parts[`spine.${family}.${name}`] =
        changes * rate.change + still(changes) * rate.stop;
    }
  }
  return parts;
};

const hostCount = (masks: Masks, selection: Selection): number => {
  const leaves: number[] = [];
  ABUSE_LEAVES.forEach((name, at) => {
    if (wantsAbuse(selection, name)) leaves.push(at);
  });
  const shift = selection.has("network.abuse") ? HOST_SHIFT.stop : HOST_SHIFT.whole;
  const present = wordsOf(leaves);
  const differs = wordsOf(leaves.map((at) => at + shift));
  let kept = 0;
  for (const mask of masks) {
    if (touches(mask, present) && touches(mask, differs)) kept += mask[4];
  }
  return kept;
};

const hostRate = (held: Stats["hosts"][string], selection: Selection): number => {
  let count = 0;
  let bytes = 0;
  for (const leaf of ABUSE_LEAVES) {
    const [hosts, size] = held.rates[leaf] ?? [0, 0];
    if (!wantsAbuse(selection, leaf)) continue;
    count += hosts;
    bytes += size;
  }
  return count ? bytes / count : 0;
};

const hostParts = (stats: Stats, selection: Selection): Parts => {
  const parts: Parts = {};
  if (!selection.table("abuse")) return parts;
  const named = abuseGroups(selection);
  const groups = named.filter((group) => group !== "level" || !named.includes("risk"));
  for (const [family, held] of Object.entries(stats.hosts)) {
    const kept = hostCount(held.masks, selection);
    parts[`hosts.${family}`] = kept * hostRate(held, selection) * RATES.hostIndex;
    const each = groups.reduce((sum, group) => sum + RATES.hostAbuse[group], 0.004);
    parts[`hosts.${family}.abuse`] = kept * each;
  }
  return parts;
};

const tableParts = (
  stats: Stats,
  selection: Selection,
  rows: Record<string, number>,
): Parts => {
  const parts: Parts = {};
  let mass = 0;
  let every = 0;
  for (const column of COLUMNS) {
    const held = known(stats, column);
    if (column.kind === "text" && held && stats.tables[column.table].columns[column.id]) {
      every += held.mass;
    }
    if (!selection.has(column.id) || !held) continue;
    const table = stats.tables[column.table];
    const share = Math.min(rows[column.table] / Math.max(table.rows, 1), 1);
    const order = (ORDERED[column.table] ?? []).filter((id) => selection.has(id));
    const source = held.bytes;
    let bytes = source * share ** RATES.rows;
    if (order[0] === column.id) {
      bytes =
        column.kind === "text"
          ? rows[column.table] * RATES.primaryText
          : bytes * RATES.primaryNumber;
    } else if (order[1] === column.id) {
      bytes *= RATES.secondary;
    }
    parts[section(column)] = Math.max(bytes, RATES.floor);
    if (column.kind !== "text") continue;
    mass += held.mass * Math.min(1, rows[column.table] / Math.max(held.distinct, 1));
  }
  parts.strings = (stats.strings[1] * mass * RATES.strings) / Math.max(every, 1);
  return parts;
};

/** The sections of the file `terms` would build, each one's size in bytes. */
export const parts = (stats: Stats, terms: string): Parts => {
  const selection = parse(terms, new Set(stats.fields));
  const rows = rowsOf(stats, selection);
  return {
    ...tableParts(stats, selection, rows),
    ...spineParts(stats, selection, rows),
    ...hostParts(stats, selection),
  };
};

/** The size of the file `terms` would build, in bytes, from counted facts alone. */
export const estimate = (stats: Stats, terms: string): number => {
  const selection = parse(terms, new Set(stats.fields));
  const held = parts(stats, terms);
  const sections = Object.keys(held).length;
  const fixed = RATES.header + RATES.perSection * sections;
  const named = fixed + RATES.perField * selection.fields.length;
  return Math.round(Object.values(held).reduce((sum, bytes) => sum + bytes, named));
};
