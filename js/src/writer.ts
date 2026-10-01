/** The file: fixed blocks, one codec, and a header that says how to read them all. */

import { compress } from "./compress.ts";
import type { Tuning } from "./lzma.ts";
import type { Books } from "./selection.ts";

export type Keys = (number | bigint)[];
export type Sheet = {
  name: string;
  encoding: "fixed" | "signed";
  read: "text" | "degrees" | "";
  values: ArrayLike<number>;
};
export type Part =
  | ({ kind: "values" } & Sheet)
  | { kind: "index"; name: string; keys: Keys; wide: boolean }
  | { kind: "strings"; pool: string[] };
export type Written = {
  parts: Part[];
  carries: boolean[];
  fields: string[];
  books: Books;
};

export type Progress = (label: string, done?: number, total?: number) => void;

type Shape = {
  count: number;
  encoding: string;
  block: number;
  group: number;
  read: string;
};
type Fit = [tuning: Tuning, size: number];
type Prepared = {
  name: string;
  shape: Shape;
  blocks: Uint8Array[];
  heads: Keys;
  width: number;
  fit: Fit;
};
type Packed = {
  name: string;
  entry: Shape & { lzma: Tuning };
  size: number;
  body: Uint8Array | null;
};

const MAGIC = new TextEncoder().encode("PLEVIN\0");
const FORMAT = 2;
const PREAMBLE = MAGIC.length + 5;
const WIDTHS = [1, 2, 4, 8];
const VALUES = 16384;
const KEYS = 32768;
const GROUP = 128;
const NAMES = 4096;
const RUN = 64;
const PROBE = 16;
const SAMPLED = 3;
const QUICK_SHRINK = 0.93;
const TUNINGS: Tuning[] = [
  [3, 0, 0],
  [0, 0, 0],
  [0, 1, 1],
  [0, 2, 2],
  [0, 3, 3],
];

const encoder = new TextEncoder();

class Bytes {
  private data = new Uint8Array(1 << 10);
  length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.data.length) return;
    const grown = new Uint8Array(Math.max(this.data.length * 2, this.length + extra));
    grown.set(this.data);
    this.data = grown;
  }

  push(byte: number): void {
    this.reserve(1);
    this.data[this.length++] = byte;
  }

  add(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }

  word(value: number): void {
    for (let step = 0; step < 4; step += 1) this.push((value >>> (step * 8)) & 0xff);
  }

  varint(value: number | bigint): void {
    if (typeof value === "bigint") {
      let left = value;
      for (; left >= 0x80n; left >>= 7n) this.push(Number(left & 0x7fn) | 0x80);
      this.push(Number(left));
      return;
    }
    let left = value;
    for (; left >= 0x80; left = Math.floor(left / 128)) this.push((left % 128) | 0x80);
    this.push(left);
  }

  take(): Uint8Array {
    return this.data.slice(0, this.length);
  }
}

const fitsIn = (value: number, width: number, signed: boolean): boolean => {
  const limit = 2 ** (width * 8 - (signed ? 1 : 0));
  return signed ? value >= -limit && value < limit : value >= 0 && value < limit;
};

const widthFor = (value: number, signed: boolean): number =>
  WIDTHS.find((width) => fitsIn(value, width, signed)) ?? 8;

const fixedBlock = (chunk: ArrayLike<number>, signed: boolean): Uint8Array => {
  let width = 1;
  for (let at = 0; at < chunk.length; at += 1) {
    width = Math.max(width, widthFor(chunk[at], signed));
  }
  const block = new Uint8Array(1 + chunk.length * width);
  const view = new DataView(block.buffer);
  block[0] = width;
  for (let at = 0; at < chunk.length; at += 1) {
    const spot = 1 + at * width;
    if (width === 8) {
      view.setBigUint64(spot, BigInt.asUintN(64, BigInt(chunk[at])), true);
      continue;
    }
    let value = chunk[at] < 0 ? chunk[at] + 2 ** (width * 8) : chunk[at];
    for (let step = 0; step < width; step += 1) {
      block[spot + step] = value % 256;
      value = Math.floor(value / 256);
    }
  }
  return block;
};

const chunks = <Held>(values: ArrayLike<Held>, size: number): Held[][] => {
  const out: Held[][] = [];
  for (let at = 0; at < values.length; at += size) {
    out.push(Array.prototype.slice.call(values, at, at + size));
  }
  return out;
};

const tuned = (blocks: Uint8Array[], probe: number): Fit => {
  const step = Math.max(Math.floor(blocks.length / probe), 1);
  const sample = blocks.filter((_, at) => at % step === 0);
  let best: Fit = [TUNINGS[0], Number.POSITIVE_INFINITY];
  for (const tuning of TUNINGS) {
    let stored = 0;
    for (const block of sample) stored += compress(block, tuning).length;
    if (stored * step < best[1]) best = [tuning, stored * step];
  }
  return best;
};

const plainBlocks = (values: ArrayLike<number>, signed: boolean): Uint8Array[] =>
  chunks(values, VALUES).map((chunk) => fixedBlock(chunk, signed));

const deltaBlocks = (values: ArrayLike<number>): Uint8Array[] =>
  chunks(values, VALUES).map((chunk) => {
    let last = 0;
    const steps = chunk.map((value) => {
      const step = value - last;
      last = value;
      return step;
    });
    return fixedBlock(steps, true);
  });

const prepareValues = (sheet: Sheet, probe: number): Prepared => {
  const plain = plainBlocks(sheet.values, sheet.encoding === "signed");
  const stepped = deltaBlocks(sheet.values);
  const plainFit = tuned(plain, probe);
  const steppedFit = tuned(stepped, probe);
  const isDelta = steppedFit[1] < plainFit[1];
  const shape = {
    count: sheet.values.length,
    encoding: isDelta ? "delta" : sheet.encoding,
    block: VALUES,
    group: VALUES,
    read: sheet.read,
  };
  const blocks = isDelta ? stepped : plain;
  const fit = isDelta ? steppedFit : plainFit;
  return { name: sheet.name, shape, blocks, heads: [], width: 0, fit };
};

const indexed = (out: Bytes, groups: Uint8Array[]): void => {
  for (const held of groups.slice(0, -1)) out.varint(held.length);
  for (const held of groups) out.add(held);
};

const boundary = (bytes: Uint8Array, at: number): number => {
  let spot = Math.min(at, bytes.length);
  while (spot > 0 && spot < bytes.length && (bytes[spot] & 0xc0) === 0x80) spot -= 1;
  return spot;
};

const frontCoded = (names: Uint8Array[]): Uint8Array => {
  const out = new Bytes();
  let last: Uint8Array = new Uint8Array(0);
  for (const name of names) {
    let shared = 0;
    const most = Math.min(last.length, name.length, 255);
    while (shared < most && last[shared] === name[shared]) shared += 1;
    shared = boundary(name, shared);
    out.push(shared);
    out.varint(name.length - shared);
    out.add(name.subarray(shared));
    last = name;
  }
  return out.take();
};

const prepareStrings = (pool: string[], probe: number): Prepared => {
  const blocks = chunks(
    pool.map((name) => encoder.encode(name)),
    NAMES,
  ).map((names) => {
    const out = new Bytes();
    indexed(out, chunks(names, RUN).map(frontCoded));
    return out.take();
  });
  const shape = {
    count: pool.length,
    encoding: "front",
    block: NAMES,
    group: RUN,
    read: "",
  };
  return {
    name: "strings",
    shape,
    blocks,
    heads: [],
    width: 0,
    fit: tuned(blocks, probe),
  };
};

const narrowRun = (keys: number[]): Uint8Array => {
  const out = new Bytes();
  for (let at = 1; at < keys.length; at += 1) out.varint(keys[at] - keys[at - 1]);
  return out.take();
};

const wideRun = (keys: bigint[]): Uint8Array => {
  const out = new Bytes();
  for (let at = 1; at < keys.length; at += 1)
    out.varint((keys[at] >> 64n) - (keys[at - 1] >> 64n));
  for (const key of keys) out.varint(key & 0xffffffffffffffffn);
  return out.take();
};

const gap = (high: number | bigint, low: number | bigint): number | bigint =>
  typeof high === "bigint" ? high - BigInt(low) : high - Number(low);

const indexBlock = (chunk: Keys, wide: boolean): Uint8Array => {
  const groups = chunks(chunk, GROUP);
  const body = new Bytes();
  body.varint(chunk.length);
  for (let at = 1; at < groups.length; at += 1) {
    body.varint(gap(groups[at][0], groups[at - 1][0]));
  }
  const runs = groups.map((held) =>
    wide ? wideRun(held as bigint[]) : narrowRun(held as number[]),
  );
  indexed(body, runs);
  return body.take();
};

const prepareIndex = (
  part: Extract<Part, { kind: "index" }>,
  probe: number,
): Prepared => {
  const pieces = chunks(part.keys, KEYS);
  const blocks = pieces.map((piece) => indexBlock(piece, part.wide));
  const shape = {
    count: part.keys.length,
    encoding: "index",
    block: KEYS,
    group: GROUP,
    read: "",
  };
  const heads = pieces.map((piece) => piece[0]);
  const width = part.wide ? 16 : 4;
  return { name: part.name, shape, blocks, heads, width, fit: tuned(blocks, probe) };
};

const prepare = (part: Part, probe: number): Prepared => {
  if (part.kind === "values") return prepareValues(part, probe);
  if (part.kind === "index") return prepareIndex(part, probe);
  return prepareStrings(part.pool, probe);
};

const container = ({ blocks, heads, width }: Prepared, stored: Uint8Array[]) => {
  const body = new Bytes();
  body.word(blocks.length);
  body.word(width);
  let offset = 0;
  body.word(offset);
  for (const held of stored) {
    offset += held.length;
    body.word(offset);
  }
  for (const head of heads) {
    for (let step = width - 1; step >= 0; step -= 1) {
      body.push(Number((BigInt(head) >> BigInt(step * 8)) & 0xffn));
    }
  }
  for (const held of stored) body.add(held);
  return body.take();
};

const pack = (part: Part, quick: boolean): Packed => {
  const prepared = prepare(part, quick ? SAMPLED : PROBE);
  const [tuning, weight] = prepared.fit;
  const { name, shape, blocks, width } = prepared;
  const entry = { ...shape, lzma: tuning };
  if (quick) {
    const table = 8 + 4 * (blocks.length + 1) + width * blocks.length;
    return { name, entry, size: table + Math.round(weight * QUICK_SHRINK), body: null };
  }
  const stored = blocks.map((block) => compress(block, tuning));
  const body = container(prepared, stored);
  return { name, entry, size: body.length, body };
};

const packAll = (written: Written, quick: boolean, progress?: Progress): Packed[] =>
  written.parts.map((part, at) => {
    progress?.(quick ? "measuring" : "compressing", at, written.parts.length);
    return pack(part, quick);
  });

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value) || typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([one], [two]) => (one < two ? -1 : 1))
      .map(([key, inner]) => [key, sorted(inner)]),
  );
};

const header = (
  written: Written,
  built: string,
  selection: string,
  sections: object,
  length: number,
): Uint8Array =>
  encoder.encode(
    JSON.stringify(
      sorted({
        format: FORMAT,
        built,
        selection,
        fields: written.fields,
        carries: written.carries,
        vocabularies: written.books,
        sections,
        length,
      }),
    ),
  );

const laid = (
  written: Written,
  built: string,
  selection: string,
  packed: Packed[],
): [Uint8Array, number] => {
  const sections: Record<string, object> = {};
  let body = 0;
  for (const one of packed) {
    sections[one.name] = { ...one.entry, offset: body, bytes: one.size };
    body += one.size;
  }
  let head: Uint8Array = new Uint8Array(0);
  for (let round = 0; round < 8; round += 1) {
    const total = PREAMBLE + head.length + body;
    const again = header(written, built, selection, sections, total);
    const settled = again.length === head.length;
    head = again;
    if (settled) break;
  }
  return [head, body];
};

/** The bytes of one database, each block compressed under the tuning that shrinks it most. */
export const write = (
  written: Written,
  built: string,
  selection: string,
  progress?: Progress,
): Uint8Array => {
  const packed = packAll(written, false, progress);
  const [head, body] = laid(written, built, selection, packed);
  const out = new Uint8Array(PREAMBLE + head.length + body);
  out.set(MAGIC);
  out[MAGIC.length] = FORMAT;
  new DataView(out.buffer).setUint32(MAGIC.length + 1, head.length, true);
  out.set(head, PREAMBLE);
  let at = PREAMBLE + head.length;
  for (const one of packed) {
    if (one.body) out.set(one.body, at);
    at += one.size;
  }
  progress?.("compressing", written.parts.length, written.parts.length);
  return out;
};

/** What a sorted run of addresses would take as an index section, sampled, not packed. */
export const indexSize = (keys: Keys, wide: boolean): number =>
  pack({ kind: "index", name: "keys", keys, wide }, true).size;
