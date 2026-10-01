/** The binary-tree match finder liblzma runs at preset 9: hash of four bytes, depth 48. */

export const NICE = 64;
export const LONGEST = 273;
export const CYCLIC = (1 << 20) + 1;

const DEPTH = 16 + NICE / 2;
const HASH_MASK = 0x7ffff;
const THIRD = 1 << 10;
const FOURTH = THIRD + (1 << 16);
const MIN_LENGTH = 4;

const CRC = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let step = 0; step < 8; step += 1) {
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
});

const hashes = new Uint32Array(HASH_MASK + 1 + FOURTH);
let sons = new Uint32Array(0);

export class Matcher {
  readonly lengths = new Uint32Array(LONGEST + 1);
  readonly distances = new Uint32Array(LONGEST + 1);
  readonly end: number;
  readPos = 0;
  readAhead = 0;
  count = 0;
  private cyclicPos = 0;

  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    this.end = data.length;
    hashes.fill(0);
    const needed = 2 * Math.min(CYCLIC, data.length + 1);
    if (sons.length < needed) sons = new Uint32Array(needed);
  }

  get available(): number {
    return this.end - this.readPos;
  }

  find(): number {
    this.count = this.search();
    this.readAhead += 1;
    if (this.count === 0) return 0;
    const best = this.lengths[this.count - 1];
    if (best !== NICE) return best;
    const limit = Math.min(this.available + 1, LONGEST);
    const from = this.readPos - 1;
    return this.same(from, from - this.distances[this.count - 1] - 1, best, limit);
  }

  skip(amount: number): void {
    if (amount === 0) return;
    for (let step = 0; step < amount; step += 1) this.skipOne();
    this.readAhead += amount;
  }

  same(one: number, other: number, length: number, limit: number): number {
    const { data } = this;
    let at = length;
    while (at < limit && data[one + at] === data[other + at]) at += 1;
    return at;
  }

  private limit(): number {
    const room = this.available;
    return NICE <= room ? NICE : room;
  }

  private search(): number {
    const limit = this.limit();
    if (limit < MIN_LENGTH) {
      this.readPos += 1;
      return 0;
    }
    const { data, lengths, distances } = this;
    const cur = this.readPos;
    const pos = cur + CYCLIC;
    const temp = CRC[data[cur]] ^ data[cur + 1];
    const second = temp & (THIRD - 1);
    const third = (temp ^ (data[cur + 2] << 8)) & 0xffff;
    const fourth = (temp ^ (data[cur + 2] << 8) ^ (CRC[data[cur + 3]] << 5)) & HASH_MASK;
    let delta = pos - hashes[second];
    const deltaThird = pos - hashes[THIRD + third];
    const match = hashes[FOURTH + fourth];
    hashes[second] = pos;
    hashes[THIRD + third] = pos;
    hashes[FOURTH + fourth] = pos;
    let best = 1;
    let count = 0;
    if (delta < CYCLIC && data[cur - delta] === data[cur]) {
      best = 2;
      lengths[0] = 2;
      distances[0] = delta - 1;
      count = 1;
    }
    if (
      delta !== deltaThird &&
      deltaThird < CYCLIC &&
      data[cur - deltaThird] === data[cur]
    ) {
      best = 3;
      distances[count] = deltaThird - 1;
      count += 1;
      delta = deltaThird;
    }
    if (count !== 0) {
      best = this.same(cur, cur - delta, best, limit);
      lengths[count - 1] = best;
      if (best === limit) {
        this.walk(limit, pos, cur, match, -1, 0);
        this.move();
        return count;
      }
    }
    count = this.walk(limit, pos, cur, match, Math.max(best, 3), count);
    this.move();
    return count;
  }

  private skipOne(): void {
    const limit = this.limit();
    if (limit < MIN_LENGTH) {
      this.readPos += 1;
      return;
    }
    const { data } = this;
    const cur = this.readPos;
    const pos = cur + CYCLIC;
    const temp = CRC[data[cur]] ^ data[cur + 1];
    const second = temp & (THIRD - 1);
    const third = (temp ^ (data[cur + 2] << 8)) & 0xffff;
    const fourth = (temp ^ (data[cur + 2] << 8) ^ (CRC[data[cur + 3]] << 5)) & HASH_MASK;
    const match = hashes[FOURTH + fourth];
    hashes[second] = pos;
    hashes[THIRD + third] = pos;
    hashes[FOURTH + fourth] = pos;
    this.walk(limit, pos, cur, match, -1, 0);
    this.move();
  }

  private move(): void {
    this.cyclicPos += 1;
    if (this.cyclicPos === CYCLIC) this.cyclicPos = 0;
    this.readPos += 1;
  }

  private walk(
    limit: number,
    pos: number,
    cur: number,
    first: number,
    longest: number,
    found: number,
  ): number {
    const { data, lengths, distances } = this;
    const collect = longest >= 0;
    let count = found;
    let best = longest;
    let match = first;
    let right = (this.cyclicPos << 1) + 1;
    let left = this.cyclicPos << 1;
    let rightLength = 0;
    let leftLength = 0;
    for (let depth = DEPTH; ; depth -= 1) {
      const delta = pos - match;
      if (depth === 0 || delta >= CYCLIC) {
        sons[right] = 0;
        sons[left] = 0;
        return count;
      }
      const behind = this.cyclicPos - delta + (delta > this.cyclicPos ? CYCLIC : 0);
      const pair = behind << 1;
      const from = cur - delta;
      let length = Math.min(rightLength, leftLength);
      if (data[from + length] === data[cur + length]) {
        length = this.same(from, cur, length + 1, limit);
        if (length === limit) {
          if (collect && best < length) {
            lengths[count] = length;
            distances[count] = delta - 1;
            count += 1;
          }
          sons[left] = sons[pair];
          sons[right] = sons[pair + 1];
          return count;
        }
        if (collect && best < length) {
          best = length;
          lengths[count] = length;
          distances[count] = delta - 1;
          count += 1;
        }
      }
      if (data[from + length] < data[cur + length]) {
        sons[left] = match;
        left = pair + 1;
        match = sons[left];
        leftLength = length;
      } else {
        sons[right] = match;
        right = pair;
        match = sons[right];
        rightLength = length;
      }
    }
  }
}
