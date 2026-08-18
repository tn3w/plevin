/** The shapes a lookup answers with; one is shared by every read of a row. */

export type Metro = {
  code: number | null;
  label: string | null;
};

export type District = {
  id: number | null;
  code: string | null;
  name: string | null;
};

export type Region = {
  id: number | null;
  code: string | null;
  iso: string | null;
  name: string | null;
  type: string | null;
};

export type City = {
  id: number | null;
  name: string | null;
  ascii: string | null;
  country: string | null;
  population: number | null;
  elevation: number | null;
  postal: string | null;
  postal_partial: string | null;
  timezone: string | null;
  type: string | null;
  capital: string | null;
  region: Region | null;
  district: District | null;
  metro: Metro | null;
};

export type Country = {
  code: string | null;
  name: string | null;
  official: string | null;
  common: string | null;
  iso3: string | null;
  numeric: string | null;
  flag: string | null;
  european_union: boolean;
  driving_side: string | null;
};

export type Time = {
  timezone: string | null;
  abbreviation: string | null;
  local: string | null;
  utc_offset: string | null;
  is_dst: boolean;
  dst_start: string | null;
  dst_end: string | null;
};

export type Place = {
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  confidence: number | null;
  granularity: string | null;
  city: City | null;
  country: Country | null;
  time: Time | null;
};

export type Operator = {
  company: string | null;
  brand: string | null;
  domain: string | null;
  website: string | null;
  category: string | null;
  tier: number | null;
  peering: number | null;
  scope: string | null;
  rir: string | null;
  since: number | null;
  street: string | null;
  state: string | null;
  postal: string | null;
  country: string | null;
  abuse_email: string | null;
  city: City | null;
};

export type Carrier = {
  user_type: string | null;
  user_count: number | null;
  mcc: number | null;
  mnc: number | null;
  is_mobile: boolean;
};

export type Abuse = {
  name: string | null;
  service: string | null;
  evidence: string | null;
  risk: number | null;
  network_risk: number | null;
  last_seen_days: number | null;
  is_anycast: boolean;
  is_satellite: boolean;
  is_hosting_provider: boolean;
  is_proxy: boolean;
  is_public_proxy: boolean;
  is_residential_proxy: boolean;
  is_anonymous_vpn: boolean;
  is_tor_exit_node: boolean;
  is_private_relay: boolean;
  is_anonymous: boolean;
};

export type Network = {
  asn: number | null;
  handle: string | null;
  prefix: number | null;
  cidr: string | null;
  start: string | null;
  end: string | null;
  rir: string | null;
  rpki: string | null;
  roas: number | null;
  operator: Operator | null;
  carrier: Carrier | null;
};

/** One ASN: the network behind it, with no address to give it a span. */
export type System = {
  asn: number | null;
  handle: string | null;
  found: boolean;
  network: Network | null;
  abuse: Abuse | null;
};

/** What the resolvers say about the address, asked for only where a flag says so. */
export type Dns = {
  asked: string | null;
  hostname: string | null;
  hostnames: string[];
  ipv4: string | null;
  ipv6: string | null;
  ipv4_addresses: string[];
  ipv6_addresses: string[];
  alias: string | null;
  zone: string | null;
  zone_primary: string | null;
  zone_contact: string | null;
  is_confirmed: boolean;
  is_signed: boolean;
};

/** One address: what it says on its own, and what the database stores for it. */
export type Result = {
  ip: string;
  version: number;
  number: number | bigint;
  compressed: string;
  expanded: string;
  arpa: string;
  is_global: boolean;
  is_bogon: boolean;
  is_private: boolean;
  is_loopback: boolean;
  is_multicast: boolean;
  is_reserved: boolean;
  is_link_local: boolean;
  is_unique_local: boolean;
  is_documentation: boolean;
  is_shared: boolean;
  is_benchmark: boolean;
  is_ipv4_mapped: boolean;
  is_6to4: boolean;
  is_teredo: boolean;
  tunnel: string | null;
  embedded_ipv4: string | null;
  decimal_ipv4: string | null;
  as_ipv4_mapped: string | null;
  as_6to4: string | null;
  as_nat64: string | null;
  found: boolean;
  place: Place | null;
  network: Network | null;
  abuse: Abuse | null;
  dns: Dns | null;
};
