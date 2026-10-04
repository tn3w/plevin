/** A database cut down to the fields asked for, rebuilt the way the builder writes it. */

import { decompress, type Tuning } from "./lzma.ts";
import {
  type Books,
  CARRIED,
  type Carried,
  COLUMNS,
  type Column,
  ORDERED,
  parse,
  type Selection,
  section,
  TABLES,
  VOCABULARIES,
} from "./selection.ts";
import { collect, type Kit, type Stats } from "./stats.ts";
import { type Keys, type Part, type Progress, type Written, write } from "./writer.ts";

export { fileName } from "./selection.ts";
export type { Progress } from "./writer.ts";

type Entry = {
  count: number;
  block: number;
  group: number;
  offset: number;
  bytes: number;
  encoding: string;
  lzma: Tuning;
};
type Head = {
  built: string;
  fields: string[];
  sections: Record<string, Entry>;
  vocabularies: Books;
};
type Stops = {
  keys: Keys;
  columns: Record<Carried, ArrayLike<number>>;
  whole: ArrayLike<number>;
};
type Hosts = { keys: Keys; links: Int32Array };
type Family = {
  version: number;
  wide: boolean;
  stops: Stops;
  hosts: Hosts;
  networked: Uint8Array;
};
type Spine = {
  version: number;
  wide: boolean;
  hosts: Hosts;
  keys: Keys;
  columns: Record<Carried, number[]>;
};
type Slab = {
  name: string;
  columns: Column[];
  values: ArrayLike<number>[];
  keep: Uint8Array;
  map: Int32Array;
  rows: number[][];
  uses: number[];
};
type Slabs = Record<string, Slab>;
type Ranks = Record<string, number[]>;
type Cut = (at: number) => number;
type GroupReader = (
  raw: Uint8Array,
  at: number,
  first: bigint,
  size: number,
  out: Keys,
) => number;

const MAGIC = "PLEVIN\0";
const FORMAT = 3;
const HOST_BITS = 64n;
const UNSET = -1;
const VERSIONS = [4, 6];
const SPINE_TABLES: Carried[] = ["place", "network", "abuse"];
const REACHED = ["network", "operator", "place", "city"];

const decoder = new TextDecoder();

const varint = (data: Uint8Array, at: number): [number, number] => {
  let value = 0;
  let shift = 1;
  for (;;) {
    const byte = data[at++];
    value += (byte & 0x7f) * shift;
    if (byte < 0x80) return [value, at];
    shift *= 128;
  }
};

const bigVarint = (data: Uint8Array, at: number): [bigint, number] => {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    const byte = data[at++];
    value |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) return [value, at];
    shift += 7n;
  }
};

const unsigned = (bytes: Uint8Array, at: number, width: number): number => {
  let value = 0;
  for (let step = width - 1; step >= 0; step -= 1) value = value * 256 + bytes[at + step];
  return value;
};

const twos = (value: number, width: number, signed: boolean): number =>
  signed && value >= 2 ** (width * 8 - 1) ? value - 2 ** (width * 8) : value;

const little = (
  bytes: Uint8Array,
  at: number,
  width: number,
  signed: boolean,
): number => {
  if (width <= 4) return twos(unsigned(bytes, at, width), width, signed);
  const high = twos(unsigned(bytes, at + 4, width - 4), width - 4, signed);
  return high * 2 ** 32 + unsigned(bytes, at, 4);
};

const bisect = (keys: Keys, held: number | bigint): number => {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (keys[middle] <= held) low = middle + 1;
    else high = middle;
  }
  return low;
};

const narrowGroup: GroupReader = (raw, at, first, size, out) => {
  let value = Number(first);
  out.push(value);
  for (let step = 1; step < size; step += 1) {
    const [gap, next] = varint(raw, at);
    value += gap;
    out.push(value);
    at = next;
  }
  return at;
};

const wideGroup: GroupReader = (raw, at, first, size, out) => {
  const networks = [first >> HOST_BITS];
  for (let step = 1; step < size; step += 1) {
    const [gap, next] = bigVarint(raw, at);
    networks.push(networks[step - 1] + gap);
    at = next;
  }
  for (const network of networks) {
    const [host, next] = bigVarint(raw, at);
    out.push((network << HOST_BITS) | host);
    at = next;
  }
  return at;
};

const frontDecoded = (raw: Uint8Array, held: number, group: number): string[] => {
  let cursor = 0;
  for (let skip = Math.ceil(held / group) - 1; skip > 0; skip -= 1) {
    cursor = varint(raw, cursor)[1];
  }
  const names: string[] = [];
  let previous = new Uint8Array(0);
  for (let at = 0; at < held; at += 1) {
    if (at % group === 0) previous = new Uint8Array(0);
    const shared = raw[cursor];
    const [fresh, next] = varint(raw, cursor + 1);
    const name = new Uint8Array(shared + fresh);
    name.set(previous.subarray(0, shared));
    name.set(raw.subarray(next, next + fresh), shared);
    names.push(decoder.decode(name));
    previous = name;
    cursor = next + fresh;
  }
  return names;
};

class Source {
  readonly head: Head;
  private readonly bytes: Uint8Array;
  private readonly body: number;
  private readonly held = new Map<string, unknown>();

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = decoder.decode(bytes.subarray(0, MAGIC.length));
    if (magic !== MAGIC || bytes[MAGIC.length] !== FORMAT) {
      throw new Error("not a plevin raw database");
    }
    const size = view.getUint32(MAGIC.length + 1, true);
    const start = MAGIC.length + 5;
    this.head = JSON.parse(decoder.decode(bytes.subarray(start, start + size))) as Head;
    this.bytes = bytes;
    this.body = start + size;
  }

  has(name: string): boolean {
    return name in this.head.sections;
  }

  count(name: string): number {
    return this.head.sections[name].count;
  }

  memo<Held>(key: string, make: () => Held): Held {
    if (!this.held.has(key)) this.held.set(key, make());
    return this.held.get(key) as Held;
  }

  values<Held extends Float64Array | Int32Array>(
    name: string,
    Type: new (length: number) => Held,
  ): Held {
    return this.memo(`${name}:${Type.name}`, () => this.decodeValues(name, Type));
  }

  keys(name: string, wide: boolean): Keys {
    return this.memo(name, () => this.decodeKeys(name, wide));
  }

  pool(): string[] {
    return this.memo("pool", () => this.decodePool());
  }

  private openSection(name: string) {
    const entry = this.head.sections[name];
    const at = this.body + entry.offset;
    const view = this.bytes.subarray(at, at + entry.bytes);
    const words = new DataView(view.buffer, view.byteOffset, view.byteLength);
    const blocks = words.getUint32(0, true);
    const width = words.getUint32(4, true);
    const offsets = Array.from({ length: blocks + 1 }, (_, at) =>
      words.getUint32(8 + at * 4, true),
    );
    const heads: bigint[] = [];
    for (let block = 0; block < blocks; block += 1) {
      let head = 0n;
      for (let step = 0; step < width; step += 1) {
        head = (head << 8n) | BigInt(view[8 + 4 * (blocks + 1) + block * width + step]);
      }
      heads.push(head);
    }
    const data = view.subarray(8 + 4 * (blocks + 1) + width * blocks);
    const stream = (block: number): Uint8Array =>
      decompress(data.subarray(offsets[block], offsets[block + 1]), entry.lzma);
    return { entry, blocks, heads, stream };
  }

  private decodeValues<Held extends Float64Array | Int32Array>(
    name: string,
    Type: new (length: number) => Held,
  ): Held {
    const { entry, blocks, stream } = this.openSection(name);
    const out = new Type(entry.count);
    const delta = entry.encoding === "delta";
    const signed = entry.encoding === "signed" || delta;
    for (let block = 0; block < blocks; block += 1) {
      const raw = stream(block);
      const width = raw[0];
      const held = Math.min(entry.block, entry.count - block * entry.block);
      let running = 0;
      for (let at = 0; at < held; at += 1) {
        const value = little(raw, 1 + at * width, width, signed);
        running = delta ? running + value : value;
        out[block * entry.block + at] = running;
      }
    }
    return out;
  }

  private decodePool(): string[] {
    const { entry, blocks, stream } = this.openSection("strings");
    const out: string[] = [];
    for (let block = 0; block < blocks; block += 1) {
      const held = Math.min(entry.block, entry.count - block * entry.block);
      out.push(...frontDecoded(stream(block), held, entry.group));
    }
    return out;
  }

  private decodeKeys(name: string, wide: boolean): Keys {
    const { entry, blocks, heads, stream } = this.openSection(name);
    const readGroup = wide ? wideGroup : narrowGroup;
    const out: Keys = [];
    for (let block = 0; block < blocks; block += 1) {
      const raw = stream(block);
      const [held, start] = varint(raw, 0);
      const groups = Math.ceil(held / entry.group);
      const firsts: bigint[] = [heads[block]];
      let cursor = start;
      for (let at = 1; at < groups; at += 1) {
        const [gap, next] = bigVarint(raw, cursor);
        firsts.push(firsts[at - 1] + gap);
        cursor = next;
      }
      for (let at = 1; at < groups; at += 1) cursor = varint(raw, cursor)[1];
      for (let group = 0; group < groups; group += 1) {
        const size = Math.min(entry.group, held - group * entry.group);
        cursor = readGroup(raw, cursor, firsts[group], size, out);
      }
    }
    return out;
  }
}

const carriedColumns = <Held>(make: (name: Carried) => Held): Record<Carried, Held> =>
  Object.fromEntries(CARRIED.map((name) => [name, make(name)])) as Record<Carried, Held>;

const carries = (selection: Selection, name: Carried): boolean =>
  SPINE_TABLES.includes(name) ? selection.table(name) : selection.has(`spine.${name}`);

const touch = (keep: Uint8Array, link: number): void => {
  if (link > 0 && link <= keep.length) keep[link - 1] = 1;
};

const tally = (counts: number[], link: number, weight: number): void => {
  if (link > 0) counts[link - 1] += weight;
};

const linked = (slab: Slab, link: number): number => {
  if (link === 0) return 0;
  const at = slab.map[link - 1];
  return at === undefined || at < 0 ? 0 : at + 1;
};

const columnsOf = (slab: Slab, kind: string): [number, string][] =>
  slab.columns.flatMap((column, at): [number, string][] =>
    column.kind === kind ? [[at, column.name]] : [],
  );

const stopsOf = (source: Source, kind: string, version: number): Stops | null => {
  const name = `${kind}.v${version}`;
  if (!source.has(name)) return null;
  return source.memo(`${name}:stops`, () => ({
    keys: source.keys(name, version === 6),
    columns: carriedColumns((carried) => source.values(`${name}.${carried}`, Int32Array)),
    whole: source.values(`${name}.whole`, Int32Array).map((row) => row + 1),
  }));
};

const hostsOf = (source: Source, version: number): Hosts =>
  source.memo(`hosts${version}`, () => {
    const name = `hosts.v${version}`;
    if (!source.has(name)) return { keys: [], links: new Int32Array(0) };
    const links = source.values(`${name}.abuse`, Int32Array).map((row) => row + 1);
    return { keys: source.keys(name, version === 6), links };
  });

const networkedStops = (
  source: Source,
  selection: Selection,
  stops: Stops,
  hosts: Hosts,
): Uint8Array => {
  const networked = new Uint8Array(stops.keys.length).fill(1);
  if (!selection.sparse) return networked;
  const services = source.values("col.abuse.service", Float64Array);
  const kept = selection.narrow.get("abuse.service");
  const serving = (link: number): boolean => {
    const service = link > 0 ? services[link - 1] : 0;
    return service > 0 && (!kept || kept.includes(service));
  };
  const links = selection.has("network.abuse") ? stops.columns.abuse : stops.whole;
  for (let at = 0; at < networked.length; at += 1) {
    networked[at] = serving(links[at]) ? 1 : 0;
  }
  hosts.links.forEach((link, at) => {
    if (!serving(link)) return;
    const spot = bisect(stops.keys, hosts.keys[at]) - 1;
    if (spot >= 0) networked[spot] = 1;
  });
  return networked;
};

const openFamilies = (source: Source, selection: Selection): Family[] =>
  VERSIONS.flatMap((version): Family[] => {
    const kind = selection.has("place.lat") ? "spine" : "blocks";
    const stops = stopsOf(source, kind, version);
    if (!stops) return [];
    const hosts = hostsOf(source, version);
    const networked = networkedStops(source, selection, stops, hosts);
    return [{ version, wide: version === 6, stops, hosts, networked }];
  });

const columnValues = (source: Source, column: Column): ArrayLike<number> =>
  source.values(section(column), Float64Array);

const makeSlab = (source: Source, selection: Selection, name: string): Slab => {
  const columns = COLUMNS.filter((one) => one.table === name && selection.has(one.id));
  const values = columns.map((column) => columnValues(source, column));
  const size = values.length ? values[0].length : 0;
  return {
    name,
    columns,
    values,
    keep: new Uint8Array(size),
    map: new Int32Array(size).fill(UNSET),
    rows: [],
    uses: [],
  };
};

const makeSlabs = (source: Source, selection: Selection): Slabs =>
  Object.fromEntries(TABLES.map((name) => [name, makeSlab(source, selection, name)]));

const followLinks = (slabs: Slabs, slab: Slab): void => {
  for (const [spot, target] of columnsOf(slab, "link")) {
    for (let row = 0; row < slab.keep.length; row += 1) {
      if (slab.keep[row]) touch(slabs[target].keep, slab.values[spot][row]);
    }
  }
};

const markReached = (slabs: Slabs, families: Family[]): void => {
  touch(slabs.abuse.keep, 1);
  for (const { stops, networked, hosts } of families) {
    for (let spot = 0; spot < stops.keys.length; spot += 1) {
      touch(slabs.place.keep, stops.columns.place[spot]);
      if (networked[spot]) touch(slabs.network.keep, stops.columns.network[spot]);
      touch(slabs.abuse.keep, stops.columns.abuse[spot]);
      touch(slabs.abuse.keep, stops.whole[spot]);
    }
    for (const link of hosts.links) touch(slabs.abuse.keep, link);
  }
  for (const name of REACHED) followLinks(slabs, slabs[name]);
};

const slabValue = (
  selection: Selection,
  column: Column,
  value: number,
  slabs: Slabs,
): number => {
  const kept = selection.narrow.get(column.id);
  const held = kept && !kept.includes(value) ? 0 : value;
  return column.kind === "link" ? linked(slabs[column.name], held) : held;
};

const collapse = (slab: Slab, slabs: Slabs, selection: Selection): void => {
  const known = new Map<string, number>();
  for (let at = 0; at < slab.keep.length; at += 1) {
    if (!slab.keep[at]) continue;
    const key = slab.columns.map((column, spot) =>
      slabValue(selection, column, slab.values[spot][at], slabs),
    );
    const pinned = slab.name === "abuse" && at === 0;
    if (!pinned && key.every((held) => held === 0)) continue;
    const label = key.join(",");
    let row = known.get(label);
    if (row === undefined) {
      row = slab.rows.length;
      known.set(label, row);
      slab.rows.push(key);
    }
    slab.map[at] = row;
  }
  slab.uses = new Array(slab.rows.length).fill(0);
};

const cutters = (selection: Selection, slabs: Slabs, family: Family): Cut[] => {
  const { stops, networked } = family;
  const abuseLinks = selection.has("network.abuse") ? stops.columns.abuse : stops.whole;
  const cutter = (name: Carried): Cut => {
    const column = stops.columns[name];
    if (name === "place") return (at) => linked(slabs.place, column[at]);
    if (name === "network") {
      return (at) => (networked[at] ? linked(slabs.network, column[at]) : 0);
    }
    if (name === "abuse") {
      return (at) => {
        const record = linked(slabs.abuse, abuseLinks[at]);
        return record === 1 ? 0 : record;
      };
    }
    return (at) => column[at];
  };
  return CARRIED.map((name) => (carries(selection, name) ? cutter(name) : () => 0));
};

const trim = (selection: Selection, slabs: Slabs, family: Family): Spine => {
  const { version, wide, hosts, stops } = family;
  const cuts = cutters(selection, slabs, family);
  const columns = carriedColumns((): number[] => []);
  const lists = CARRIED.map((name) => columns[name]);
  const keys: Keys = [];
  const last = new Array<number>(cuts.length).fill(-1);
  const cut = new Array<number>(cuts.length).fill(0);
  for (let at = 0; at < stops.keys.length; at += 1) {
    let same = true;
    for (let spot = 0; spot < cuts.length; spot += 1) {
      cut[spot] = cuts[spot](at);
      if (cut[spot] !== last[spot]) same = false;
    }
    if (same) continue;
    keys.push(stops.keys[at]);
    for (let spot = 0; spot < cuts.length; spot += 1) {
      lists[spot].push(cut[spot]);
      last[spot] = cut[spot];
    }
  }
  return { version, wide, hosts, keys, columns };
};

const countUses = (slabs: Slabs, spines: Spine[]): void => {
  for (const { keys, columns, hosts } of spines) {
    for (const name of SPINE_TABLES) {
      for (let at = 0; at < keys.length; at += 1) {
        tally(slabs[name].uses, columns[name][at], 1);
      }
    }
    for (const link of hosts.links) tally(slabs.abuse.uses, linked(slabs.abuse, link), 1);
  }
  for (const slab of Object.values(slabs).reverse()) {
    for (const [spot, target] of columnsOf(slab, "link")) {
      for (const [at, row] of slab.rows.entries()) {
        tally(slabs[target].uses, row[spot], Math.max(slab.uses[at], 1));
      }
    }
  }
};

const compareRows = (one: number[], two: number[]): number => {
  for (let at = 0; at < one.length; at += 1) {
    if (one[at] !== two[at]) return one[at] - two[at];
  }
  return 0;
};

const sortRows = (slab: Slab, order: number[]): void => {
  const ordered = ORDERED[slab.name];
  if (ordered) {
    const spots = ordered
      .map((id) => slab.columns.findIndex((column) => column.id === id))
      .filter((spot) => spot >= 0);
    const keys = slab.rows.map((row) => [...spots.map((spot) => row[spot]), ...row]);
    order.sort((one, two) => compareRows(keys[one], keys[two]));
    return;
  }
  if (slab.name === "abuse") {
    order.sort((one, two) => slab.uses[two] - slab.uses[one] || one - two);
  }
};

const rank = (slab: Slab): number[] => {
  const first = slab.name === "abuse" && slab.rows.length > 0 ? 1 : 0;
  const order = Array.from({ length: slab.rows.length - first }, (_, at) => at + first);
  sortRows(slab, order);
  const ranks = new Array<number>(slab.rows.length).fill(0);
  order.forEach((at, place) => {
    ranks[at] = place + first;
  });
  return ranks;
};

const rankedLink = (order: number[], link: number): number =>
  link === 0 ? 0 : order[link - 1] + 1;

const relink = (slab: Slab, ranks: Ranks): void => {
  const links = columnsOf(slab, "link");
  for (const row of slab.rows) {
    for (const [at, target] of links) row[at] = rankedLink(ranks[target], row[at]);
  }
};

const reorder = (slab: Slab, order: number[]): void => {
  const moved = new Array<number[]>(slab.rows.length);
  slab.rows.forEach((row, at) => {
    moved[order[at]] = row;
  });
  slab.rows = moved;
};

const rankSlabs = (slabs: Slabs): Ranks => {
  const ranks: Ranks = {};
  for (const slab of Object.values(slabs)) {
    relink(slab, ranks);
    const order = rank(slab);
    reorder(slab, order);
    ranks[slab.name] = order;
  }
  return ranks;
};

const relinkSpine = (spine: Spine, ranks: Ranks): void => {
  for (const name of SPINE_TABLES) {
    spine.columns[name] = spine.columns[name].map((link) =>
      rankedLink(ranks[name], link),
    );
  }
};

const eachText = (slabs: Slabs, visit: (row: number[], spot: number) => void): void => {
  for (const slab of Object.values(slabs)) {
    for (const [spot] of columnsOf(slab, "text")) {
      for (const row of slab.rows) visit(row, spot);
    }
  }
};

const respell = (slabs: Slabs, pool: string[]): string[] => {
  const used = new Uint8Array(pool.length + 1);
  eachText(slabs, (row, spot) => {
    used[row[spot]] = 1;
  });
  const renumbered = new Int32Array(pool.length + 1);
  const names = pool.filter((_, at) => used[at + 1]);
  let place = 0;
  for (let id = 1; id < used.length; id += 1) {
    if (used[id]) renumbered[id] = ++place;
  }
  eachText(slabs, (row, spot) => {
    row[spot] = renumbered[row[spot]];
  });
  return names;
};

const abuseAt = (spine: Spine, address: number | bigint, networkAbuse: boolean) => {
  const at = bisect(spine.keys, address) - 1;
  const link = at < 0 ? 0 : spine.columns.abuse[at];
  if (link !== 0) return link - 1;
  return networkAbuse ? null : 0;
};

const hostParts = (
  selection: Selection,
  spine: Spine,
  slabs: Slabs,
  order: number[],
): Part[] => {
  const { hosts } = spine;
  const networkAbuse = selection.has("network.abuse");
  const keys: Keys = [];
  const values: number[] = [];
  hosts.links.forEach((link, at) => {
    const held = linked(slabs.abuse, link);
    const stood = abuseAt(spine, hosts.keys[at], networkAbuse);
    if (held === 0 && stood === null) return;
    const position = order[Math.max(held, 1) - 1];
    if (stood === position) return;
    keys.push(hosts.keys[at]);
    values.push(position);
  });
  if (keys.length === 0) return [];
  const name = `hosts.v${spine.version}`;
  return [
    { kind: "index", name, keys, wide: spine.wide },
    { kind: "values", name: `${name}.abuse`, encoding: "fixed", read: "", values },
  ];
};

const spineColumnParts = (selection: Selection, spine: Spine): Part[] =>
  CARRIED.flatMap((name): Part[] => {
    const values = spine.columns[name];
    const held = name === "abuse" || values.some((value) => value !== 0);
    if (!carries(selection, name) || !held) return [];
    const label = `spine.v${spine.version}.${name}`;
    return [{ kind: "values", name: label, encoding: "fixed", read: "", values }];
  });

const spineParts = (
  selection: Selection,
  spines: Spine[],
  slabs: Slabs,
  ranks: Ranks,
): Part[] => {
  const parts = spines
    .filter((spine) => spine.keys.length > 0)
    .flatMap((spine): Part[] => [
      {
        kind: "index",
        name: `spine.v${spine.version}`,
        keys: spine.keys,
        wide: spine.wide,
      },
      ...spineColumnParts(selection, spine),
    ]);
  if (!selection.table("abuse")) return parts;
  const hosts = spines.flatMap((spine) =>
    hostParts(selection, spine, slabs, ranks.abuse),
  );
  return [...parts, ...hosts];
};

const columnParts = (slabs: Slabs): Part[] =>
  COLUMNS.flatMap((column): Part[] => {
    const slab = slabs[column.table];
    const at = slab.columns.findIndex((one) => one.id === column.id);
    if (at < 0) return [];
    const signed = column.kind === "signed" || column.kind === "degrees";
    const read = column.kind === "text" || column.kind === "degrees" ? column.kind : "";
    const values = slab.rows.map((row) => row[at]);
    return [
      {
        kind: "values",
        name: section(column),
        encoding: signed ? "signed" : "fixed",
        read,
        values,
      },
    ];
  });

const vocabulariesFor = (source: Source, selection: Selection): Books =>
  Object.fromEntries(
    VOCABULARIES.filter(
      ([name, reads]) =>
        name in source.head.vocabularies && reads.some((id) => selection.has(id)),
    ).map(([name]) => [name, source.head.vocabularies[name]]),
  );

const build = (source: Source, selection: Selection, progress?: Progress): Written => {
  progress?.("reading");
  const slabs = makeSlabs(source, selection);
  const families = openFamilies(source, selection);
  progress?.("merging");
  markReached(slabs, families);
  for (const slab of Object.values(slabs)) collapse(slab, slabs, selection);
  const spines = families.map((family) => trim(selection, slabs, family));
  countUses(slabs, spines);
  const pool = respell(slabs, source.pool());
  const ranks = rankSlabs(slabs);
  for (const spine of spines) relinkSpine(spine, ranks);
  const parts: Part[] = [
    ...columnParts(slabs),
    ...spineParts(selection, spines, slabs, ranks),
    { kind: "strings", pool },
  ];
  return {
    parts,
    carries: SPINE_TABLES.map((name) => selection.table(name)),
    fields: selection.fields,
    books: vocabulariesFor(source, selection),
  };
};

/** One database held open: each selection cut from it reuses what was already decoded. */
export class Slimmer {
  private readonly source: Source;

  constructor(bytes: Uint8Array) {
    this.source = new Source(bytes);
  }

  get built(): string {
    return this.source.head.built;
  }

  get fields(): string[] {
    return this.source.head.fields;
  }

  plan(terms: string): Selection {
    const { fields, vocabularies } = this.source.head;
    return parse(terms, new Set(fields), vocabularies);
  }

  /** The database for `terms` (`place+metro`, `network.asn`), as bytes to save. */
  slim(terms: string, progress?: Progress): Uint8Array {
    const selection = this.plan(terms);
    const written = build(this.source, selection, progress);
    return write(written, this.built, selection.name, progress);
  }

  /** The counted facts `estimate` reads instead of this file, a few kilobytes of JSON. */
  stats(): Stats {
    const { source } = this;
    const kit: Kit = {
      head: source.head,
      has: (name) => source.has(name),
      numbers: (name) => source.values(name, Float64Array),
      pool: () => source.pool(),
      spine: (version, coarse) => stopsOf(source, coarse ? "blocks" : "spine", version),
      hosts: (version) => hostsOf(source, version).links,
      keys: (version) => ({
        hosts: hostsOf(source, version).keys,
        spine: source.keys(`spine.v${version}`, version === 6),
      }),
    };
    return collect(kit);
  }
}

/** A database rebuilt with only what `terms` (`place+metro`, `network.asn`) need. */
export const slim = (bytes: Uint8Array, terms: string, progress?: Progress): Uint8Array =>
  new Slimmer(bytes).slim(terms, progress);
