"""The shapes a lookup answers with; one is shared by every read of a row."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class Metro:
    code: int | None = None
    label: str | None = None


@dataclass(slots=True)
class District:
    id: int | None = None
    code: str | None = None
    name: str | None = None


@dataclass(slots=True)
class Region:
    id: int | None = None
    code: str | None = None
    iso: str | None = None
    name: str | None = None
    type: str | None = None


@dataclass(slots=True)
class City:
    id: int | None = None
    name: str | None = None
    ascii: str | None = None
    country: str | None = None
    population: int | None = None
    elevation: int | None = None
    postal: str | None = None
    postal_partial: str | None = None
    timezone: str | None = None
    type: str | None = None
    capital: str | None = None
    region: Region | None = None
    district: District | None = None
    metro: Metro | None = None


@dataclass(slots=True)
class Country:
    code: str | None = None
    name: str | None = None
    official: str | None = None
    common: str | None = None
    iso3: str | None = None
    numeric: str | None = None
    flag: str | None = None
    european_union: bool = False
    driving_side: str | None = None


@dataclass(slots=True)
class Time:
    timezone: str | None = None
    abbreviation: str | None = None
    local: str | None = None
    utc_offset: str | None = None
    is_dst: bool = False
    dst_start: str | None = None
    dst_end: str | None = None


@dataclass(slots=True)
class Place:
    lat: float | None = None
    lon: float | None = None
    accuracy: int | None = None
    confidence: int | None = None
    granularity: str | None = None
    city: City | None = None
    country: Country | None = None
    time: Time | None = None


@dataclass(slots=True)
class Operator:
    company: str | None = None
    brand: str | None = None
    domain: str | None = None
    website: str | None = None
    category: str | None = None
    tier: int | None = None
    peering: int | None = None
    scope: str | None = None
    rir: str | None = None
    since: int | None = None
    street: str | None = None
    state: str | None = None
    postal: str | None = None
    country: str | None = None
    abuse_email: str | None = None
    city: City | None = None


@dataclass(slots=True)
class Carrier:
    user_type: str | None = None
    user_count: int | None = None
    mcc: int | None = None
    mnc: int | None = None
    is_mobile: bool = False


@dataclass(slots=True)
class Abuse:
    name: str | None = None
    service: str | None = None
    evidence: str | None = None
    risk: float | None = None
    network_risk: float | None = None
    last_seen_days: int | None = None
    is_anycast: bool = False
    is_satellite: bool = False
    is_hosting_provider: bool = False
    is_proxy: bool = False
    is_public_proxy: bool = False
    is_residential_proxy: bool = False
    is_anonymous_vpn: bool = False
    is_tor_exit_node: bool = False
    is_private_relay: bool = False
    is_anonymous: bool = False


@dataclass(slots=True)
class Network:
    asn: int | None = None
    handle: str | None = None
    prefix: int | None = None
    cidr: str | None = None
    start: str | None = None
    end: str | None = None
    rir: str | None = None
    rpki: str | None = None
    roas: int | None = None
    operator: Operator | None = None
    carrier: Carrier | None = None


@dataclass(slots=True)
class Dns:
    """What the resolvers say about the address, asked for only where a flag says so."""

    asked: str | None = None
    hostname: str | None = None
    hostnames: tuple[str, ...] = ()
    ipv4: str | None = None
    ipv6: str | None = None
    ipv4_addresses: tuple[str, ...] = ()
    ipv6_addresses: tuple[str, ...] = ()
    alias: str | None = None
    zone: str | None = None
    zone_primary: str | None = None
    zone_contact: str | None = None
    is_confirmed: bool = False
    is_signed: bool = False


@dataclass(slots=True)
class Result:
    """One address: what it says on its own, and what the database stores for it."""

    ip: str
    version: int
    number: int
    compressed: str
    expanded: str
    arpa: str
    is_global: bool = False
    is_bogon: bool = False
    is_private: bool = False
    is_loopback: bool = False
    is_multicast: bool = False
    is_reserved: bool = False
    is_link_local: bool = False
    is_unique_local: bool = False
    is_documentation: bool = False
    is_shared: bool = False
    is_benchmark: bool = False
    is_ipv4_mapped: bool = False
    is_6to4: bool = False
    is_teredo: bool = False
    tunnel: str | None = None
    embedded_ipv4: str | None = None
    decimal_ipv4: str | None = None
    as_ipv4_mapped: str | None = None
    as_6to4: str | None = None
    as_nat64: str | None = None
    found: bool = False
    place: Place | None = None
    network: Network | None = None
    abuse: Abuse | None = None
    dns: Dns | None = None

    def __bool__(self) -> bool:
        return self.found
