/** What DNS says about an address: datagrams where a runtime has them, HTTPS where not. */

import { parse, spelled, tunnel, written } from "./address.ts";
import type { Dns } from "./models.ts";

export const PUBLIC_SERVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
export const RESOLVERS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/dns-query",
];

const TIMEOUT = 2000;
const KEPT = 4096;
const KEPT_FOR = 3_600_000;
const PAYLOAD = 1232;
const ANSWERED = new Set([0, 3]);
const KINDS = { A: 1, CNAME: 5, SOA: 6, PTR: 12, AAAA: 28 } as const;

export type Kind = keyof typeof KINDS;
export type Question = [string, Kind, Kind | null];
export type Record = { name: string; kind: number; data: string };
export type Reply = {
  code: number;
  authentic: boolean;
  truncated: boolean;
  answer: Record[];
  authority: Record[];
};

/** One question, recursion asked for, DNSSEC status asked for, EDNS0 announced. */
export const encodeQuery = (name: string, kind: Kind): Uint8Array => {
  const labels = name.split(".").filter(Boolean);
  const size = labels.reduce((held, label) => held + label.length + 1, 0);
  const message = new Uint8Array(12 + size + 1 + 4 + 11);
  const view = new DataView(message.buffer);
  view.setUint16(0, Math.floor(Math.random() * 65536));
  view.setUint16(2, 0x0120);
  view.setUint16(4, 1);
  view.setUint16(10, 1);
  let at = 12;
  for (const label of labels) {
    message[at] = label.length;
    for (let index = 0; index < label.length; index += 1) {
      message[at + 1 + index] = label.charCodeAt(index);
    }
    at += label.length + 1;
  }
  at += 1;
  view.setUint16(at, KINDS[kind]);
  view.setUint16(at + 2, 1);
  view.setUint16(at + 5, 41);
  view.setUint16(at + 7, PAYLOAD);
  return message;
};

/** A name, following compression pointers, and where the record goes on. */
const readName = (message: Uint8Array, from: number): [string, number] => {
  const labels: string[] = [];
  let at = from;
  let after = -1;
  for (let step = 0; step < 128; step += 1) {
    const length = message[at];
    if (length >= 0xc0) {
      if (after < 0) after = at + 2;
      at = ((length & 0x3f) << 8) | message[at + 1];
      continue;
    }
    at += 1;
    if (!length) return [labels.join("."), after < 0 ? at : after];
    labels.push(String.fromCharCode(...message.slice(at, at + length)).toLowerCase());
    at += length;
  }
  throw new Error("name loops");
};

const readData = (message: Uint8Array, at: number, kind: number): string => {
  if (kind === KINDS.A) {
    const held = message.slice(at, at + 4);
    return written(
      ((held[0] << 24) >>> 0) + (held[1] << 16) + (held[2] << 8) + held[3],
      false,
    );
  }
  if (kind === KINDS.AAAA) {
    let held = 0n;
    for (const byte of message.slice(at, at + 16)) held = (held << 8n) | BigInt(byte);
    return written(held, true);
  }
  if (kind === KINDS.CNAME || kind === KINDS.PTR) return readName(message, at)[0];
  if (kind === KINDS.SOA) {
    const [primary, next] = readName(message, at);
    return `${primary} ${readName(message, next)[0]}`;
  }
  return "";
};

/** A reply as its header bits, its answers and the zone that owns them. */
export const decode = (message: Uint8Array): Reply => {
  const view = new DataView(message.buffer, message.byteOffset);
  const flags = view.getUint16(2);
  const counts = [view.getUint16(4), view.getUint16(6), view.getUint16(8)];
  let at = 12;
  for (let index = 0; index < counts[0]; index += 1) at = readName(message, at)[1] + 4;
  const sections: Record[][] = [];
  for (const count of counts.slice(1)) {
    const records: Record[] = [];
    for (let index = 0; index < count; index += 1) {
      const [name, next] = readName(message, at);
      const kind = view.getUint16(next);
      const length = view.getUint16(next + 8);
      records.push({ name, kind, data: readData(message, next + 10, kind) });
      at = next + 10 + length;
    }
    sections.push(records);
  }
  return {
    code: flags & 15,
    authentic: (flags & 0x20) !== 0,
    truncated: (flags & 0x200) !== 0,
    answer: sections[0],
    authority: sections[1],
  };
};

export const records = (
  reply: Reply | null,
  kind: Kind,
  section: "answer" | "any" = "answer",
): Record[] => {
  if (!reply) return [];
  const found = section === "any" ? [...reply.answer, ...reply.authority] : reply.answer;
  return found.filter((record) => record.kind === KINDS[kind]);
};

const answers = (reply: Reply | null, kind: Kind): string[] =>
  records(reply, kind).map((record) => record.data);

const read = (message: Uint8Array): Reply | null => {
  try {
    const reply = decode(message);
    return ANSWERED.has(reply.code) ? reply : null;
  } catch {
    return null;
  }
};

type Datagram = {
  on(event: "error", listener: () => void): void;
  on(event: "message", listener: (message: Uint8Array) => void): void;
  send(message: Uint8Array, port: number, host: string): void;
  close(): void;
};

type Stream = {
  on(event: "error" | "connect", listener: () => void): void;
  on(event: "data", listener: (piece: Uint8Array) => void): void;
  setTimeout(after: number, listener: () => void): void;
  write(message: Uint8Array): void;
  destroy(): void;
};

/** A node builtin named at runtime, which keeps bundlers from reaching for it. */
const builtin = async <Module>(name: string): Promise<Module> =>
  (await import(/* @vite-ignore */ name)) as Module;

const onNode = (): boolean =>
  typeof process !== "undefined" && Boolean(process.versions?.node);

let servers: Promise<string[]> | null = null;

/** The servers this machine resolves through, which only a node runtime knows. */
const systemServers = async (): Promise<string[]> => {
  servers ??= (async () => {
    const found: string[] = [];
    try {
      const { getServers } = await builtin<{ getServers: () => string[] }>("node:dns");
      found.push(...getServers());
    } catch {
      /* a runtime without node:dns has the public servers and nothing else */
    }
    const usable = found
      .map((server) => server.split("%")[0].replace(/^\[|]$/g, ""))
      .filter((server) => !/^(fe80|169\.254)/i.test(server));
    return [...new Set([...usable, ...PUBLIC_SERVERS])];
  })();
  return servers;
};

/** The same question again where the datagram came back cut short. */
const overTcp = async (server: string, query: Uint8Array): Promise<Reply | null> => {
  const { connect } = await builtin<{ connect: (port: number, host: string) => Stream }>(
    "node:net",
  );
  return new Promise((settle) => {
    const socket = connect(53, server);
    const pieces: Uint8Array[] = [];
    let size = 0;
    const done = (reply: Reply | null) => {
      socket.destroy();
      settle(reply);
    };
    socket.setTimeout(TIMEOUT, () => done(null));
    socket.on("error", () => done(null));
    socket.on("connect", () => {
      const framed = new Uint8Array(query.length + 2);
      new DataView(framed.buffer).setUint16(0, query.length);
      framed.set(query, 2);
      socket.write(framed);
    });
    socket.on("data", (piece: Uint8Array) => {
      pieces.push(piece);
      size += piece.length;
      if (size < 2) return;
      const held = new Uint8Array(size);
      let at = 0;
      for (const one of pieces) {
        held.set(one, at);
        at += one.length;
      }
      const expected = new DataView(held.buffer).getUint16(0);
      if (size >= expected + 2) done(read(held.slice(2, expected + 2)));
    });
  });
};

/** Every server asked at once over UDP, the first real answer winning. */
const overUdp = async (
  query: Uint8Array,
  carrying: Kind | null,
): Promise<Reply | null> => {
  const { createSocket } = await builtin<{ createSocket: (kind: string) => Datagram }>(
    "node:dgram",
  );
  const reachable = await systemServers();
  return new Promise((settle) => {
    const sockets = reachable.map((server) =>
      createSocket(server.includes(":") ? "udp6" : "udp4"),
    );
    let spare: Reply | null = null;
    let left = sockets.length;
    let settled = false;
    const done = (reply: Reply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.close();
      settle(reply);
    };
    const timer = setTimeout(() => done(spare), TIMEOUT);
    const heard = async (message: Uint8Array, server: string) => {
      left -= 1;
      let reply = read(message);
      if (reply?.truncated) reply = await overTcp(server, query);
      if (reply && (!carrying || records(reply, carrying, "any").length))
        return done(reply);
      spare ??= reply;
      if (!left) done(spare);
    };
    sockets.forEach((socket, index) => {
      const server = reachable[index];
      socket.on("error", () => {
        left -= 1;
        if (!left) done(spare);
      });
      socket.on("message", (message: Uint8Array) => void heard(message, server));
      socket.send(query, 53, server);
    });
    if (!sockets.length) done(null);
  });
};

/** Every resolver asked at once over HTTPS, for runtimes without a datagram. */
const overHttps = async (
  query: Uint8Array,
  carrying: Kind | null,
): Promise<Reply | null> => {
  const asking = RESOLVERS.map(async (resolver) => {
    const response = await fetch(resolver, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: query as BodyInit,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) throw new Error(`${response.status} from ${resolver}`);
    const reply = read(new Uint8Array(await response.arrayBuffer()));
    if (!reply) throw new Error(`nothing from ${resolver}`);
    return reply;
  });
  let spare: Reply | null = null;
  for (const settled of await Promise.allSettled(asking)) {
    if (settled.status !== "fulfilled") continue;
    if (!carrying || records(settled.value, carrying, "any").length) return settled.value;
    spare ??= settled.value;
  }
  return spare;
};

export const ask = async ([name, kind, carrying]: Question): Promise<Reply | null> => {
  const query = encodeQuery(name, kind);
  return onNode() ? overUdp(query, carrying) : overHttps(query, carrying);
};

const zoneOf = (reply: Reply | null, found: Dns): void => {
  const soa = records(reply, "SOA", "any");
  if (!soa.length) return;
  const [primary, contact] = soa[0].data.split(" ");
  const at = contact.indexOf(".");
  found.zone = soa[0].name;
  found.zone_primary = primary;
  found.zone_contact =
    at < 0 ? contact : `${contact.slice(0, at)}@${contact.slice(at + 1)}`;
};

const empty = (asked: string): Dns => ({
  asked,
  hostname: null,
  hostnames: [],
  ipv4: null,
  ipv6: null,
  ipv4_addresses: [],
  ipv6_addresses: [],
  alias: null,
  zone: null,
  zone_primary: null,
  zone_contact: null,
  is_confirmed: false,
  is_signed: false,
});

/** Everything DNS says about the address, in two rounds of questions. */
export const facts = async (value: number | bigint, wide: boolean): Promise<Dns> => {
  const embedded = tunnel(value, wide)[1];
  const [held, narrow] = embedded ? parse(embedded) : [value, wide];
  const [asked, , arpa] = spelled(held, narrow);
  const [reverse, zone] = await Promise.all([
    ask([arpa, "PTR", null]),
    ask([arpa, "SOA", "SOA"]),
  ]);
  const found = empty(asked);
  found.is_signed = Boolean(reverse?.authentic);
  zoneOf(zone, found);

  const hostnames = answers(reverse, "PTR");
  if (!hostnames.length) return found;
  found.hostname = hostnames[0];
  found.hostnames = hostnames;

  const [forwardV4, forwardV6] = await Promise.all([
    ask([hostnames[0], "A", null]),
    ask([hostnames[0], "AAAA", null]),
  ]);
  found.ipv4_addresses = answers(forwardV4, "A");
  found.ipv6_addresses = answers(forwardV6, "AAAA");
  found.ipv4 = found.ipv4_addresses[0] ?? null;
  found.ipv6 = found.ipv6_addresses[0] ?? null;
  const aliases = [...answers(forwardV4, "CNAME"), ...answers(forwardV6, "CNAME")];
  found.alias = aliases[0] ?? null;

  const back = [...found.ipv4_addresses, ...found.ipv6_addresses];
  found.is_confirmed = back.some((one) => BigInt(parse(one)[0]) === BigInt(held));
  return found;
};

const kept = new Map<string, [number, Dns]>();

/** The same address answered from memory for an hour before asking again. */
export const named = async (value: number | bigint, wide: boolean): Promise<Dns> => {
  const key = `${wide ? 6 : 4}:${value}`;
  const held = kept.get(key);
  if (held && held[0] > Date.now()) return held[1];
  const found = await facts(value, wide);
  if (kept.size >= KEPT) kept.clear();
  kept.set(key, [Date.now() + KEPT_FOR, found]);
  return found;
};
