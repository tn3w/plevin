/** The file format: one address in, the stored rows out, codes as words. */

import { type Dictionary, decompress, loadDictionary } from "./zstd.ts";

export type Row = Record<string, unknown>;
export type Found = [number, number, number];
type Entry = {
  count: number;
  read: string;
  block: number;
  group: number;
  offset: number;
  bytes: number;
  encoding: string;
};
type Head = {
  built: string;
  selection: string;
  fields: string[];
  sections: Record<string, Entry>;
  vocabularies: Record<string, string[]>;
};

const MAGIC = "PLEVIN\0";
const FORMAT = 1;
const CACHED = 1 << 14;
const DEGREES = 10000;
const UNSEEN = 255;
const RECORDS = 1 << 14;
const CARRIED = ["place", "network", "abuse", "prefix", "rpki", "roas"];
const LINKED = new Set(["place", "network", "abuse"]);
const SPAN = "network";
const BOOKS: Record<string, string> = {
  rpki: "rpki",
  "place.granularity": "granularity",
  "city.timezone": "timezones",
  "city.type": "place_types",
  "operator.category": "categories",
  "abuse.user_type": "categories",
  "abuse.service": "services",
  "abuse.evidence": "evidence",
};

type Read = (value: number) => unknown;

const risk = (value: number): number | null => (value === UNSEEN ? null : value / 100);

const READS: Record<string, Read> = {
  "abuse.risk": risk,
  "abuse.is_anycast": Boolean,
  "abuse.is_satellite": Boolean,
};

const decoder = new TextDecoder();

const BIG_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 0;

class Cache<Key, Held> {
  private held = new Map<Key, Held>();
  private build: (key: Key) => Held;
  private limit: number;

  constructor(build: (key: Key) => Held, limit = CACHED) {
    this.build = build;
    this.limit = limit;
  }

  get(key: Key): Held {
    const found = this.held.get(key);
    if (found !== undefined) return found;
    if (this.held.size >= this.limit) this.held.clear();
    const built = this.build(key);
    this.held.set(key, built);
    return built;
  }

  clear(): void {
    this.held.clear();
  }
}

const varint = (data: Uint8Array, at: number): [number, number] => {
  let value = 0;
  let shift = 1;
  for (;;) {
    const byte = data[at];
    at += 1;
    value += (byte & 0x7f) * shift;
    if (byte < 0x80) return [value, at];
    shift *= 128;
  }
};

const varints = (data: Uint8Array, at: number, count: number): [number[], number] => {
  const values: number[] = [];
  for (let held = 0; held < count; held += 1) {
    const [value, next] = varint(data, at);
    values.push(value);
    at = next;
  }
  return [values, at];
};

const bigVarints = (data: Uint8Array, at: number, count: number): [bigint[], number] => {
  const values: bigint[] = [];
  for (let held = 0; held < count; held += 1) {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = data[at];
      at += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) break;
      shift += 7n;
    }
    values.push(value);
  }
  return [values, at];
};

/** A block is what the codec packed; a group is all of one a lookup decodes. */
class Section {
  readonly count: number;
  readonly read: string;
  readonly perBlock: number;
  readonly perGroup: number;
  readonly fanout: number;
  readonly width: number;
  readonly blocks: number;
  readonly keys: bigint[];
  protected readonly offsets: Uint32Array;
  protected readonly data: Uint8Array;
  protected readonly dictionary: Dictionary | null;
  protected readonly cache: Cache<number, never>;
  protected readonly groups: Cache<number, never>;

  constructor(view: Uint8Array, entry: Entry) {
    const held = new DataView(view.buffer, view.byteOffset, view.byteLength);
    this.count = entry.count;
    this.read = entry.read;
    this.perBlock = entry.block;
    this.perGroup = entry.group;
    this.fanout = this.perBlock / this.perGroup;
    this.blocks = held.getUint32(0, true);
    this.width = held.getUint32(4, true);
    const book = held.getUint32(8, true);

    this.offsets = new Uint32Array(this.blocks + 1);
    for (let index = 0; index <= this.blocks; index += 1) {
      this.offsets[index] = held.getUint32(12 + index * 4, true);
    }
    let at = 12 + 4 * (this.blocks + 1);
    this.keys = [];
    for (let index = 0; index < this.blocks; index += 1) {
      let key = 0n;
      for (let step = 0; step < this.width; step += 1) {
        key = (key << 8n) | BigInt(view[at + index * this.width + step]);
      }
      this.keys.push(key);
    }
    at += this.width * this.blocks;
    this.dictionary = book ? loadDictionary(view.subarray(at, at + book)) : null;
    this.data = view.subarray(at + book);
    this.cache = new Cache((index: number) => this.block(index) as never);
    this.groups = new Cache((group: number) => this.values(group) as never);
  }

  protected raw(index: number): Uint8Array {
    const block = this.data.subarray(this.offsets[index], this.offsets[index + 1]);
    return decompress(block, this.dictionary);
  }

  protected held(group: number): number {
    return Math.min(this.perGroup, this.count - group * this.perGroup);
  }

  protected block(index: number): unknown {
    throw new Error(`no block ${index}`);
  }

  protected values(group: number): unknown {
    throw new Error(`no group ${group}`);
  }

  at(row: number): unknown {
    throw new Error(`no row ${row}`);
  }
}

type Numbers =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;

const KINDS: Record<
  number,
  [new (buffer: ArrayBuffer) => Numbers, new (buffer: ArrayBuffer) => Numbers]
> = {
  1: [Uint8Array, Int8Array],
  2: [Uint16Array, Int16Array],
  4: [Uint32Array, Int32Array],
  8: [BigUint64Array, BigInt64Array],
};

/** A block is one array: reading a value is a subscript, and never a decode. */
class Column extends Section {
  private readonly signed: boolean;

  constructor(view: Uint8Array, entry: Entry) {
    super(view, entry);
    this.signed = entry.encoding === "signed";
  }

  protected override block(index: number): Numbers {
    const raw = this.raw(index);
    const width = raw[0];
    const bytes = raw.slice(1);
    if (BIG_ENDIAN && width > 1) {
      for (let at = 0; at + width <= bytes.length; at += width) {
        bytes.subarray(at, at + width).reverse();
      }
    }
    return new KINDS[width][this.signed ? 1 : 0](bytes.buffer);
  }

  override at(row: number): number {
    const index = Math.floor(row / this.perBlock);
    const value = (this.cache.get(index) as unknown as Numbers)[row % this.perBlock];
    return typeof value === "bigint" ? Number(value) : value;
  }
}

/** One pool, front-coded, restarting every group so a group decodes alone. */
class Strings extends Section {
  protected override block(index: number): [Uint8Array, number[]] {
    const raw = this.raw(index);
    const left = this.count - index * this.perBlock;
    const total = Math.min(this.fanout, Math.ceil(left / this.perGroup)) - 1;
    const [lengths, at] = varints(raw, 0, total);
    const starts = [at];
    for (const length of lengths) starts.push(starts[starts.length - 1] + length);
    starts.push(raw.length);
    return [raw, starts];
  }

  protected override values(group: number): string[] {
    const index = Math.floor(group / this.fanout);
    const [raw, starts] = this.cache.get(index) as unknown as [Uint8Array, number[]];
    let cursor = starts[group % this.fanout];
    const values: string[] = [];
    let previous = new Uint8Array(0);
    for (let held = 0; held < this.held(group); held += 1) {
      const shared = raw[cursor];
      let fresh = raw[cursor + 1];
      cursor += 2;
      if (fresh > 0x7f) [fresh, cursor] = varint(raw, cursor - 1);
      const value = new Uint8Array(shared + fresh);
      value.set(previous.subarray(0, shared));
      value.set(raw.subarray(cursor, cursor + fresh), shared);
      cursor += fresh;
      previous = value;
      values.push(decoder.decode(value));
    }
    return values;
  }

  override at(identifier: number): string {
    if (!identifier) return "";
    const group = Math.floor((identifier - 1) / this.perGroup);
    return (this.groups.get(group) as unknown as string[])[
      (identifier - 1) % this.perGroup
    ];
  }
}

/** The one section a lookup bisects: block keys, group heads, then gaps. */
class Index extends Section {
  private readonly hostBits: number;
  private readonly big: boolean;

  constructor(view: Uint8Array, entry: Entry) {
    super(view, entry);
    this.big = this.width !== 4;
    this.hostBits = this.big ? 64 : 0;
  }

  protected override block(index: number): [bigint[], number[], Uint8Array] {
    const raw = this.raw(index);
    const [count, start] = varint(raw, 0);
    const total = Math.ceil(count / this.perGroup);
    const [gaps, at] = bigVarints(raw, start, total - 1);
    const heads = [this.keys[index]];
    for (const gap of gaps) heads.push(heads[heads.length - 1] + gap);
    const [lengths, next] = varints(raw, at, total - 1);
    const starts = [next];
    for (const length of lengths) starts.push(starts[starts.length - 1] + length);
    return [heads, starts, raw];
  }

  protected override values(group: number): (number | bigint)[] {
    const index = Math.floor(group / this.fanout);
    const [heads, starts, raw] = this.cache.get(index) as unknown as [
      bigint[],
      number[],
      Uint8Array,
    ];
    const size = this.held(group);
    const head = heads[group % this.fanout];
    const [gaps, cursor] = this.big
      ? bigVarints(raw, starts[group % this.fanout], size - 1)
      : varints(raw, starts[group % this.fanout], size - 1);

    if (!this.big) {
      const values = [Number(head)];
      for (const gap of gaps as number[]) {
        values.push(values[values.length - 1] + (gap as number));
      }
      return values;
    }
    const networks = [head >> BigInt(this.hostBits)];
    for (const gap of gaps as bigint[]) {
      networks.push(networks[networks.length - 1] + gap);
    }
    const [hosts] = bigVarints(raw, cursor, size);
    return networks.map((network, at) => (network << BigInt(this.hostBits)) | hosts[at]);
  }

  override at(row: number): number | bigint {
    const group = Math.floor(row / this.perGroup);
    return (this.groups.get(group) as unknown as (number | bigint)[])[
      row % this.perGroup
    ];
  }

  /** The row whose address covers this one, or null below the first of them. */
  row(address: number | bigint): number | null {
    const held = this.big ? (address as bigint) : (address as number);
    const index = bisect(this.keys, this.big ? held : BigInt(held)) - 1;
    if (index < 0) return null;
    const [heads] = this.cache.get(index) as unknown as [bigint[], number[], Uint8Array];
    const group = index * this.fanout + bisect(heads, this.big ? held : BigInt(held)) - 1;
    const spot =
      bisect(this.groups.get(group) as unknown as (number | bigint)[], held) - 1;
    return spot < 0 ? null : group * this.perGroup + spot;
  }

  /** The row the address is stored at, or null where the file does not name it. */
  holds(address: number | bigint): number | null {
    const row = this.row(address);
    return row !== null && this.at(row) === address ? row : null;
  }
}

const bisect = (values: (number | bigint)[], held: number | bigint): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] <= held) low = middle + 1;
    else high = middle;
  }
  return low;
};

type Plan = {
  plain: [string, Section][];
  text: [string, Section, Section][];
  degrees: [string, Section][];
  coded: [string, Section, Read][];
  links: [string, Section][];
};

const EMPTY: Plan = { plain: [], text: [], degrees: [], coded: [], links: [] };

type Family = {
  index: Index | null;
  columns: [string, Section, Read | null][];
  hosts: Index | null;
  records: Section | null;
};

/** The database in memory, read a group at a time. */
export class File {
  readonly head: Head;
  readonly sections: Record<string, Section> = {};
  readonly reads: Record<string, Read> = {};
  private readonly tables: Record<string, Plan> = {};
  private readonly families: Record<number, Family>;
  private readonly rows: Record<string, Cache<number, Row>> = {};
  private readonly located: Record<number, Cache<number | bigint, Found | null>>;
  private readonly answers = new Cache((key: number) => this.answer(key));

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = decoder.decode(bytes.subarray(0, MAGIC.length));
    if (magic !== MAGIC || bytes[MAGIC.length] !== FORMAT) {
      throw new Error(`not a plevin ${FORMAT} database`);
    }
    const size = view.getUint32(MAGIC.length + 1, true);
    const head = MAGIC.length + 5;
    this.head = JSON.parse(decoder.decode(bytes.subarray(head, head + size))) as Head;

    const body = head + size;
    for (const [name, entry] of Object.entries(this.head.sections)) {
      const at = body + entry.offset;
      const held = bytes.subarray(at, at + entry.bytes);
      const kind =
        entry.encoding === "index"
          ? Index
          : entry.encoding === "front"
            ? Strings
            : Column;
      this.sections[name] = new kind(held, entry);
    }

    Object.assign(this.reads, READS);
    for (const [field, book] of Object.entries(BOOKS)) {
      const words = this.head.vocabularies[book];
      if (words) this.reads[field] = (code: number) => words[code] ?? "";
    }

    this.plan();
    this.families = { 4: this.family(4), 6: this.family(6) };
    this.located = {
      4: new Cache((address: number | bigint) => this.locateIn(4, address)),
      6: new Cache((address: number | bigint) => this.locateIn(6, address)),
    };
  }

  /** A row of a table, kept: a city is read once however many link to it. */
  private linked(table: string, row: number): Row {
    this.rows[table] ??= new Cache((held: number) => this.row(table, held));
    return this.rows[table].get(row);
  }

  get built(): string {
    return this.head.built;
  }

  get selection(): string {
    return this.head.selection;
  }

  get fields(): string[] {
    return this.head.fields;
  }

  /** Each table's columns split by how they decode, so a read never branches. */
  private plan(): void {
    for (const [name, section] of Object.entries(this.sections)) {
      const parts = name.split(".");
      if (parts.length !== 3 || (parts[0] !== "col" && parts[0] !== "link")) continue;
      const [kind, table, field] = parts;
      this.tables[table] ??= { plain: [], text: [], degrees: [], coded: [], links: [] };
      const plan = this.tables[table];
      const read = this.reads[`${table}.${field}`];
      if (kind === "link") plan.links.push([field, section]);
      else if (read) plan.coded.push([field, section, read]);
      else if (section.read === "text")
        plan.text.push([field, section, this.sections.strings]);
      else if (section.read) plan.degrees.push([field, section]);
      else plan.plain.push([field, section]);
    }
  }

  /** The index a lookup bisects, the columns read at that row, and the hosts. */
  private family(version: number): Family {
    const spine = `spine.v${version}`;
    const hosts = `hosts.v${version}`;
    return {
      index: (this.sections[spine] as Index) ?? null,
      columns: CARRIED.filter((name) => `${spine}.${name}` in this.sections).map(
        (name) => [name, this.sections[`${spine}.${name}`], this.reads[name] ?? null],
      ),
      hosts: (this.sections[hosts] as Index) ?? null,
      records: this.sections[`${hosts}.abuse`] ?? null,
    };
  }

  private row(table: string, row: number): Row {
    const plan = this.tables[table] ?? EMPTY;
    const out: Row = {};
    for (const [field, section] of plan.plain) out[field] = section.at(row);
    for (const [field, section, pool] of plan.text) {
      out[field] = pool.at(section.at(row) as number);
    }
    for (const [field, section] of plan.degrees) {
      out[field] = (section.at(row) as number) / DEGREES;
    }
    for (const [field, section, read] of plan.coded) {
      out[field] = read(section.at(row) as number);
    }
    for (const [target, section] of plan.links) {
      const linked = section.at(row) as number;
      if (linked) out[target] = this.linked(target, linked - 1);
    }
    if ("postal_partial" in out) {
      out.postal_partial = String(out.postal).slice(0, out.postal_partial as number);
    }
    return out;
  }

  /** The columns the boundary reads, cached by the row rather than its values. */
  private answer(key: number): Row {
    const version = key % 2 ? 6 : 4;
    const held = (key - (key % 2)) / 2;
    const override = held % RECORDS;
    const row = (held - override) / RECORDS;
    const out: Row = {};
    for (const [name, column, read] of this.families[version].columns) {
      const value = override && name === "abuse" ? override : (column.at(row) as number);
      if (LINKED.has(name)) {
        if (value) out[name] = this.linked(name, value - 1);
      } else {
        out[SPAN] ??= {};
        (out[SPAN] as Row)[name] = read ? read(value) : value;
      }
    }
    return out;
  }

  /** Which boundary answers, and the record a host overrides it with. */
  private locateIn(version: number, address: number | bigint): Found | null {
    const { index, hosts, records } = this.families[version];
    const row = index === null ? null : index.row(address);
    if (row === null) return null;
    if (hosts === null || records === null) return [version, row, 0];
    const at = hosts.holds(address);
    return [version, row, at === null ? 0 : (records.at(at) as number) + 1];
  }

  /** Which boundary and host record answer, kept so a repeat never bisects. */
  locate(value: number | bigint, wide: boolean): Found | null {
    return this.located[wide ? 6 : 4].get(value);
  }

  /** The stored answer, or null where the file covers nothing; do not edit it. */
  rowFor(value: number | bigint, wide: boolean): Row | null {
    const found = this.locate(value, wide);
    return found === null ? null : this.answerFor(found);
  }

  /** One boundary as the file stores it, shared by every address it covers. */
  answerFor(found: Found): Row {
    const [version, row, override] = found;
    return this.answers.get((row * RECORDS + override) * 2 + (version === 6 ? 1 : 0));
  }
}
