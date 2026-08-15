/** What an address is before any database is opened. */

export type Value = string | number | bigint | Uint8Array;

export const PRIVATE = 1;
export const LOOPBACK = 2;
export const MULTICAST = 4;
export const RESERVED = 8;
export const LINK_LOCAL = 16;
export const UNIQUE_LOCAL = 32;
export const DOCUMENTATION = 64;
export const SHARED = 128;
export const BENCHMARK = 256;

export const MAPPED = "ipv4-mapped";
export const SIXTOFOUR = "6to4";
export const TEREDO = "teredo";
export const NAT64 = "nat64";

const V4_MAX = 0xffffffff;
const V6_MAX = (1n << 128n) - 1n;

const SPECIAL_V4: [string, number][] = [
  ["0.0.0.0/8", RESERVED],
  ["10.0.0.0/8", PRIVATE],
  ["100.64.0.0/10", PRIVATE | SHARED],
  ["127.0.0.0/8", PRIVATE | LOOPBACK],
  ["169.254.0.0/16", PRIVATE | LINK_LOCAL],
  ["172.16.0.0/12", PRIVATE],
  ["192.0.0.0/24", RESERVED],
  ["192.0.2.0/24", RESERVED | DOCUMENTATION],
  ["192.88.99.0/24", RESERVED],
  ["192.168.0.0/16", PRIVATE],
  ["198.18.0.0/15", RESERVED | BENCHMARK],
  ["198.51.100.0/24", RESERVED | DOCUMENTATION],
  ["203.0.113.0/24", RESERVED | DOCUMENTATION],
  ["224.0.0.0/4", MULTICAST],
  ["240.0.0.0/4", RESERVED],
];

const SPECIAL_V6: [string, number][] = [
  ["::/128", RESERVED],
  ["::1/128", PRIVATE | LOOPBACK],
  ["::ffff:0:0/96", RESERVED],
  ["64:ff9b::/96", RESERVED],
  ["64:ff9b:1::/48", RESERVED],
  ["100::/64", RESERVED],
  ["2001::/23", RESERVED],
  ["2001:db8::/32", RESERVED | DOCUMENTATION],
  ["2002::/16", RESERVED],
  ["3fff::/20", RESERVED | DOCUMENTATION],
  ["fc00::/7", PRIVATE | UNIQUE_LOCAL],
  ["fe80::/10", PRIVATE | LINK_LOCAL],
  ["ff00::/8", MULTICAST],
];

const OCTET = /^(0|[1-9][0-9]{0,2})$/;
const GROUP = /^[0-9a-fA-F]{1,4}$/;

const parseV4 = (text: string): number | null => {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
};

const groups = (text: string, expected: number): number[] | null => {
  if (text === "") return [];
  const parts = text.split(":");
  const held: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index === parts.length - 1 && part.includes(".")) {
      const embedded = parseV4(part);
      if (embedded === null) return null;
      held.push(embedded >>> 16, embedded & 0xffff);
      continue;
    }
    if (!GROUP.test(part)) return null;
    held.push(Number.parseInt(part, 16));
  }
  return held.length <= expected ? held : null;
};

const parseV6 = (text: string): bigint | null => {
  const sides = text.split("::");
  if (sides.length > 2) return null;
  const head = groups(sides[0], 8);
  const tail = sides.length === 2 ? groups(sides[1], 8) : [];
  if (head === null || tail === null) return null;
  const held = head.length + tail.length;
  if (sides.length === 1 ? held !== 8 : held > 7) return null;
  const all = [...head, ...Array<number>(8 - held).fill(0), ...tail];
  let value = 0n;
  for (const group of all) value = (value << 16n) | BigInt(group);
  return value;
};

/** An address however it is written; an integer reads as v6 only above 0xffffffff. */
export const parse = (value: Value): [number | bigint, boolean] => {
  if (typeof value === "string") {
    if (value.includes(":")) {
      const wide = parseV6(value);
      if (wide === null) throw new Error(`${value} is not an address`);
      return [wide, true];
    }
    const narrow = parseV4(value);
    if (narrow === null) throw new Error(`${value} is not an address`);
    return [narrow, false];
  }
  if (value instanceof Uint8Array) {
    if (value.length === 4) {
      return [
        ((value[0] << 24) >>> 0) + (value[1] << 16) + (value[2] << 8) + value[3],
        false,
      ];
    }
    if (value.length !== 16) throw new Error("packed addresses are 4 or 16 bytes");
    let held = 0n;
    for (const byte of value) held = (held << 8n) | BigInt(byte);
    return [held, true];
  }
  if (typeof value !== "bigint" && !Number.isInteger(value)) {
    throw new Error(`${String(value)} is not an address`);
  }
  const number = typeof value === "bigint" ? value : BigInt(value);
  if (number < 0n || number > V6_MAX) throw new Error(`${value} is not an address`);
  return number > BigInt(V4_MAX) ? [number, true] : [Number(number), false];
};

const hextets = (value: bigint): number[] =>
  Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(112 - index * 16)) & 0xffffn),
  );

const dotted = (value: number): string =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");

const shortest = (parts: string[], held: number[]): string => {
  let bestAt = -1;
  let bestRun = 1;
  let at = -1;
  for (let index = 0; index <= held.length; index += 1) {
    if (held[index] === 0 && at < 0) at = index;
    if ((held[index] !== 0 || index === held.length) && at >= 0) {
      if (index - at > bestRun) [bestAt, bestRun] = [at, index - at];
      at = -1;
    }
  }
  if (bestAt < 0) return parts.join(":");
  const head = parts.slice(0, bestAt).join(":");
  const tail = parts.slice(bestAt + bestRun).join(":");
  return `${head}::${tail}`;
};

/** How the address reads short and in full, and the name a resolver asks by. */
export const spelled = (
  value: number | bigint,
  wide: boolean,
): [string, string, string] => {
  if (!wide) {
    const text = dotted(value as number);
    const octets = text.split(".");
    return [text, text, `${[...octets].reverse().join(".")}.in-addr.arpa`];
  }
  const held = hextets(value as bigint);
  const nibbles = (value as bigint).toString(16).padStart(32, "0");
  const arpa = `${[...nibbles].reverse().join(".")}.ip6.arpa`;
  const mapped = held.slice(0, 5).every((group) => group === 0) && held[5] === 0xffff;
  if (mapped) {
    const quad = dotted(Number((value as bigint) & 0xffffffffn));
    const parts = held.slice(0, 6).map((group) => group.toString(16));
    const full = held.slice(0, 6).map((group) => group.toString(16).padStart(4, "0"));
    return [
      `${shortest(parts, held.slice(0, 6))}:${quad}`,
      `${full.join(":")}:${quad}`,
      arpa,
    ];
  }
  return [
    shortest(
      held.map((group) => group.toString(16)),
      held,
    ),
    held.map((group) => group.toString(16).padStart(4, "0")).join(":"),
    arpa,
  ];
};

/** An address as text: v4 from its octets, v6 through the shortening rules. */
export const written = (value: number | bigint, wide: boolean): string =>
  spelled(value, wide)[0];

const table = (rows: [string, number][], wide: boolean) =>
  rows
    .map(([text, marks]): [bigint, bigint, number] => {
      const [network, bits] = text.split("/");
      const first = BigInt(parse(network)[0]);
      const spare = BigInt((wide ? 128 : 32) - Number(bits));
      return [first, first + ((1n << spare) - 1n), marks];
    })
    .sort((left, right) => (left[0] < right[0] ? -1 : 1));

const SPECIAL = [table(SPECIAL_V4, false), table(SPECIAL_V6, true)];

/** What an address is where it is not the internet, bisected out of the table. */
export const purpose = (value: number | bigint, wide: boolean): number => {
  const rows = SPECIAL[wide ? 1 : 0];
  const held = BigInt(value);
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle][0] <= held) low = middle + 1;
    else high = middle;
  }
  const found = rows[low - 1];
  if (found && held <= found[1]) return found[2];
  return wide && held >> 125n !== 1n ? RESERVED : 0;
};

/** The v4 address a v6 one carries, and the tunnel that puts it there. */
export const tunnel = (
  value: number | bigint,
  wide: boolean,
): [string | null, string | null] => {
  if (!wide) return [null, null];
  const held = value as bigint;
  const low = Number(held & 0xffffffffn);
  if (held >> 32n === 0xffffn) return [MAPPED, dotted(low)];
  if (held >> 112n === 0x2002n) {
    return [SIXTOFOUR, dotted(Number((held >> 80n) & 0xffffffffn))];
  }
  if (held >> 96n === 0x20010000n) return [TEREDO, dotted(~low >>> 0)];
  if (held >> 32n === 0x0064ff9bn << 64n) return [NAT64, dotted(low)];
  return [null, null];
};

/** The v4 address an operator wrote into the last four hextets as decimal. */
export const guessed = (value: number | bigint, wide: boolean): string | null => {
  if (!wide || tunnel(value, wide)[0] !== null) return null;
  const held = value as bigint;
  const parts = [48n, 32n, 16n, 0n].map((shift) =>
    Number((held >> shift) & 0xffffn).toString(16),
  );
  const decimal = parts.every(
    (part) => /^[0-9]+$/.test(part) && Number(part) > 0 && Number(part) < 256,
  );
  return decimal ? parts.join(".") : null;
};

/** The v6 addresses a v4 one is written as where a tunnel carries it across. */
export const carried = (
  value: number | bigint,
  wide: boolean,
): [string | null, string | null, string | null] => {
  if (wide) return [null, null, null];
  const held = BigInt(value);
  return [
    written(0xffff00000000n | held, true),
    written((0x2002n << 112n) | (held << 80n), true),
    written((0x0064ff9bn << 96n) | held, true),
  ];
};

/** The announcement the address falls in, masked out of the address itself. */
export const span = (
  value: number | bigint,
  wide: boolean,
  prefix: number,
): [string, string, string] => {
  const spare = BigInt((wide ? 128 : 32) - prefix);
  const held = BigInt(value);
  const first = (held >> spare) << spare;
  const last = held | ((1n << spare) - 1n);
  const start = written(wide ? first : Number(first), wide);
  return [`${start}/${prefix}`, start, written(wide ? last : Number(last), wide)];
};
