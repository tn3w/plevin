/** Raw LZMA1 decompression to its end marker, after the public-domain LZMA SDK. */

export type Tuning = [context: number, position: number, matches: number];

const HALF = 1024;
const END = 0xffffffff;
const SIGN = 0x80000000;

const IS_MATCH = 0;
const IS_REPEAT = IS_MATCH + 192;
const IS_FIRST = IS_REPEAT + 12;
const IS_SECOND = IS_FIRST + 12;
const IS_THIRD = IS_SECOND + 12;
const IS_LONG = IS_THIRD + 12;
const SLOTS = IS_LONG + 192;
const SPECIAL = SLOTS + 256;
const ALIGN = SPECIAL + 114;
const LENGTHS = ALIGN + 16;
const REPEATS = LENGTHS + 514;
const LITERALS = REPEATS + 514;

const CHOICE = 0;
const LOW = 2;
const MIDDLE = LOW + 128;
const HIGH = MIDDLE + 128;

const fail = (reason: string): never => {
  throw new Error(`lzma: ${reason}`);
};

/**
 * One stream, decoded only as far as a reader has asked: a lookup needs the bytes up to
 * its row and no further, and the rest can follow when some later lookup reaches them.
 */
export class Lzma {
  bytes: Uint8Array;
  length = 0;
  done = false;

  private readonly data: Uint8Array;
  private readonly probs: Uint16Array;
  private readonly context: number;
  private readonly positionMask: number;
  private readonly matchMask: number;
  private range = -1;
  private code = 0;
  private at = 5;
  private state = 0;
  private recent0 = 0;
  private recent1 = 0;
  private recent2 = 0;
  private recent3 = 0;

  constructor(data: Uint8Array, [context, position, matches]: Tuning, expected = 0) {
    if (data.length < 5 || data[0] !== 0) fail("not a stream");
    this.data = data;
    this.bytes = new Uint8Array(Math.max(expected, data.length * 4, 256));
    this.probs = new Uint16Array(LITERALS + (0x300 << (context + position))).fill(HALF);
    this.context = context;
    this.positionMask = (1 << position) - 1;
    this.matchMask = (1 << matches) - 1;
    for (let index = 1; index < 5; index += 1) this.code = (this.code << 8) | data[index];
  }

  private bit(at: number): number {
    const probs = this.probs;
    const chance = probs[at];
    const bound = Math.imul(this.range >>> 11, chance);
    let bit = 0;
    if ((this.code ^ SIGN) < (bound ^ SIGN)) {
      this.range = bound;
      probs[at] = chance + ((2048 - chance) >> 5);
    } else {
      this.range = (this.range - bound) | 0;
      this.code = (this.code - bound) | 0;
      probs[at] = chance - (chance >> 5);
      bit = 1;
    }
    if (!(this.range >>> 24)) {
      if (this.at >= this.data.length) fail("the stream ends early");
      this.range <<= 8;
      this.code = (this.code << 8) | this.data[this.at++];
    }
    return bit;
  }

  private direct(count: number): number {
    let value = 0;
    for (let step = 0; step < count; step += 1) {
      this.range >>>= 1;
      const bit = (this.code ^ SIGN) >= (this.range ^ SIGN) ? 1 : 0;
      if (bit) this.code = (this.code - this.range) | 0;
      value = value * 2 + bit;
      if (!(this.range >>> 24)) {
        if (this.at >= this.data.length) fail("the stream ends early");
        this.range <<= 8;
        this.code = (this.code << 8) | this.data[this.at++];
      }
    }
    return value;
  }

  private tree(at: number, bits: number): number {
    let symbol = 1;
    for (let step = 0; step < bits; step += 1)
      symbol = (symbol << 1) | this.bit(at + symbol);
    return symbol - (1 << bits);
  }

  private reversed(at: number, bits: number): number {
    let symbol = 1;
    let value = 0;
    for (let step = 0; step < bits; step += 1) {
      const bit = this.bit(at + symbol);
      symbol = (symbol << 1) | bit;
      value |= bit << step;
    }
    return value;
  }

  private span(model: number, spot: number): number {
    if (!this.bit(model + CHOICE)) return this.tree(model + LOW + (spot << 3), 3);
    if (!this.bit(model + CHOICE + 1))
      return 8 + this.tree(model + MIDDLE + (spot << 3), 3);
    return 16 + this.tree(model + HIGH, 8);
  }

  private distance(length: number): number {
    const slot = this.tree(SLOTS + (Math.min(length, 3) << 6), 6);
    if (slot < 4) return slot;
    const direct = (slot >> 1) - 1;
    const base = (2 | (slot & 1)) * 2 ** direct;
    if (slot < 14) return base + this.reversed(SPECIAL + base - slot - 1, direct);
    return base + this.direct(direct - 4) * 16 + this.reversed(ALIGN, 4);
  }

  private room(more: number): void {
    if (this.length + more <= this.bytes.length) return;
    const bytes = new Uint8Array(Math.max(this.bytes.length * 2, this.length + more));
    bytes.set(this.bytes.subarray(0, this.length));
    this.bytes = bytes;
  }

  private literal(): void {
    const bytes = this.bytes;
    const length = this.length;
    const previous = length ? bytes[length - 1] : 0;
    const base =
      LITERALS +
      0x300 *
        (((length & this.positionMask) << this.context) +
          (previous >> (8 - this.context)));
    let symbol = 1;
    if (this.state >= 7) {
      let matched = bytes[length - this.recent0 - 1];
      while (symbol < 0x100) {
        const bit = (matched >> 7) & 1;
        matched <<= 1;
        const read = this.bit(base + ((1 + bit) << 8) + symbol);
        symbol = (symbol << 1) | read;
        if (read !== bit) break;
      }
    }
    while (symbol < 0x100) symbol = (symbol << 1) | this.bit(base + symbol);
    this.room(1);
    this.bytes[this.length++] = symbol & 0xff;
    const state = this.state;
    this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
  }

  private copy(count: number): void {
    this.room(count);
    const bytes = this.bytes;
    const from = this.length - this.recent0 - 1;
    for (let step = 0; step < count; step += 1)
      bytes[this.length + step] = bytes[from + step];
    this.length += count;
  }

  /** Decodes until at least `want` bytes are out, or the stream ends. */
  until(want: number): Uint8Array {
    while (!this.done && this.length < want) this.step();
    return this.bytes;
  }

  private step(): void {
    const spot = this.length & this.matchMask;
    const state = this.state;
    if (!this.bit(IS_MATCH + ((state << 4) | spot))) {
      this.literal();
      return;
    }
    const repeated = this.bit(IS_REPEAT + state);
    const length = repeated ? this.repeat(state, spot) : this.fresh(state, spot);
    if (this.done) return;
    if (this.recent0 >= this.length) fail("a match reaches before the start");
    this.copy(length + 2);
  }

  private fresh(state: number, spot: number): number {
    this.recent3 = this.recent2;
    this.recent2 = this.recent1;
    this.recent1 = this.recent0;
    const length = this.span(LENGTHS, spot);
    this.state = state < 7 ? 7 : 10;
    this.recent0 = this.distance(length);
    this.done = this.recent0 === END;
    return length;
  }

  private repeat(state: number, spot: number): number {
    if (!this.length) fail("a repeat before any byte");
    if (this.bit(IS_FIRST + state)) this.rotate(state);
    else if (!this.bit(IS_LONG + ((state << 4) | spot))) {
      this.state = state < 7 ? 9 : 11;
      return -1;
    }
    this.state = state < 7 ? 8 : 11;
    return this.span(REPEATS, spot);
  }

  private rotate(state: number): void {
    let held = this.recent1;
    if (this.bit(IS_SECOND + state)) {
      held = this.recent2;
      if (this.bit(IS_THIRD + state)) {
        held = this.recent3;
        this.recent3 = this.recent2;
      }
      this.recent2 = this.recent1;
    }
    this.recent1 = this.recent0;
    this.recent0 = held;
  }
}

/** A whole stream at once, for a reader that wants every byte of it. */
export const decompress = (data: Uint8Array, tuning: Tuning): Uint8Array => {
  const stream = new Lzma(data, tuning);
  stream.until(Number.POSITIVE_INFINITY);
  return stream.bytes.subarray(0, stream.length);
};
