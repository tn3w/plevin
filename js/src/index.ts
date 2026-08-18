/** Location, network and abuse information for any IP address in one offline file. */

import {
  BENCHMARK,
  carried,
  DOCUMENTATION,
  guessed,
  LINK_LOCAL,
  LOOPBACK,
  MAPPED,
  MULTICAST,
  PRIVATE,
  parse,
  purpose,
  RESERVED,
  SHARED,
  SIXTOFOUR,
  span,
  spelled,
  TEREDO,
  tunnel,
  UNIQUE_LOCAL,
  type Value,
} from "./address.ts";
import * as derive from "./derive.ts";
import { clock, country } from "./extra.ts";
import type {
  Abuse,
  Carrier,
  City,
  District,
  Dns,
  Metro,
  Network,
  Operator,
  Place,
  Region,
  Result,
  System,
} from "./models.ts";
import { named } from "./naming.ts";
import { File, type Found, type Row } from "./reader.ts";

export type { Value } from "./address.ts";
export * from "./models.ts";
export { ask, facts, named, records } from "./naming.ts";
export { File } from "./reader.ts";
export { decompress, loadDictionary } from "./zstd.ts";

const ANSWERED = 1 << 10;
const WIDE = 1n << 128n;

const text = (value: unknown): string | null => (value ? String(value) : null);

const count = (value: unknown): number | null => (value ? Number(value) : null);

const number = (value: unknown): number | null =>
  value === undefined || value === null ? null : Number(value);

const held = (row: Row | undefined, field: string): Row | undefined =>
  row?.[field] as Row | undefined;

const metro = (row: Row | undefined): Metro | null =>
  row ? { code: count(row.code), label: text(row.label) } : null;

const district = (row: Row | undefined): District | null =>
  row ? { id: count(row.id), code: text(row.code), name: text(row.name) } : null;

const region = (row: Row | undefined): Region | null =>
  row
    ? {
        id: count(row.id),
        code: text(row.code),
        iso: text(row.iso),
        name: text(row.name),
        type: text(row.type),
      }
    : null;

/** One model per row object the file hands back, and the file hands back one. */
const shaped = <Built>(build: (row: Row, ...rest: string[]) => Built) => {
  const kept = new WeakMap<Row, Map<string, Built>>();
  return (row: Row | undefined, ...rest: string[]): Built | null => {
    if (!row) return null;
    const key = rest.join("\n");
    let held = kept.get(row);
    if (!held) {
      held = new Map();
      kept.set(row, held);
    }
    const found = held.get(key);
    if (found !== undefined) return found;
    const built = build(row, ...rest);
    held.set(key, built);
    return built;
  };
};

const city = shaped((row: Row): City => {
  const kind = String(row.type ?? "");
  return {
    id: count(row.id),
    name: text(row.name),
    ascii: text(row.ascii),
    country: text(row.country),
    population: count(row.population),
    elevation: count(row.elevation),
    postal: text(row.postal),
    postal_partial: text(row.postal_partial),
    timezone: text(row.timezone),
    type: text(kind),
    capital: text(derive.capital(kind)),
    region: region(held(row, "region")),
    district: district(held(row, "district")),
    metro: metro(held(row, "metro")),
  };
});

const operator = shaped((row: Row, handle: string): Operator => {
  const company = String(row.company ?? "");
  const website = String(row.website ?? "");
  const mailbox = String(row.abuse_email ?? "");
  return {
    company: text(company),
    brand: text(derive.brand(handle, company)),
    domain: text(derive.domain(website, mailbox)),
    website: text(website),
    category: text(row.category),
    tier: count(row.tier),
    peering: count(row.peering),
    scope: text(row.scope),
    rir: text(row.rir),
    since: count(row.since),
    street: text(row.street),
    state: text(row.state),
    postal: text(row.postal),
    country: text(row.country),
    abuse_email: text(mailbox),
    city: city(held(row, "city")),
  };
});

const carrier = (row: Row | undefined, userType: string): Carrier | null => {
  if (!row && !userType) return null;
  const found = row ?? {};
  return {
    user_type: text(userType),
    user_count: count(found.user_count),
    mcc: count(found.mcc),
    mnc: count(found.mnc),
    is_mobile: userType === "cellular",
  };
};

const abuseOf = (
  record: Row | undefined,
  system: Row | undefined,
  userType: string,
): Abuse | null => {
  if (!record && !system) return null;
  const found = record ?? {};
  const [named, inferred] = derive.service(String(found.service ?? ""), userType);
  return {
    name: text(found.name),
    service: text(named),
    evidence: text(String(found.evidence ?? "") || inferred),
    risk: number(found.risk),
    network_risk: system ? number(system.risk) : null,
    last_seen_days: count(found.last_seen_days),
    is_anycast: Boolean(found.is_anycast),
    is_satellite: Boolean(found.is_satellite),
    is_hosting_provider: derive.SERVERS.has(userType),
    is_proxy: derive.PROXIES.has(named),
    is_public_proxy: named === "public_proxy",
    is_residential_proxy: named === "residential_proxy",
    is_anonymous_vpn: named === "anonymous_vpn",
    is_tor_exit_node: named === "tor_exit_node",
    is_private_relay: named === "private_relay",
    is_anonymous: Boolean(named),
  };
};

type Ground = [Omit<Place, "time">, string];
type Wires = [Omit<Network, "prefix" | "cidr" | "start" | "end">, number | null];
type Stored = [Ground | null, Wires | null, Abuse | null];

/** The place without its clock, which is the one part an address does not fix. */
const place = (row: Row | undefined): Ground | null => {
  if (!row) return null;
  const found = city(held(row, "city"));
  const code = found?.country ?? "";
  const zone = found?.timezone ?? "";
  return [
    {
      lat: number(row.lat),
      lon: number(row.lon),
      accuracy: count(row.accuracy),
      confidence: count(row.confidence),
      granularity: text(row.granularity),
      city: found,
      country: country(code),
    },
    zone,
  ];
};

/** The network without its span, which the address the lookup asked about fixes. */
const network = (row: Row, userType: string): Wires => {
  const handle = String(row.handle ?? "");
  return [
    {
      asn: count(row.asn),
      handle: text(handle),
      rir: text(row.rir),
      rpki: text(row.rpki),
      roas: number(row.roas),
      operator: operator(held(row, "operator"), handle),
      carrier: carrier(held(row, "carrier"), userType),
    },
    count(row.prefix),
  ];
};

/** The ASN's type sits on the system row; the record carries only an override. */
const userTypeOf = (record: Row | undefined, system: Row | undefined): string =>
  String(record?.user_type || system?.user_type || "");

/** Everything a boundary answers that no address of it changes, built once. */
const stored = (row: Row): Stored => {
  const wires = held(row, "network");
  const system = held(wires, "abuse");
  const userType = userTypeOf(held(row, "abuse"), system);
  return [
    place(held(row, "place")),
    wires ? network(wires, userType) : null,
    abuseOf(held(row, "abuse"), system, userType),
  ];
};

/** One ASN alone: the row the file stores, without what only an address adds. */
const systemOf = (row: Row): System => {
  const record = held(row, "abuse");
  const userType = userTypeOf(undefined, record);
  const { asn, handle, operator, carrier } = network(row, userType)[0];
  return {
    asn,
    handle,
    found: true,
    network: {
      asn,
      handle,
      prefix: null,
      cidr: null,
      start: null,
      end: null,
      rir: null,
      rpki: null,
      roas: null,
      operator,
      carrier,
    },
    abuse: abuseOf(undefined, record, userType),
  };
};

/** An ASN however it is written, as AS15169, as15169 or plainly 15169. */
const asnOf = (value: number | string): number => {
  const held = String(value).trim().toLowerCase().replace(/^as/, "");
  return /^\d+$/.test(held) ? Number(held) : 0;
};

const spanned = (wires: Wires, value: number | bigint, wide: boolean): Network => {
  const [held, prefix] = wires;
  const [cidr, start, end] =
    prefix === null ? [null, null, null] : span(value, wide, prefix);
  return { ...held, prefix, cidr, start, end };
};

const result = (
  value: number | bigint,
  wide: boolean,
  found: Stored | null,
  moment?: Date | null,
  dns: Dns | null = null,
): Result => {
  const [compressed, expanded, arpa] = spelled(value, wide);
  const marks = purpose(value, wide);
  const [through, embedded] = tunnel(value, wide);
  const [mapped, sixtofour, nat64] = carried(value, wide);
  const decimal = guessed(value, wide);
  const [ground, wires, abuse] = found ?? [null, null, null];
  return {
    ip: compressed,
    version: wide ? 6 : 4,
    number: value,
    compressed,
    expanded,
    arpa,
    is_global: marks === 0,
    is_bogon: marks !== 0,
    is_private: (marks & PRIVATE) !== 0,
    is_loopback: (marks & LOOPBACK) !== 0,
    is_multicast: (marks & MULTICAST) !== 0,
    is_reserved: (marks & RESERVED) !== 0,
    is_link_local: (marks & LINK_LOCAL) !== 0,
    is_unique_local: (marks & UNIQUE_LOCAL) !== 0,
    is_documentation: (marks & DOCUMENTATION) !== 0,
    is_shared: (marks & SHARED) !== 0,
    is_benchmark: (marks & BENCHMARK) !== 0,
    is_ipv4_mapped: through === MAPPED,
    is_6to4: through === SIXTOFOUR,
    is_teredo: through === TEREDO,
    tunnel: through,
    embedded_ipv4: embedded,
    decimal_ipv4: decimal,
    as_ipv4_mapped: mapped,
    as_6to4: sixtofour,
    as_nat64: nat64,
    found: found !== null,
    place: ground === null ? null : { ...ground[0], time: clock(ground[1], moment) },
    network: wires === null ? null : spanned(wires, value, wide),
    abuse,
    dns,
  };
};

/** What a lookup should do beyond the file, none of it done unless it is asked for. */
export type Asked = { dns?: boolean; moment?: Date | null };

/** One database, opened once and asked as often as a log has addresses. */
export class Plevin {
  readonly file: File;
  private readonly kept = new Map<string, Stored>();
  private readonly results = new Map<bigint, Result>();
  private second = 0;

  constructor(bytes: Uint8Array) {
    this.file = new File(bytes);
  }

  get built(): string {
    return this.file.built;
  }

  get selection(): string {
    return this.file.selection;
  }

  get fields(): string[] {
    return this.file.fields;
  }

  private storedFor(found: Found): Stored {
    const key = found.join(",");
    const held = this.kept.get(key);
    if (held !== undefined) return held;
    if (this.kept.size >= ANSWERED * 16) this.kept.clear();
    const built = stored(this.file.answerFor(found));
    this.kept.set(key, built);
    return built;
  }

  /** One address, however it is written, as everything the file answers. */
  lookup(value: Value, moment?: Date | null): Result {
    const [held, wide] = parse(value);
    if (moment) {
      const found = this.file.locate(held, wide);
      return result(held, wide, found && this.storedFor(found), moment);
    }
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.second) {
      this.second = second;
      this.results.clear();
    }
    const key = wide ? (held as bigint) + WIDE : BigInt(held as number);
    const answered = this.results.get(key);
    if (answered !== undefined) return answered;
    if (this.results.size >= ANSWERED) this.results.clear();
    const found = this.file.locate(held, wide);
    const built = result(held, wide, found && this.storedFor(found));
    this.results.set(key, built);
    return built;
  }

  /** The same lookup with what DNS says about the address, where the flag says so. */
  async resolve(value: Value, options?: Asked): Promise<Result> {
    const answered = this.lookup(value, options?.moment);
    if (!options?.dns) return answered;
    const [held, wide] = parse(value);
    return { ...answered, dns: await named(held, wide) };
  }

  /** One ASN as everything the file stores about the network behind it. */
  system(asn: number | string): System {
    const number = asnOf(asn);
    const row = this.file.system(number);
    if (row) return systemOf(row);
    return {
      asn: number || null,
      handle: null,
      found: false,
      network: null,
      abuse: null,
    };
  }

  /** The networks whose handle or company carries this text, best match first. */
  search(text: string, limit = 20): System[] {
    const found = this.system(text);
    if (found.found) return [found];
    return this.file.find(text, limit).map(systemOf);
  }

  /** The stored rows without any shaping, or null where the file covers nothing. */
  row(value: Value): Row | null {
    const [held, wide] = parse(value);
    return this.file.rowFor(held, wide);
  }
}

/** A database read over the network, in a browser, a worker or on a server. */
export const open = async (
  source: string | URL | Request | Response | ArrayBuffer | Uint8Array,
): Promise<Plevin> => {
  if (source instanceof Uint8Array) return new Plevin(source);
  if (source instanceof ArrayBuffer) return new Plevin(new Uint8Array(source));
  const response = source instanceof Response ? source : await fetch(source);
  if (!response.ok) throw new Error(`${response.status} reading the database`);
  return new Plevin(new Uint8Array(await response.arrayBuffer()));
};
