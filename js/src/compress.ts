/** Raw LZMA1 to an end marker, step for step the encoder liblzma runs at preset 9. */

import {
  ALIGN,
  HALF,
  HIGH,
  IS_FIRST,
  IS_LONG,
  IS_MATCH,
  IS_REPEAT,
  IS_SECOND,
  IS_THIRD,
  LENGTHS,
  LITERALS,
  LOW,
  MIDDLE,
  REPEATS,
  SLOTS,
  SPECIAL,
  type Tuning,
} from "./lzma.ts";
import { LONGEST, Matcher, NICE } from "./matcher.ts";

const PRICES = Uint8Array.of(
  128,
  103,
  91,
  84,
  78,
  73,
  69,
  66,
  63,
  61,
  58,
  56,
  54,
  52,
  51,
  49,
  48,
  46,
  45,
  44,
  43,
  42,
  41,
  40,
  39,
  38,
  37,
  36,
  35,
  34,
  34,
  33,
  32,
  31,
  31,
  30,
  29,
  29,
  28,
  28,
  27,
  26,
  26,
  25,
  25,
  24,
  24,
  23,
  23,
  22,
  22,
  22,
  21,
  21,
  20,
  20,
  19,
  19,
  19,
  18,
  18,
  17,
  17,
  17,
  16,
  16,
  16,
  15,
  15,
  15,
  14,
  14,
  14,
  13,
  13,
  13,
  12,
  12,
  12,
  11,
  11,
  11,
  11,
  10,
  10,
  10,
  10,
  9,
  9,
  9,
  9,
  8,
  8,
  8,
  8,
  7,
  7,
  7,
  7,
  6,
  6,
  6,
  6,
  5,
  5,
  5,
  5,
  5,
  4,
  4,
  4,
  4,
  3,
  3,
  3,
  3,
  3,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  1,
  1,
  1,
  1,
);

const TOP = 1 << 24;
const TOTAL = 2048;
const SYMBOLS = 58;
const BIT_0 = 0;
const BIT_1 = 1;
const DIRECT_0 = 2;
const DIRECT_1 = 3;
const FLUSH = 4;

const REPS = 4;
const OPTS = 1 << 12;
const INFINITE = 1 << 30;
const NO_BACK = 0xffffffff;
const LITERAL_STATES = 7;
const FULL_DISTANCES = 128;
const DISTANCE_SLOTS = 40;
const ALIGN_SIZE = 16;
const LENGTH_TABLE = NICE - 1;
const STRIDE = 272;
const BYTES_LIMIT = 2_000_000;

const afterLiteral = (state: number): number =>
  state < 4 ? 0 : state < 10 ? state - 3 : state - 6;

const afterMatch = (state: number): number => (state < LITERAL_STATES ? 7 : 10);

const afterLongRep = (state: number): number => (state < LITERAL_STATES ? 8 : 11);

const afterShortRep = (state: number): number => (state < LITERAL_STATES ? 9 : 11);

const slotOf = (distance: number): number => {
  if (distance < 4) return distance;
  const top = 31 - Math.clz32(distance);
  return (top << 1) + ((distance >>> (top - 1)) & 1);
};

const distanceState = (length: number): number => (length < 6 ? length - 2 : 3);

const price0 = (probs: Uint16Array, slot: number): number => PRICES[probs[slot] >> 4];

const price1 = (probs: Uint16Array, slot: number): number =>
  PRICES[(probs[slot] ^ (TOTAL - 1)) >> 4];

const priceOf = (probs: Uint16Array, slot: number, bit: number): number =>
  PRICES[(probs[slot] ^ (bit ? TOTAL - 1 : 0)) >> 4];

const treePrice = (
  probs: Uint16Array,
  base: number,
  bits: number,
  symbol: number,
): number => {
  let price = 0;
  let node = symbol + (1 << bits);
  while (node !== 1) {
    const bit = node & 1;
    node >>= 1;
    price += priceOf(probs, base + node, bit);
  }
  return price;
};

const reversePrice = (
  probs: Uint16Array,
  base: number,
  bits: number,
  symbol: number,
): number => {
  let price = 0;
  let index = 1;
  let left = symbol;
  for (let step = 0; step < bits; step += 1) {
    const bit = left & 1;
    left >>= 1;
    price += priceOf(probs, base + index, bit);
    index = (index << 1) + bit;
  }
  return price;
};

class RangeEncoder {
  private low = 0;
  private extra = 1;
  private range = 0xffffffff;
  private cache = 0;
  private count = 0;
  private at = 0;
  private readonly kinds = new Uint8Array(SYMBOLS);
  private readonly slots = new Int32Array(SYMBOLS);
  private out = new Uint8Array(1 << 12);
  private size = 0;

  readonly probs: Uint16Array;

  constructor(probs: Uint16Array) {
    this.probs = probs;
  }

  bit(slot: number, bit: number): void {
    this.kinds[this.count] = bit;
    this.slots[this.count] = slot;
    this.count += 1;
  }

  tree(base: number, bits: number, symbol: number): void {
    let index = 1;
    for (let left = bits - 1; left >= 0; left -= 1) {
      const bit = (symbol >>> left) & 1;
      this.bit(base + index, bit);
      index = (index << 1) + bit;
    }
  }

  reverse(base: number, bits: number, symbol: number): void {
    let index = 1;
    let left = symbol;
    for (let step = 0; step < bits; step += 1) {
      const bit = left & 1;
      left >>>= 1;
      this.bit(base + index, bit);
      index = (index << 1) + bit;
    }
  }

  direct(value: number, bits: number): void {
    for (let left = bits - 1; left >= 0; left -= 1) {
      this.kinds[this.count] = DIRECT_0 + ((value >>> left) & 1);
      this.count += 1;
    }
  }

  flush(): void {
    for (let step = 0; step < 5; step += 1) {
      this.kinds[this.count] = FLUSH;
      this.count += 1;
    }
  }

  encode(): void {
    const { probs, kinds, slots } = this;
    while (this.at < this.count) {
      if (this.range < TOP) {
        this.shift();
        this.range = (this.range << 8) >>> 0;
      }
      const kind = kinds[this.at];
      if (kind === BIT_0) {
        const prob = probs[slots[this.at]];
        this.range = (this.range >>> 11) * prob;
        probs[slots[this.at]] = prob + ((TOTAL - prob) >> 5);
      } else if (kind === BIT_1) {
        const prob = probs[slots[this.at]];
        const bound = prob * (this.range >>> 11);
        this.low += bound;
        this.range -= bound;
        probs[slots[this.at]] = prob - (prob >> 5);
      } else if (kind === FLUSH) {
        this.finish();
        return;
      } else {
        this.range >>>= 1;
        if (kind === DIRECT_1) this.low += this.range;
      }
      this.at += 1;
    }
    this.count = 0;
    this.at = 0;
  }

  bytes(): Uint8Array {
    return this.out.slice(0, this.size);
  }

  private finish(): void {
    this.range = 0xffffffff;
    do {
      this.shift();
      this.at += 1;
    } while (this.at < this.count);
    this.low = 0;
    this.extra = 1;
    this.cache = 0;
    this.count = 0;
    this.at = 0;
  }

  private push(byte: number): void {
    if (this.size === this.out.length) {
      const grown = new Uint8Array(this.size * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.size] = byte;
    this.size += 1;
  }

  private shift(): void {
    const lower = this.low % 0x100000000;
    if (lower < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let byte = this.cache;
      do {
        this.push((byte + carry) & 0xff);
        byte = 0xff;
        this.extra -= 1;
      } while (this.extra !== 0);
      this.cache = (lower >>> 24) & 0xff;
    }
    this.extra += 1;
    this.low = (lower & 0xffffff) * 256;
  }
}

class Lengths {
  readonly prices = new Uint32Array(16 * STRIDE);
  readonly counters = new Int32Array(16);

  readonly base: number;
  readonly probs: Uint16Array;

  constructor(base: number, probs: Uint16Array) {
    this.base = base;
    this.probs = probs;
  }

  low(state: number): number {
    return this.base + LOW + state * 8;
  }

  middle(state: number): number {
    return this.base + MIDDLE + state * 8;
  }

  price(length: number, state: number): number {
    return this.prices[state * STRIDE + length - 2];
  }

  update(state: number): void {
    const { probs, base, prices } = this;
    this.counters[state] = LENGTH_TABLE;
    const first = price0(probs, base);
    const second = price1(probs, base);
    const third = second + price0(probs, base + 1);
    const fourth = second + price1(probs, base + 1);
    const row = state * STRIDE;
    for (let at = 0; at < LENGTH_TABLE; at += 1) {
      if (at < 8) {
        prices[row + at] = first + treePrice(probs, this.low(state), 3, at);
      } else if (at < 16) {
        prices[row + at] = third + treePrice(probs, this.middle(state), 3, at - 8);
      } else {
        prices[row + at] = fourth + treePrice(probs, base + HIGH, 8, at - 16);
      }
    }
  }
}

class Path {
  readonly state = new Uint8Array(OPTS + LONGEST + 2);
  readonly previousLiteral = new Uint8Array(OPTS + LONGEST + 2);
  readonly twice = new Uint8Array(OPTS + LONGEST + 2);
  readonly positionTwice = new Uint32Array(OPTS + LONGEST + 2);
  readonly backTwice = new Uint32Array(OPTS + LONGEST + 2);
  readonly price = new Uint32Array(OPTS + LONGEST + 2);
  readonly position = new Uint32Array(OPTS + LONGEST + 2);
  readonly back = new Uint32Array(OPTS + LONGEST + 2);
  readonly backs = new Uint32Array((OPTS + LONGEST + 2) * REPS);
}

class Encoder {
  private readonly probs: Uint16Array;
  private readonly ranges: RangeEncoder;
  private readonly matcher: Matcher;
  private readonly matchLengths: Lengths;
  private readonly repLengths: Lengths;
  readonly path = new Path();
  private readonly reps = new Uint32Array(REPS);
  readonly repLens = new Uint32Array(REPS);
  private readonly slotPrices = new Uint32Array(4 * 64);
  private readonly distancePrices = new Uint32Array(4 * FULL_DISTANCES);
  private readonly alignPrices = new Uint32Array(ALIGN_SIZE);
  private readonly literalContext: number;
  private readonly literalMask: number;
  private readonly positionMask: number;
  private state = 0;
  private longest = 0;
  private found = 0;
  private matchPriceCount = 0x7fffffff;
  private alignPriceCount = 0x7fffffff;
  private endIndex = 0;
  private currentIndex = 0;
  private back = 0;
  private length = 0;

  readonly data: Uint8Array;

  constructor(data: Uint8Array, [context, position, matches]: Tuning) {
    this.data = data;
    this.probs = new Uint16Array(LITERALS + (0x300 << (context + position))).fill(HALF);
    this.ranges = new RangeEncoder(this.probs);
    this.matcher = new Matcher(data);
    this.matchLengths = new Lengths(LENGTHS, this.probs);
    this.repLengths = new Lengths(REPEATS, this.probs);
    this.literalContext = context;
    this.literalMask = (1 << position) - 1;
    this.positionMask = (1 << matches) - 1;
    for (let state = 0; state <= this.positionMask; state += 1) {
      this.matchLengths.update(state);
      this.repLengths.update(state);
    }
  }

  run(): Uint8Array {
    const { matcher, ranges, data } = this;
    if (data.length > 0) {
      matcher.skip(1);
      matcher.readAhead = 0;
      ranges.bit(IS_MATCH, 0);
      ranges.tree(LITERALS, 8, data[0]);
    }
    let position = matcher.readPos - matcher.readAhead;
    for (;;) {
      ranges.encode();
      if (matcher.readPos >= matcher.end && matcher.readAhead === 0) break;
      this.optimum(position);
      this.encode(this.back, this.length, position);
      position += this.length;
    }
    this.endMarker(position);
    ranges.flush();
    ranges.encode();
    return ranges.bytes();
  }

  private endMarker(position: number): void {
    const { ranges } = this;
    const spot = position & this.positionMask;
    ranges.bit(IS_MATCH + this.state * 16 + spot, 1);
    ranges.bit(IS_REPEAT + this.state, 0);
    this.match(spot, 0xffffffff, 2);
  }

  private literalBase(position: number, previous: number): number {
    const context = this.literalContext;
    const spot = ((position & this.literalMask) << context) + (previous >> (8 - context));
    return LITERALS + 0x300 * spot;
  }

  private literal(position: number): void {
    const { matcher, data, ranges } = this;
    const at = matcher.readPos - matcher.readAhead;
    const base = this.literalBase(position, data[at - 1]);
    if (this.state < LITERAL_STATES) {
      ranges.tree(base, 8, data[at]);
    } else {
      this.literalMatched(base, data[at - this.reps[0] - 1], data[at]);
    }
    this.state = afterLiteral(this.state);
  }

  private literalMatched(base: number, matchByte: number, symbol: number): void {
    let offset = 0x100;
    let left = symbol + 0x100;
    let byte = matchByte;
    do {
      byte <<= 1;
      const matchBit = byte & offset;
      this.ranges.bit(base + offset + matchBit + (left >> 8), (left >> 7) & 1);
      left <<= 1;
      offset &= ~(byte ^ left);
    } while (left < 0x10000);
  }

  private writeLength(lengths: Lengths, spot: number, length: number): void {
    const { ranges } = this;
    const base = lengths.base;
    const rest = length - 2;
    if (rest < 8) {
      ranges.bit(base, 0);
      ranges.tree(lengths.low(spot), 3, rest);
    } else if (rest < 16) {
      ranges.bit(base, 1);
      ranges.bit(base + 1, 0);
      ranges.tree(lengths.middle(spot), 3, rest - 8);
    } else {
      ranges.bit(base, 1);
      ranges.bit(base + 1, 1);
      ranges.tree(base + HIGH, 8, rest - 16);
    }
    lengths.counters[spot] -= 1;
    if (lengths.counters[spot] === 0) lengths.update(spot);
  }

  private match(spot: number, distance: number, length: number): void {
    const { ranges } = this;
    this.state = afterMatch(this.state);
    this.writeLength(this.matchLengths, spot, length);
    const slot = slotOf(distance);
    ranges.tree(SLOTS + distanceState(length) * 64, 6, slot);
    if (slot >= 4) this.writeDistance(distance, slot);
    this.reps[3] = this.reps[2];
    this.reps[2] = this.reps[1];
    this.reps[1] = this.reps[0];
    this.reps[0] = distance;
    this.matchPriceCount += 1;
  }

  private writeDistance(distance: number, slot: number): void {
    const { ranges } = this;
    const footer = (slot >> 1) - 1;
    const base = (2 | (slot & 1)) * 2 ** footer;
    const reduced = distance - base;
    if (slot < 14) {
      ranges.reverse(SPECIAL + base - slot - 1, footer, reduced);
      return;
    }
    ranges.direct(Math.floor(reduced / 16), footer - 4);
    ranges.reverse(ALIGN, 4, reduced & 15);
    this.alignPriceCount += 1;
  }

  private repMatch(spot: number, rep: number, length: number): void {
    const { ranges, reps } = this;
    const { state } = this;
    if (rep === 0) {
      ranges.bit(IS_FIRST + state, 0);
      ranges.bit(IS_LONG + state * 16 + spot, length !== 1 ? 1 : 0);
    } else {
      const distance = reps[rep];
      ranges.bit(IS_FIRST + state, 1);
      if (rep === 1) {
        ranges.bit(IS_SECOND + state, 0);
      } else {
        ranges.bit(IS_SECOND + state, 1);
        ranges.bit(IS_THIRD + state, rep - 2);
        if (rep === 3) reps[3] = reps[2];
        reps[2] = reps[1];
      }
      reps[1] = reps[0];
      reps[0] = distance;
    }
    if (length === 1) {
      this.state = afterShortRep(state);
      return;
    }
    this.writeLength(this.repLengths, spot, length);
    this.state = afterLongRep(state);
  }

  private encode(back: number, length: number, position: number): void {
    const { ranges, matcher } = this;
    const spot = position & this.positionMask;
    if (back === NO_BACK) {
      ranges.bit(IS_MATCH + this.state * 16 + spot, 0);
      this.literal(position);
    } else if (back < REPS) {
      ranges.bit(IS_MATCH + this.state * 16 + spot, 1);
      ranges.bit(IS_REPEAT + this.state, 1);
      this.repMatch(spot, back, length);
    } else {
      ranges.bit(IS_MATCH + this.state * 16 + spot, 1);
      ranges.bit(IS_REPEAT + this.state, 0);
      this.match(spot, back - REPS, length);
    }
    matcher.readAhead -= length;
  }

  private literalPrice(
    position: number,
    previous: number,
    matched: boolean,
    matchByte: number,
    symbol: number,
  ): number {
    const { probs } = this;
    const base = this.literalBase(position, previous);
    if (!matched) return treePrice(probs, base, 8, symbol);
    let price = 0;
    let offset = 0x100;
    let left = symbol + 0x100;
    let byte = matchByte;
    do {
      byte <<= 1;
      const matchBit = byte & offset;
      price += priceOf(probs, base + offset + matchBit + (left >> 8), (left >> 7) & 1);
      left <<= 1;
      offset &= ~(byte ^ left);
    } while (left < 0x10000);
    return price;
  }

  private shortRepPrice(state: number, spot: number): number {
    const { probs } = this;
    return price0(probs, IS_FIRST + state) + price0(probs, IS_LONG + state * 16 + spot);
  }

  private pureRepPrice(rep: number, state: number, spot: number): number {
    const { probs } = this;
    if (rep === 0) {
      return price0(probs, IS_FIRST + state) + price1(probs, IS_LONG + state * 16 + spot);
    }
    const first = price1(probs, IS_FIRST + state);
    if (rep === 1) return first + price0(probs, IS_SECOND + state);
    return (
      first + price1(probs, IS_SECOND + state) + priceOf(probs, IS_THIRD + state, rep - 2)
    );
  }

  private repPrice(rep: number, length: number, state: number, spot: number): number {
    return this.repLengths.price(length, spot) + this.pureRepPrice(rep, state, spot);
  }

  private distanceLengthPrice(distance: number, length: number, spot: number): number {
    const state = distanceState(length);
    let price: number;
    if (distance < FULL_DISTANCES) {
      price = this.distancePrices[state * FULL_DISTANCES + distance];
    } else {
      price =
        this.slotPrices[state * 64 + slotOf(distance)] +
        this.alignPrices[distance & (ALIGN_SIZE - 1)];
    }
    return price + this.matchLengths.price(length, spot);
  }

  private fillDistancePrices(): void {
    const { probs, slotPrices, distancePrices } = this;
    for (let state = 0; state < 4; state += 1) {
      const row = state * 64;
      for (let slot = 0; slot < DISTANCE_SLOTS; slot += 1) {
        slotPrices[row + slot] = treePrice(probs, SLOTS + row, 6, slot);
      }
      for (let slot = 14; slot < DISTANCE_SLOTS; slot += 1) {
        slotPrices[row + slot] += ((slot >> 1) - 1 - 4) << 4;
      }
      for (let at = 0; at < 4; at += 1) {
        distancePrices[state * FULL_DISTANCES + at] = slotPrices[row + at];
      }
    }
    for (let at = 4; at < FULL_DISTANCES; at += 1) {
      const slot = slotOf(at);
      const footer = (slot >> 1) - 1;
      const base = (2 | (slot & 1)) << footer;
      const price = reversePrice(probs, SPECIAL + base - slot - 1, footer, at - base);
      for (let state = 0; state < 4; state += 1) {
        distancePrices[state * FULL_DISTANCES + at] =
          price + slotPrices[state * 64 + slot];
      }
    }
    this.matchPriceCount = 0;
  }

  private fillAlignPrices(): void {
    for (let at = 0; at < ALIGN_SIZE; at += 1) {
      this.alignPrices[at] = reversePrice(this.probs, ALIGN, 4, at);
    }
    this.alignPriceCount = 0;
  }

  private literalChoice(path: Path, at: number): void {
    path.back[at] = NO_BACK;
    path.previousLiteral[at] = 0;
  }

  private shortRepChoice(path: Path, at: number): void {
    path.back[at] = 0;
    path.previousLiteral[at] = 0;
  }

  private backward(cur: number): void {
    const { path } = this;
    this.endIndex = cur;
    let at = cur;
    let positionMemory = path.position[at];
    let backMemory = path.back[at];
    do {
      if (path.previousLiteral[at]) {
        this.literalChoice(path, positionMemory);
        path.position[positionMemory] = positionMemory - 1;
        if (path.twice[at]) {
          path.previousLiteral[positionMemory - 1] = 0;
          path.position[positionMemory - 1] = path.positionTwice[at];
          path.back[positionMemory - 1] = path.backTwice[at];
        }
      }
      const previous = positionMemory;
      const backNow = backMemory;
      backMemory = path.back[previous];
      positionMemory = path.position[previous];
      path.back[previous] = backNow;
      path.position[previous] = at;
      at = previous;
    } while (at !== 0);
    this.currentIndex = path.position[0];
    this.length = path.position[0];
    this.back = path.back[0];
  }

  private optimum(position: number): void {
    const { path, matcher } = this;
    if (this.endIndex !== this.currentIndex) {
      const next = path.position[this.currentIndex];
      this.length = next - this.currentIndex;
      this.back = path.back[this.currentIndex];
      this.currentIndex = next;
      return;
    }
    if (matcher.readAhead === 0) {
      if (this.matchPriceCount >= 1 << 7) this.fillDistancePrices();
      if (this.alignPriceCount >= ALIGN_SIZE) this.fillAlignPrices();
    }
    let end = this.first(position);
    if (end < 0) return;
    const reps = Uint32Array.from(this.reps);
    let cur = 1;
    for (; cur < end; cur += 1) {
      this.longest = matcher.find();
      this.found = matcher.count;
      if (this.longest >= NICE) break;
      const available = Math.min(matcher.available + 1, OPTS - 1 - cur);
      end = this.extend(reps, matcher.readPos - 1, end, position + cur, cur, available);
    }
    this.backward(cur);
  }

  private done(back: number, length: number): number {
    this.back = back;
    this.length = length;
    return -1;
  }

  private first(position: number): number {
    const { matcher, data, path, reps, repLens, probs } = this;
    const distances = matcher.distances;
    let main: number;
    let count: number;
    if (matcher.readAhead === 0) {
      main = matcher.find();
      count = matcher.count;
    } else {
      main = this.longest;
      count = this.found;
    }
    const available = Math.min(matcher.available + 1, LONGEST);
    if (available < 2) return this.done(NO_BACK, 1);
    const buf = matcher.readPos - 1;
    let best = 0;
    for (let rep = 0; rep < REPS; rep += 1) {
      const back = buf - reps[rep] - 1;
      if (data[buf] !== data[back] || data[buf + 1] !== data[back + 1]) {
        repLens[rep] = 0;
        continue;
      }
      repLens[rep] = matcher.same(buf, back, 2, available);
      if (repLens[rep] > repLens[best]) best = rep;
    }
    if (repLens[best] >= NICE) {
      matcher.skip(repLens[best] - 1);
      return this.done(best, repLens[best]);
    }
    if (main >= NICE) {
      matcher.skip(main - 1);
      return this.done(distances[count - 1] + REPS, main);
    }
    const current = data[buf];
    const matchByte = data[buf - reps[0] - 1];
    if (main < 2 && current !== matchByte && repLens[best] < 2) {
      return this.done(NO_BACK, 1);
    }
    path.state[0] = this.state;
    const spot = position & this.positionMask;
    path.price[1] =
      price0(probs, IS_MATCH + this.state * 16 + spot) +
      this.literalPrice(
        position,
        data[buf - 1],
        this.state >= LITERAL_STATES,
        matchByte,
        current,
      );
    this.literalChoice(path, 1);
    const matchPrice = price1(probs, IS_MATCH + this.state * 16 + spot);
    const repMatchPrice = matchPrice + price1(probs, IS_REPEAT + this.state);
    if (matchByte === current) {
      const shortPrice = repMatchPrice + this.shortRepPrice(this.state, spot);
      if (shortPrice < path.price[1]) {
        path.price[1] = shortPrice;
        this.shortRepChoice(path, 1);
      }
    }
    const end = Math.max(main, repLens[best]);
    if (end < 2) return this.done(path.back[1], 1);
    path.position[1] = 0;
    for (let rep = 0; rep < REPS; rep += 1) path.backs[rep] = reps[rep];
    for (let length = end; length >= 2; length -= 1) path.price[length] = INFINITE;
    this.firstReps(repMatchPrice, spot);
    this.firstMatches(matchPrice, spot, main, count);
    return end;
  }

  private firstReps(repMatchPrice: number, spot: number): void {
    const { path, repLens } = this;
    for (let rep = 0; rep < REPS; rep += 1) {
      if (repLens[rep] < 2) continue;
      const price = repMatchPrice + this.pureRepPrice(rep, this.state, spot);
      for (let length = repLens[rep]; length >= 2; length -= 1) {
        const total = price + this.repLengths.price(length, spot);
        if (total >= path.price[length]) continue;
        path.price[length] = total;
        path.position[length] = 0;
        path.back[length] = rep;
        path.previousLiteral[length] = 0;
      }
    }
  }

  private firstMatches(matchPrice: number, spot: number, main: number, count: number) {
    const { path, repLens, probs } = this;
    const { lengths, distances } = this.matcher;
    const normal = matchPrice + price0(probs, IS_REPEAT + this.state);
    let length = repLens[0] >= 2 ? repLens[0] + 1 : 2;
    if (length > main) return;
    let index = 0;
    while (length > lengths[index]) index += 1;
    for (; ; length += 1) {
      const distance = distances[index];
      const total = normal + this.distanceLengthPrice(distance, length, spot);
      if (total < path.price[length]) {
        path.price[length] = total;
        path.position[length] = 0;
        path.back[length] = distance + REPS;
        path.previousLiteral[length] = 0;
      }
      if (length === lengths[index]) {
        index += 1;
        if (index === count) break;
      }
    }
  }

  private extend(
    reps: Uint32Array,
    buf: number,
    lengthEnd: number,
    position: number,
    cur: number,
    availableFull: number,
  ): number {
    const { path, data, probs } = this;
    const state = this.stateAt(reps, cur);
    const spot = position & this.positionMask;
    const curPrice = path.price[cur];
    const current = data[buf];
    const matchByte = data[buf - reps[0] - 1];
    const literalTotal =
      curPrice +
      price0(probs, IS_MATCH + state * 16 + spot) +
      this.literalPrice(
        position,
        data[buf - 1],
        state >= LITERAL_STATES,
        matchByte,
        current,
      );
    let end = lengthEnd;
    let nextIsLiteral = false;
    if (literalTotal < path.price[cur + 1]) {
      path.price[cur + 1] = literalTotal;
      path.position[cur + 1] = cur;
      this.literalChoice(path, cur + 1);
      nextIsLiteral = true;
    }
    const matchPrice = curPrice + price1(probs, IS_MATCH + state * 16 + spot);
    const repMatchPrice = matchPrice + price1(probs, IS_REPEAT + state);
    if (
      matchByte === current &&
      !(path.position[cur + 1] < cur && path.back[cur + 1] === 0)
    ) {
      const shortPrice = repMatchPrice + this.shortRepPrice(state, spot);
      if (shortPrice <= path.price[cur + 1]) {
        path.price[cur + 1] = shortPrice;
        path.position[cur + 1] = cur;
        this.shortRepChoice(path, cur + 1);
        nextIsLiteral = true;
      }
    }
    if (availableFull < 2) return end;
    const available = Math.min(availableFull, NICE);
    if (!nextIsLiteral && matchByte !== current) {
      end = this.literalThenRep(
        reps,
        buf,
        end,
        cur,
        position,
        state,
        literalTotal,
        availableFull,
      );
    }
    const from = {
      reps,
      buf,
      cur,
      position,
      state,
      spot,
      matchPrice,
      repMatchPrice,
      available,
      availableFull,
    };
    return this.extendMatches(from, this.extendReps(from, end));
  }

  private stateAt(reps: Uint32Array, cur: number): number {
    const { path } = this;
    let positionBefore = path.position[cur];
    let state: number;
    if (path.previousLiteral[cur]) {
      positionBefore -= 1;
      if (path.twice[cur]) {
        state = path.state[path.positionTwice[cur]];
        state = path.backTwice[cur] < REPS ? afterLongRep(state) : afterMatch(state);
      } else {
        state = path.state[positionBefore];
      }
      state = afterLiteral(state);
    } else {
      state = path.state[positionBefore];
    }
    if (positionBefore === cur - 1) {
      state = path.back[cur] === 0 ? afterShortRep(state) : afterLiteral(state);
    } else {
      state = this.advance(reps, cur, positionBefore, state);
    }
    path.state[cur] = state;
    for (let rep = 0; rep < REPS; rep += 1) path.backs[cur * REPS + rep] = reps[rep];
    return state;
  }

  private advance(reps: Uint32Array, cur: number, before: number, start: number): number {
    const { path } = this;
    let positionBefore = before;
    let state = start;
    let distance: number;
    if (path.previousLiteral[cur] && path.twice[cur]) {
      positionBefore = path.positionTwice[cur];
      distance = path.backTwice[cur];
      state = afterLongRep(state);
    } else {
      distance = path.back[cur];
      state = distance < REPS ? afterLongRep(state) : afterMatch(state);
    }
    const backs = positionBefore * REPS;
    if (distance < REPS) {
      reps[0] = path.backs[backs + distance];
      let at = 1;
      for (; at <= distance; at += 1) reps[at] = path.backs[backs + at - 1];
      for (; at < REPS; at += 1) reps[at] = path.backs[backs + at];
    } else {
      reps[0] = distance - REPS;
      for (let at = 1; at < REPS; at += 1) reps[at] = path.backs[backs + at - 1];
    }
    return state;
  }

  private raise(path: Path, end: number, upTo: number): number {
    let last = end;
    while (last < upTo) {
      last += 1;
      path.price[last] = INFINITE;
    }
    return last;
  }

  private literalThenRep(
    reps: Uint32Array,
    buf: number,
    lengthEnd: number,
    cur: number,
    position: number,
    state: number,
    literalTotal: number,
    availableFull: number,
  ): number {
    const { path, probs } = this;
    const limit = Math.min(availableFull, NICE + 1);
    const test = this.matcher.same(buf, buf - reps[0] - 1, 1, limit) - 1;
    if (test < 2) return lengthEnd;
    const after = afterLiteral(state);
    const next = (position + 1) & this.positionMask;
    const nextRepPrice =
      literalTotal +
      price1(probs, IS_MATCH + after * 16 + next) +
      price1(probs, IS_REPEAT + after);
    const offset = cur + 1 + test;
    const end = this.raise(path, lengthEnd, offset);
    const total = nextRepPrice + this.repPrice(0, test, after, next);
    if (total >= path.price[offset]) return end;
    path.price[offset] = total;
    path.position[offset] = cur + 1;
    path.back[offset] = 0;
    path.previousLiteral[offset] = 1;
    path.twice[offset] = 0;
    return end;
  }

  private extendReps(from: Extension, lengthEnd: number): [number, number] {
    const { path, data } = this;
    const { reps, buf, cur, state, spot, repMatchPrice } = from;
    let end = lengthEnd;
    let start = 2;
    for (let rep = 0; rep < REPS; rep += 1) {
      const back = buf - reps[rep] - 1;
      if (data[buf] !== data[back] || data[buf + 1] !== data[back + 1]) continue;
      const test = this.matcher.same(buf, back, 2, from.available);
      end = this.raise(path, end, cur + test);
      const price = repMatchPrice + this.pureRepPrice(rep, state, spot);
      for (let length = test; length >= 2; length -= 1) {
        const total = price + this.repLengths.price(length, spot);
        if (total >= path.price[cur + length]) continue;
        path.price[cur + length] = total;
        path.position[cur + length] = cur;
        path.back[cur + length] = rep;
        path.previousLiteral[cur + length] = 0;
      }
      if (rep === 0) start = test + 1;
      end = this.matchLiteralRep(from, end, {
        back,
        test,
        price: price + this.repLengths.price(test, spot),
        mode: afterLongRep(state),
        previous: rep,
        isRep: true,
      });
    }
    return [end, start];
  }

  private matchLiteralRep(from: Extension, lengthEnd: number, plan: Plan): number {
    const { path, data, probs } = this;
    const { buf, cur, position } = from;
    const limit = Math.min(from.availableFull, plan.test + 1 + NICE);
    let again = plan.test + 1;
    if (again < limit) again = this.matcher.same(buf, plan.back, again, limit);
    again -= plan.test + 1;
    if (again < 2) return lengthEnd;
    let after = plan.mode;
    let next = (position + plan.test) & this.positionMask;
    const literalPrice =
      plan.price +
      price0(probs, IS_MATCH + after * 16 + next) +
      this.literalPrice(
        position + plan.test,
        data[buf + plan.test - 1],
        true,
        data[plan.back + plan.test],
        data[buf + plan.test],
      );
    after = afterLiteral(after);
    next = (next + 1) & this.positionMask;
    const nextRepPrice =
      literalPrice +
      price1(probs, IS_MATCH + after * 16 + next) +
      price1(probs, IS_REPEAT + after);
    const offset = cur + plan.test + 1 + again;
    const end = this.raise(path, lengthEnd, offset);
    const total = nextRepPrice + this.repPrice(0, again, after, next);
    if (total >= path.price[offset]) return end;
    path.price[offset] = total;
    path.position[offset] = cur + plan.test + 1;
    path.back[offset] = 0;
    path.previousLiteral[offset] = 1;
    path.twice[offset] = 1;
    path.positionTwice[offset] = cur;
    path.backTwice[offset] = plan.isRep ? plan.previous : plan.previous + REPS;
    return end;
  }

  private extendMatches(from: Extension, found: [number, number]): number {
    const { path, probs } = this;
    const { lengths, distances } = this.matcher;
    const { cur, spot, matchPrice, available, state } = from;
    let [end, start] = found;
    let longest = this.longest;
    let count = this.found;
    if (longest > available) {
      longest = available;
      count = 0;
      while (longest > lengths[count]) count += 1;
      lengths[count] = longest;
      count += 1;
    }
    if (longest < start) return end;
    const normal = matchPrice + price0(probs, IS_REPEAT + state);
    end = this.raise(path, end, cur + longest);
    let index = 0;
    while (start > lengths[index]) index += 1;
    for (let test = start; ; test += 1) {
      const back = distances[index];
      const total = normal + this.distanceLengthPrice(back, test, spot);
      if (total < path.price[cur + test]) {
        path.price[cur + test] = total;
        path.position[cur + test] = cur;
        path.back[cur + test] = back + REPS;
        path.previousLiteral[cur + test] = 0;
      }
      if (test === lengths[index]) {
        end = this.matchLiteralRep(from, end, {
          back: from.buf - back - 1,
          test,
          price: total,
          mode: afterMatch(state),
          previous: back,
          isRep: false,
        });
        index += 1;
        if (index === count) break;
      }
    }
    return end;
  }
}

type Extension = {
  reps: Uint32Array;
  buf: number;
  cur: number;
  position: number;
  state: number;
  spot: number;
  repMatchPrice: number;
  matchPrice: number;
  available: number;
  availableFull: number;
};

type Plan = {
  back: number;
  test: number;
  price: number;
  mode: number;
  previous: number;
  isRep: boolean;
};

/** One block as a raw stream, the way `lzma.ts` and liblzma read it. */
export const compress = (data: Uint8Array, tuning: Tuning): Uint8Array => {
  if (data.length > BYTES_LIMIT) throw new Error("lzma: a block over 2 MB");
  return new Encoder(data, tuning).run();
};
