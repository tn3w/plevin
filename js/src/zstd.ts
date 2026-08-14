/**
 * Zstandard decompression with dictionaries, condensed from fzstd (MIT, 101arrowz).
 */

const FRAME_MAGIC = 0x2fb528;
const DICTIONARY_MAGIC = 0xec30a437;

const bitsToBase = (bits: Uint8Array, first: number): Int32Array => {
  const base = new Int32Array(bits.length);
  let next = first;
  for (let code = 0; code < bits.length; code += 1) {
    base[code] = next;
    next += 1 << bits[code];
  }
  return base;
};

const LITERAL_BITS = new Uint8Array([
  ...Array<number>(16).fill(0),
  1,
  1,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
]);
const MATCH_BITS = new Uint8Array([
  ...Array<number>(32).fill(0),
  1,
  1,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
]);
const LITERAL_BASE = bitsToBase(LITERAL_BITS, 0);
const MATCH_BASE = bitsToBase(MATCH_BITS, 3);

const LITERAL_DEFAULT = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1,
  1, 1, 1, -1, -1, -1, -1,
];
const MATCH_DEFAULT = [
  1,
  4,
  3,
  2,
  2,
  2,
  2,
  2,
  2,
  ...Array<number>(37).fill(1),
  ...Array<number>(7).fill(-1),
];
const OFFSET_DEFAULT = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1,
  -1,
];

export type FseTable = {
  log: number;
  symbols: Uint8Array;
  bits: Uint8Array;
  next: Uint16Array;
};

export type HuffmanTable = {
  maxBits: number;
  symbols: Uint8Array;
  bits: Uint8Array;
};

export type SequenceTables = {
  literal: FseTable;
  match: FseTable;
  offset: FseTable;
};

export type Dictionary = {
  id: number;
  content: Uint8Array;
  huffman: HuffmanTable | null;
  tables: SequenceTables | null;
  offsets: number[];
};

type Entropy = {
  huffman: HuffmanTable | null;
  tables: SequenceTables | null;
  offsets: Int32Array;
};

const fail = (reason: string): never => {
  throw new Error(`zstd: ${reason}`);
};

const highestBit = (value: number): number => {
  let bits = 0;
  while (1 << bits <= value) bits += 1;
  return bits - 1;
};

const spread = (counts: Int16Array, symbols: number, log: number): FseTable => {
  const size = 1 << log;
  const table: FseTable = {
    log,
    symbols: new Uint8Array(size),
    bits: new Uint8Array(size),
    next: new Uint16Array(size),
  };
  const states = new Uint16Array(256);
  let high = size;
  for (let symbol = 0; symbol < symbols; symbol += 1) {
    if (counts[symbol] < 0) {
      states[symbol] = 1;
      high -= 1;
      table.symbols[high] = symbol;
    } else {
      states[symbol] = counts[symbol];
    }
  }

  const step = (size >> 1) + (size >> 3) + 3;
  let at = 0;
  for (let symbol = 0; symbol < symbols; symbol += 1) {
    for (let held = 0; held < counts[symbol]; held += 1) {
      table.symbols[at] = symbol;
      do at = (at + step) & (size - 1);
      while (at >= high);
    }
  }
  if (at !== 0) fail("the symbols do not spread over the table");

  for (let cell = 0; cell < size; cell += 1) {
    const state = states[table.symbols[cell]]++;
    const bits = log - highestBit(state);
    table.bits[cell] = bits;
    table.next[cell] = (state << bits) - size;
  }
  return table;
};

const readFse = (data: Uint8Array, at: number, maxLog: number): [FseTable, number] => {
  const log = (data[at] & 15) + 5;
  if (log > maxLog) fail("an entropy table is too accurate");
  const counts = new Int16Array(256);
  let position = (at << 3) + 4;
  let left = 1 << log;
  let symbol = -1;

  while (symbol < 255 && left > 0) {
    const bits = highestBit(left + 1);
    const byte = position >> 3;
    const mask = (1 << (bits + 1)) - 1;
    const wide =
      (data[byte] | (data[byte + 1] << 8) | (data[byte + 2] << 16)) >> (position & 7);
    const narrow = wide & ((1 << bits) - 1);
    const largest = mask - left - 1;
    let value = wide & mask;
    if (narrow < largest) {
      position += bits;
      value = narrow;
    } else {
      position += bits + 1;
      if (value > (1 << bits) - 1) value -= largest;
    }
    value -= 1;
    symbol += 1;
    counts[symbol] = value;
    left -= value < 0 ? -value : value;
    if (value !== 0) continue;
    let repeat = 3;
    while (repeat === 3) {
      const byteAt = position >> 3;
      repeat = ((data[byteAt] | (data[byteAt + 1] << 8)) >> (position & 7)) & 3;
      position += 2;
      symbol += repeat;
    }
  }
  if (symbol > 255 || left !== 0) fail("the entropy counts do not add up");
  return [spread(counts, symbol + 1, log), (position + 7) >> 3];
};

const buildHuffman = (weights: Uint8Array, count: number): HuffmanTable => {
  let sum = 0;
  for (let symbol = 0; symbol < count; symbol += 1) {
    const weight = weights[symbol];
    if (weight > 11) fail("a huffman weight is out of range");
    sum += weight ? 1 << (weight - 1) : 0;
  }
  const maxBits = highestBit(sum) + 1;
  const size = 1 << maxBits;
  const rest = size - sum;
  if (rest & (rest - 1)) fail("the huffman weights do not add up");
  weights[count] = highestBit(rest) + 1;

  const ranks = new Uint32Array(13);
  for (let symbol = 0; symbol <= count; symbol += 1) {
    weights[symbol] = weights[symbol] && maxBits + 1 - weights[symbol];
    ranks[weights[symbol]] += 1;
  }

  const table: HuffmanTable = {
    maxBits,
    symbols: new Uint8Array(size),
    bits: new Uint8Array(size),
  };
  const starts = new Uint32Array(13);
  for (let bits = maxBits; bits > 0; bits -= 1) {
    const start = starts[bits];
    starts[bits - 1] = start + ranks[bits] * (1 << (maxBits - bits));
    table.bits.fill(bits, start, starts[bits - 1]);
  }
  if (starts[0] !== size) fail("the huffman codes do not fill the table");

  for (let symbol = 0; symbol <= count; symbol += 1) {
    const bits = weights[symbol];
    if (!bits) continue;
    const start = starts[bits];
    starts[bits] = start + (1 << (maxBits - bits));
    table.symbols.fill(symbol, start, starts[bits]);
  }
  return table;
};

const readHuffman = (data: Uint8Array, at: number): [HuffmanTable, number] => {
  const header = data[at];
  const weights = new Uint8Array(256);
  if (header >= 128) {
    const count = header - 127;
    for (let symbol = 0; symbol < count; symbol += 2) {
      const byte = data[at + 1 + (symbol >> 1)];
      weights[symbol] = byte >> 4;
      weights[symbol + 1] = byte & 15;
    }
    return [buildHuffman(weights, count), at + 1 + ((count + 1) >> 1)];
  }

  const [table, start] = readFse(data, at + 1, 6);
  const end = at + 1 + header;
  const last = data[end - 1];
  if (!last) fail("a huffman bitstream ends on a zero byte");
  const floor = start << 3;
  let position = (end << 3) - 8 + highestBit(last);
  let count = 0;
  let first = 0;
  let second = 0;
  let firstBits = table.log;
  let secondBits = table.log;

  for (;;) {
    position -= firstBits;
    if (position < floor) break;
    let byte = position >> 3;
    first +=
      ((data[byte] | (data[byte + 1] << 8)) >> (position & 7)) & ((1 << firstBits) - 1);
    weights[count] = table.symbols[first];
    count += 1;
    position -= secondBits;
    if (position < floor) break;
    byte = position >> 3;
    second +=
      ((data[byte] | (data[byte + 1] << 8)) >> (position & 7)) & ((1 << secondBits) - 1);
    weights[count] = table.symbols[second];
    count += 1;
    firstBits = table.bits[first];
    first = table.next[first];
    secondBits = table.bits[second];
    second = table.next[second];
  }
  return [buildHuffman(weights, count), end];
};

const decodeStream = (data: Uint8Array, table: HuffmanTable, out: Uint8Array): void => {
  const last = data[data.length - 1];
  if (!last) fail("a literal bitstream ends on a zero byte");
  const mask = (1 << table.maxBits) - 1;
  const floor = -table.maxBits;
  let bits = table.maxBits;
  let position = (data.length << 3) - 8 + highestBit(last) - bits;
  let state = 0;
  let written = 0;

  while (position > floor && written < out.length) {
    const byte = position >> 3;
    const wide =
      (data[byte] | (data[byte + 1] << 8) | (data[byte + 2] << 16)) >> (position & 7);
    state = ((state << bits) | wide) & mask;
    out[written] = table.symbols[state];
    written += 1;
    bits = table.bits[state];
    position -= bits;
  }
  if (position !== floor || written !== out.length) {
    fail("a literal bitstream is the wrong length");
  }
};

const decodeLiterals = (
  data: Uint8Array,
  table: HuffmanTable,
  out: Uint8Array,
  streams: boolean,
): void => {
  if (!streams) {
    decodeStream(data, table, out);
    return;
  }
  const quarter = (out.length + 3) >> 2;
  let at = 6;
  for (let stream = 0; stream < 4; stream += 1) {
    const size = data[stream << 1] | (data[(stream << 1) + 1] << 8);
    const end = stream === 3 ? data.length : at + size;
    const from = quarter * stream;
    decodeStream(data.subarray(at, end), table, out.subarray(from, from + quarter));
    at = end;
  }
};

const DEFAULT_TABLES = (): SequenceTables => {
  const build = (counts: number[], log: number): FseTable => {
    const held = new Int16Array(256);
    held.set(counts);
    return spread(held, counts.length, log);
  };
  return {
    literal: build(LITERAL_DEFAULT, 6),
    match: build(MATCH_DEFAULT, 6),
    offset: build(OFFSET_DEFAULT, 5),
  };
};

const PREDEFINED = DEFAULT_TABLES();

const rleTable = (symbol: number): FseTable => {
  const table = spread(Int16Array.of(...Array<number>(symbol).fill(0), 1), symbol + 1, 0);
  return table;
};

type Literals = { data: Uint8Array; size: number };

const readLiterals = (
  data: Uint8Array,
  at: number,
  entropy: Entropy,
): [Literals, number] => {
  const header = data[at];
  const kind = header & 3;
  const format = (header >> 2) & 3;
  let size = header >> 4;
  let packed = 0;
  let byte = at;

  if (kind < 2) {
    if (format & 1) {
      size |= data[byte + 1] << 4;
      byte += 1;
      if (format & 2) {
        size |= data[byte + 1] << 12;
        byte += 1;
      }
    } else {
      size = header >> 3;
    }
    byte += 1;
    if (kind === 0) {
      return [{ data: data.subarray(byte, byte + size), size }, byte + size];
    }
    return [{ data: new Uint8Array(size).fill(data[byte]), size }, byte + 1];
  }

  if (format < 2) {
    size |= (data[at + 1] & 63) << 4;
    packed = (data[at + 1] >> 6) | (data[at + 2] << 2);
    byte = at + 3;
  } else if (format === 2) {
    size |= (data[at + 1] << 4) | ((data[at + 2] & 3) << 12);
    packed = (data[at + 2] >> 2) | (data[at + 3] << 6);
    byte = at + 4;
  } else {
    size |= (data[at + 1] << 4) | ((data[at + 2] & 63) << 12);
    packed = (data[at + 2] >> 6) | (data[at + 3] << 2) | (data[at + 4] << 10);
    byte = at + 5;
  }

  if (kind === 2) {
    const [table, after] = readHuffman(data, byte);
    entropy.huffman = table;
    packed -= after - byte;
    byte = after;
  }
  const table = entropy.huffman ?? fail("literals without a huffman table");
  const out = new Uint8Array(size);
  decodeLiterals(data.subarray(byte, byte + packed), table, out, format !== 0);
  return [{ data: out, size }, byte + packed];
};

const readTables = (
  data: Uint8Array,
  at: number,
  entropy: Entropy,
): [SequenceTables, number] => {
  const modes = data[at];
  if (modes & 3) fail("a sequence header reserves bits that are set");
  const held = entropy.tables;
  const held3: (FseTable | null)[] = [
    held?.match ?? null,
    held?.offset ?? null,
    held?.literal ?? null,
  ];
  const fallbacks = [PREDEFINED.match, PREDEFINED.offset, PREDEFINED.literal];
  const tables: FseTable[] = [...fallbacks];
  let byte = at + 1;

  for (let which = 2; which > -1; which -= 1) {
    const mode = (modes >> ((which << 1) + 2)) & 3;
    if (mode === 1) {
      tables[which] = rleTable(data[byte]);
      byte += 1;
    } else if (mode === 2) {
      const [table, after] = readFse(data, byte, 9 - (which & 1));
      tables[which] = table;
      byte = after;
    } else if (mode === 3) {
      tables[which] = held3[which] ?? fail("a repeated table was never sent");
    }
  }
  const built = { match: tables[0], offset: tables[1], literal: tables[2] };
  entropy.tables = built;
  return [built, byte];
};

const readCount = (data: Uint8Array, at: number): [number, number] => {
  const first = data[at];
  if (first < 128) return [first, at + 1];
  if (first < 255) return [((first - 128) << 8) | data[at + 1], at + 2];
  return [(data[at + 1] | (data[at + 2] << 8)) + 0x7f00, at + 3];
};

const nextOffset = (raw: number, literals: number, recent: Int32Array): number => {
  if (raw > 3) {
    recent[2] = recent[1];
    recent[1] = recent[0];
    recent[0] = raw - 3;
    return recent[0];
  }
  const index = raw - (literals !== 0 ? 1 : 0);
  if (index === 0) return recent[0];
  const offset = index === 3 ? recent[0] - 1 : recent[index];
  if (index > 1) recent[2] = recent[1];
  recent[1] = recent[0];
  recent[0] = offset;
  return offset;
};

const runSequences = (
  data: Uint8Array,
  at: number,
  end: number,
  count: number,
  literals: Literals,
  entropy: Entropy,
  out: Uint8Array,
  written: number,
): number => {
  const [tables] = readTables(data, at, entropy);
  const last = data[end - 1];
  if (!last) fail("a sequence bitstream ends on a zero byte");
  const grab = (position: number, bits: number): number => {
    const byte = position >> 3;
    const wide =
      (data[byte] |
        (data[byte + 1] << 8) |
        (data[byte + 2] << 16) |
        (data[byte + 3] << 24)) >>>
      (position & 7);
    return bits === 32 ? wide : wide & ((1 << bits) - 1);
  };

  let position = (end << 3) - 8 + highestBit(last) - tables.literal.log;
  let literal = grab(position, tables.literal.log);
  position -= tables.offset.log;
  let offset = grab(position, tables.offset.log);
  position -= tables.match.log;
  let match = grab(position, tables.match.log);
  let read = 0;
  let cursor = written;

  for (let done = 0; done < count; done += 1) {
    const literalCode = tables.literal.symbols[literal];
    const literalBits = tables.literal.bits[literal];
    const matchCode = tables.match.symbols[match];
    const matchBits = tables.match.bits[match];
    const offsetCode = tables.offset.symbols[offset];
    const offsetBits = tables.offset.bits[offset];

    position -= offsetCode;
    const raw = (1 << offsetCode) + grab(position, offsetCode);
    position -= MATCH_BITS[matchCode];
    const matchLength = MATCH_BASE[matchCode] + grab(position, MATCH_BITS[matchCode]);
    position -= LITERAL_BITS[literalCode];
    const literalLength =
      LITERAL_BASE[literalCode] + grab(position, LITERAL_BITS[literalCode]);

    position -= literalBits;
    literal = tables.literal.next[literal] + grab(position, literalBits);
    position -= matchBits;
    match = tables.match.next[match] + grab(position, matchBits);
    position -= offsetBits;
    offset = tables.offset.next[offset] + grab(position, offsetBits);

    const distance = nextOffset(raw, literalLength, entropy.offsets);
    out.set(literals.data.subarray(read, read + literalLength), cursor);
    read += literalLength;
    cursor += literalLength;
    if (distance > cursor) fail("a match reaches before the window");
    for (let step = 0; step < matchLength; step += 1) {
      out[cursor + step] = out[cursor + step - distance];
    }
    cursor += matchLength;
  }

  out.set(literals.data.subarray(read, literals.size), cursor);
  return cursor + literals.size - read;
};

const decodeBlock = (
  data: Uint8Array,
  at: number,
  end: number,
  entropy: Entropy,
  out: Uint8Array,
  written: number,
): number => {
  const [literals, next] = readLiterals(data, at, entropy);
  const [count, start] = readCount(data, next);
  if (count === 0) {
    out.set(literals.data.subarray(0, literals.size), written);
    return written + literals.size;
  }
  return runSequences(data, start, end, count, literals, entropy, out, written);
};

const readFrame = (data: Uint8Array): [number, number] => {
  const magic = data[0] | (data[1] << 8) | (data[2] << 16);
  if (magic !== FRAME_MAGIC || data[3] !== 253) fail("not a zstd frame");
  const flags = data[4];
  const single = (flags >> 5) & 1;
  const sizeFlag = flags >> 6;
  const at = 6 - single + (flags & 3 ? ((flags & 3) === 3 ? 4 : flags & 3) : 0);
  const sizeBytes = sizeFlag ? 1 << sizeFlag : single;
  let size = 0;
  for (let step = 0; step < sizeBytes; step += 1) size += data[at + step] * 256 ** step;
  return [at + sizeBytes, sizeBytes ? size + (sizeFlag === 1 ? 256 : 0) : 0];
};

const grow = (out: Uint8Array, needed: number): Uint8Array => {
  if (needed <= out.length) return out;
  const wider = new Uint8Array(Math.max(needed, out.length * 2));
  wider.set(out);
  return wider;
};

/** One frame, with any dictionary laid in front of it as the window it reaches. */
export const decompress = (
  data: Uint8Array,
  dictionary?: Dictionary | null,
): Uint8Array => {
  const [start, size] = readFrame(data);
  const prefix = dictionary ? dictionary.content : new Uint8Array(0);
  const entropy: Entropy = {
    huffman: dictionary?.huffman ?? null,
    tables: dictionary?.tables ?? null,
    offsets: Int32Array.from(dictionary ? dictionary.offsets : [1, 4, 8]),
  };

  let out: Uint8Array = new Uint8Array(prefix.length + (size || 1 << 16));
  out.set(prefix);
  let written = prefix.length;
  let at = start;
  for (;;) {
    const header = data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
    const kind = (header >> 1) & 3;
    const held = header >> 3;
    at += 3;
    out = grow(out, written + held + (1 << 17));
    if (kind === 0) {
      out.set(data.subarray(at, at + held), written);
      written += held;
      at += held;
    } else if (kind === 1) {
      out.fill(data[at], written, written + held);
      written += held;
      at += 1;
    } else if (kind === 2) {
      written = decodeBlock(data, at, at + held, entropy, out, written);
      at += held;
    } else {
      fail("a block has no known type");
    }
    if (header & 1) break;
  }
  return out.subarray(prefix.length, written);
};

/** A trained dictionary: its entropy tables, its repeat offsets and its content. */
export const loadDictionary = (data: Uint8Array): Dictionary => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== DICTIONARY_MAGIC) {
    return { id: 0, content: data, huffman: null, tables: null, offsets: [1, 4, 8] };
  }
  const [huffman, afterHuffman] = readHuffman(data, 8);
  const [offset, afterOffset] = readFse(data, afterHuffman, 8);
  const [match, afterMatch] = readFse(data, afterOffset, 9);
  const [literal, afterLiteral] = readFse(data, afterMatch, 9);
  return {
    id: view.getUint32(4, true),
    content: data.subarray(afterLiteral + 12),
    huffman,
    tables: { literal, match, offset },
    offsets: [0, 1, 2].map((step) => view.getUint32(afterLiteral + step * 4, true)),
  };
};
