/** The things that decide where a boundary falls, and which of them a selection keeps. */

import type { Selection } from "./selection.ts";

export type Owner = "place" | "network" | "stop" | "whole" | "spine";
export type Leaf = { id: string; owner: Owner; wants: (selection: Selection) => boolean };
export type Words = [number, number, number, number];
export type Masks = number[][];

const any = (selection: Selection, ids: string[]): boolean =>
  ids.some((id) => selection.has(id));

const kept = (selection: Selection, column: string, value: number): boolean => {
  if (!selection.has(column)) return false;
  const only = selection.narrow.get(column);
  return only === null || only === undefined || only.includes(value);
};

const unnarrowed = (selection: Selection, column: string): boolean =>
  selection.has(column) && !selection.narrow.get(column);

const SERVICES = [1, 2, 3, 4, 5];
const SERVERS = [3, 7, 8];
const KINDS = ["cellular", "crawler", "servers", "any"];
const KIND_VALUES: Record<string, number[]> = {
  cellular: [10],
  crawler: [11],
  servers: SERVERS,
};
const RECORDS: Record<string, string[]> = {
  risk: ["abuse.risk"],
  level: ["abuse.level"],
  evidence: ["abuse.evidence"],
  threat: ["abuse.threat"],
  name: ["abuse.name"],
  anycast: ["abuse.is_anycast"],
  satellite: ["abuse.is_satellite"],
  seen: ["abuse.last_seen_days"],
};

export const ABUSE_LEAVES = [
  ...SERVICES.map((value) => `service${value}`),
  ...KINDS.map((name) => `kind.${name}`),
  ...Object.keys(RECORDS),
];

export const CATEGORY_LEAVES = KINDS.map((name) => `kind.${name}`);

const wantsKind = (selection: Selection, column: string, leaf: string): boolean => {
  const name = leaf.slice(5);
  if (name === "any") return unnarrowed(selection, column);
  return KIND_VALUES[name].some((value) => kept(selection, column, value));
};

export const wantsAbuse = (selection: Selection, leaf: string): boolean => {
  if (leaf.startsWith("service")) {
    return kept(selection, "abuse.service", Number(leaf.slice(7)));
  }
  if (leaf.startsWith("kind.")) return wantsKind(selection, "abuse.user_type", leaf);
  return any(selection, RECORDS[leaf]);
};

const wantsCategory = (selection: Selection, leaf: string): boolean =>
  selection.has("network.operator") && wantsKind(selection, "operator.category", leaf);

export const RECORD_COLUMNS = RECORDS;

const CITY_IDENTITY = [
  "city.name",
  "city.ascii",
  "city.id",
  "city.population",
  "city.postal",
  "city.elevation",
];
const OPERATOR_COLUMNS = ["operator.company", "operator.peering", "operator.since"];
export const OPERATOR_LOW = [
  "tier",
  "scope",
  "rir",
  "country",
  "state",
  "website",
  "abuse_email",
  "street",
  "postal",
];

export const POINT_LOW = ["accuracy", "granularity", "confidence"];

const place = (id: string, wants: (selection: Selection) => boolean): Leaf => ({
  id,
  owner: "place",
  wants,
});

const network = (id: string, wants: (selection: Selection) => boolean): Leaf => ({
  id,
  owner: "network",
  wants,
});

const placeLeaves = (): Leaf[] => {
  const inCity = (selection: Selection, ...ids: string[]): boolean =>
    selection.has("place.city") && any(selection, ids);
  return [
    place("point", (selection) => any(selection, ["place.lat", "place.lon"])),
    ...POINT_LOW.map((name) =>
      place(`place.${name}`, (selection) => selection.has(`place.${name}`)),
    ),
    place("city", (selection) => inCity(selection, ...CITY_IDENTITY)),
    place("city.postal_partial", (selection) => inCity(selection, "city.postal_partial")),
    place("city.type", (selection) => inCity(selection, "city.type")),
    place("city.timezone", (selection) => inCity(selection, "city.timezone")),
    place("city.country", (selection) => inCity(selection, "city.country")),
    place(
      "region",
      (selection) =>
        selection.has("city.region") && any(selection, Object.keys(REGION_COLUMNS)),
    ),
    place(
      "district",
      (selection) =>
        selection.has("city.district") &&
        any(selection, ["district.name", "district.code", "district.id"]),
    ),
    place(
      "metro",
      (selection) =>
        selection.has("city.metro") && any(selection, ["metro.code", "metro.label"]),
    ),
  ];
};

const REGION_COLUMNS: Record<string, true> = {
  "region.name": true,
  "region.code": true,
  "region.iso": true,
  "region.id": true,
  "region.type": true,
  "region.country": true,
};

const networkLeaves = (): Leaf[] => [
  network("network", (selection) => selection.has("network.handle")),
  network("network.asn", (selection) => selection.has("network.asn")),
  network(
    "operator",
    (selection) =>
      selection.has("network.brand") ||
      (selection.has("network.operator") &&
        any(selection, [...OPERATOR_COLUMNS, "operator.city"])),
  ),
  ...OPERATOR_LOW.map((name) =>
    network(`operator.${name}`, (selection) => {
      return selection.has("network.operator") && selection.has(`operator.${name}`);
    }),
  ),
  network(
    "carrier",
    (selection) =>
      selection.has("network.carrier") && selection.has("carrier.user_count"),
  ),
  ...["mcc", "mnc"].map((name) =>
    network(`carrier.${name}`, (selection) => {
      return selection.has("network.carrier") && selection.has(`carrier.${name}`);
    }),
  ),
  ...CATEGORY_LEAVES.map((name) =>
    network(`category.${name}`, (selection) => wantsCategory(selection, name)),
  ),
  ...ABUSE_LEAVES.map((name) =>
    network(`net.${name}`, (selection) => {
      return selection.has("network.abuse") && wantsAbuse(selection, name);
    }),
  ),
];

const abuseLeaves = (): Leaf[] =>
  ABUSE_LEAVES.flatMap((name): Leaf[] => [
    {
      id: `stop.${name}`,
      owner: "stop",
      wants: (selection) => selection.has("network.abuse") && wantsAbuse(selection, name),
    },
    {
      id: `whole.${name}`,
      owner: "whole",
      wants: (selection) =>
        !selection.has("network.abuse") &&
        selection.table("abuse") &&
        wantsAbuse(selection, name),
    },
  ]);

const carriedLeaf = (id: string, columns: string[]): Leaf => ({
  id,
  owner: "spine",
  wants: (selection) =>
    any(
      selection,
      columns.map((name) => `spine.${name}`),
    ),
});

export const HOST_SHIFT = {
  stop: ABUSE_LEAVES.length,
  whole: ABUSE_LEAVES.length * 2,
};

export const SPINE_COLUMNS = ["prefix", "rir", "country", "since", "rpki", "roas"];

export const LEAVES: Leaf[] = [
  ...placeLeaves(),
  ...networkLeaves(),
  ...abuseLeaves(),
  ...SPINE_COLUMNS.map((name) => carriedLeaf(name, [name])),
];

if (LEAVES.length > 128) throw new Error("more leaves than mask bits");

export const leafAt = (id: string): number => LEAVES.findIndex((leaf) => leaf.id === id);

export const wordsOf = (bits: number[]): Words => {
  const words: Words = [0, 0, 0, 0];
  for (const bit of bits) words[bit >> 5] |= 1 << (bit & 31);
  return words;
};

/** Which leaves a selection cares about, as bits in a mask. */
export const wanted = (selection: Selection, owners?: Owner[]): Words => {
  const bits: number[] = [];
  LEAVES.forEach((leaf, at) => {
    if ((!owners || owners.includes(leaf.owner)) && leaf.wants(selection)) bits.push(at);
  });
  return wordsOf(bits);
};

export const touches = (mask: number[], words: Words): boolean =>
  (mask[0] & words[0]) !== 0 ||
  (mask[1] & words[1]) !== 0 ||
  (mask[2] & words[2]) !== 0 ||
  (mask[3] & words[3]) !== 0;

/** How many stops (or hosts) have at least one of the leaves that changed. */
export const counted = (masks: Masks, words: Words): number => {
  let total = 0;
  for (const mask of masks) if (touches(mask, words)) total += mask[4];
  return total;
};
