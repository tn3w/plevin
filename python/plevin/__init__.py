"""Location, network and abuse information for any IP address in one offline file."""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from os import PathLike
from pathlib import Path
from time import time as now
from typing import Any

from . import address, derive, naming
from .address import (
    BENCHMARK,
    DOCUMENTATION,
    LINK_LOCAL,
    LOOPBACK,
    MULTICAST,
    PRIVATE,
    RESERVED,
    SHARED,
    UNIQUE_LOCAL,
    Value,
    carried,
    guessed,
    parse,
    purpose,
    span,
    spelled,
    tunnel,
)
from .extra import clock, country
from .models import (
    Abuse,
    Carrier,
    City,
    Country,
    District,
    Dns,
    Metro,
    Network,
    Operator,
    Place,
    Region,
    Result,
    Routes,
    Span,
    System,
    Time,
)
from .reader import CACHED, Cache, File, Found

__all__ = [
    "Abuse",
    "Carrier",
    "City",
    "Country",
    "District",
    "Dns",
    "Metro",
    "Network",
    "Operator",
    "Place",
    "Plevin",
    "Region",
    "Result",
    "Routes",
    "Span",
    "System",
    "Time",
    "address",
    "database",
    "lookup",
    "routes",
    "search",
    "system",
    "use",
]

try:
    __version__ = version("plevin")
except PackageNotFoundError:  # pragma: no cover
    __version__ = "0.0.0"

ENVIRONMENT = "PLEVIN_DB"
PACKAGES = ("plevin_db", "plevin_db_place", "plevin_db_network", "plevin_db_abuse",
            "plevin_db_country")
MISSING = (
    "no database found: install one of "
    f"{', '.join(name.replace('_', '-') for name in PACKAGES)}, set {ENVIRONMENT},"
    " or pass a path"
)

WIDE = 1 << 128
ANSWERED = 1 << 10

Rows = dict[str, Any]
Ground = tuple[Any, Any, Any, Any, str | None, City | None, Country | None]
Wires = tuple[int | None, str | None, str | None, str | None, int | None, str | None,
              int | None, Operator | None, Carrier | None]
Stored = tuple[tuple[Ground, str] | None, tuple[Wires, int | None] | None,
               Abuse | None]


def _text(value: Any) -> str | None:
    return str(value) if value else None


def _count(value: Any) -> int | None:
    return int(value) if value else None


def _metro(rows: Rows | None) -> Metro | None:
    if rows is None:
        return None
    return Metro(code=_count(rows.get("code")), label=_text(rows.get("label")))


def _district(rows: Rows | None) -> District | None:
    if rows is None:
        return None
    return District(id=_count(rows.get("id")), code=_text(rows.get("code")),
                    name=_text(rows.get("name")))


def _region(rows: Rows | None) -> Region | None:
    if rows is None:
        return None
    return Region(id=_count(rows.get("id")), code=_text(rows.get("code")),
                  iso=_text(rows.get("iso")), name=_text(rows.get("name")),
                  type=_text(rows.get("type")))


class Shaped:
    def __init__(self, build: Callable[..., Any]) -> None:
        self.build = build
        self.held: dict[Any, tuple[Rows, Any]] = {}

    def __call__(self, rows: Rows | None, *rest: Any) -> Any:
        if rows is None:
            return None
        key = (id(rows), rest)
        found = self.held.get(key)
        if found is not None and found[0] is rows:
            return found[1]
        if len(self.held) >= CACHED:
            self.held.clear()
        model = self.held[key] = (rows, self.build(rows, *rest))
        return model[1]


def _built_city(rows: Rows) -> City:
    kind = str(rows.get("type", ""))
    return City(
        id=_count(rows.get("id")),
        name=_text(rows.get("name")),
        ascii=_text(rows.get("ascii")),
        population=_count(rows.get("population")),
        elevation=_count(rows.get("elevation")),
        postal=_text(rows.get("postal")),
        postal_partial=_text(rows.get("postal_partial")),
        timezone=_text(rows.get("timezone")),
        type=_text(kind),
        capital=_text(derive.capital(kind)),
        region=_region(rows.get("region")),
        district=_district(rows.get("district")),
        metro=_metro(rows.get("metro")),
    )


_city = Shaped(_built_city)


def _built_headquarters(rows: Rows) -> City:
    """An operator's city, which carries only its id and name."""
    return City(id=_count(rows.get("id")), name=_text(rows.get("name")))


_headquarters = Shaped(_built_headquarters)


def _built_coarse(rows: Rows, granularity: str) -> City:
    town = _city(rows)
    region = town.region if granularity == "region" else None
    return City(timezone=town.timezone, region=region)


_coarse = Shaped(_built_coarse)


def _place(rows: Rows | None) -> tuple[Ground, str] | None:
    if rows is None:
        return None
    granularity = str(rows.get("granularity", ""))
    held = rows.get("city")
    city = _city(held) if granularity in ("city", "") else _coarse(held, granularity)
    code = str((held or {}).get("country") or "")
    zone = "" if city is None or city.timezone is None else city.timezone
    ground = (rows.get("lat"), rows.get("lon"), rows.get("accuracy"),
              rows.get("confidence"), _text(granularity), city, country(code))
    return ground, zone


def _built_operator(rows: Rows, handle: str, brand: str) -> Operator:
    company = str(rows.get("company", ""))
    website = str(rows.get("website", ""))
    mailbox = str(rows.get("abuse_email", ""))
    named = brand or derive.brand(handle, company)
    return Operator(
        company=_text(company),
        brand=_text(named),
        domain=_text(derive.domain(website, mailbox, f"{named} {handle} {company}")),
        website=_text(derive.website(website)),
        category=_text(rows.get("category")),
        tier=_count(rows.get("tier")),
        peering=_count(rows.get("peering")),
        cone=_count(rows.get("cone")),
        scope=_text(rows.get("scope")),
        rir=_text(rows.get("rir")),
        since=_count(rows.get("since")),
        street=_text(rows.get("street")),
        state=_text(rows.get("state")),
        postal=_text(rows.get("postal")),
        country=_text(rows.get("country")),
        abuse_email=_text(mailbox),
        city=_headquarters(rows.get("city")),
    )


_operator = Shaped(_built_operator)


def _carrier(rows: Rows | None, user_type: str) -> Carrier | None:
    if rows is None and not user_type:
        return None
    held = rows or {}
    return Carrier(
        user_type=_text(user_type),
        user_count=_count(held.get("user_count")),
        mcc=_count(held.get("mcc")),
        mnc=_count(held.get("mnc")),
        is_mobile=user_type == "cellular",
    )


def _abuse(record: Rows | None, system: Rows | None, user_type: str,
           brand: str) -> Abuse | None:
    if record is None and system is None and not user_type:
        return None
    held = record or {}
    named, inferred = derive.service(str(held.get("service", "")), user_type)
    evidence = str(held.get("evidence", "")) or inferred
    name = str(held.get("name", ""))
    level = str(held.get("level", ""))
    return Abuse(
        provider=_text(name or (brand if named else "")),
        service=_text(named),
        evidence=_text(evidence),
        threat=_text(str(held.get("threat", ""))),
        level=_text(level),
        risk=held.get("risk"),
        network_risk=None if system is None else system.get("risk"),
        last_seen_days=_count(held.get("last_seen_days")),
        is_malicious=bool(level),
        is_anycast=bool(held.get("is_anycast")),
        is_satellite=bool(held.get("is_satellite")),
        is_crawler=user_type == derive.CRAWLER,
        is_hosting_provider=user_type in derive.SERVERS,
        is_proxy=named in derive.PROXIES,
        is_public_proxy=named == "public_proxy",
        is_residential_proxy=named == "residential_proxy",
        is_anonymous_vpn=named == "anonymous_vpn",
        is_tor_exit_node=named == "tor_exit_node",
        is_private_relay=named == "private_relay",
        is_anonymous=bool(named),
    )


def _holder(rows: Rows, handle: str, brand: str) -> Operator | None:
    held = rows.get("operator")
    if held is None:
        return None if not brand else Operator(brand=_text(brand))
    found: Operator = _operator(held, handle, brand)
    return found


def _network(rows: Rows, user_type: str) -> tuple[Wires, int | None]:
    handle = str(rows.get("handle", ""))
    wires = (_count(rows.get("asn")), _text(handle), _text(rows.get("rir")),
             _text(rows.get("country")), _count(rows.get("since")),
             _text(rows.get("rpki")), _count(rows.get("roas")),
             _holder(rows, handle, str(rows.get("brand", ""))),
             _carrier(rows.get("carrier"), user_type))
    return wires, _count(rows.get("prefix"))


def _user_type(record: Rows | None, network: Rows | None) -> str:
    """The address's own type, else the type of its operator."""
    held, whole = record or {}, (network or {}).get("operator") or {}
    return str(held.get("user_type") or whole.get("category") or "")


def _stored(rows: Rows) -> Stored:
    network = rows.get("network")
    if network is not None and not any(network.values()):
        network = None
    system = None if network is None else network.get("abuse")
    user_type = _user_type(rows.get("abuse"), network)
    wires = None if network is None else _network(network, user_type)
    holder = None if wires is None else wires[0][-2]
    brand = "" if holder is None or holder.brand is None else holder.brand
    return (_place(rows.get("place")), wires,
            _abuse(rows.get("abuse"), system, user_type, brand))


def _result(value: int, wide: bool, stored: Stored | None,
            moment: datetime | None, dns: Dns | None = None) -> Result:
    text, expanded, arpa = spelled(value, wide)
    marks = purpose(value, wide)
    through, embedded = tunnel(value, wide)
    mapped, sixtofour, nat64 = carried(value, wide)
    decimal = guessed(value, wide)
    ground, wires, abuse = stored or (None, None, None)
    return Result(
        ip=text,
        version=6 if wide else 4,
        number=value,
        expanded=expanded if wide else None,
        arpa=arpa,
        is_global=marks == 0,
        is_private=marks & PRIVATE != 0,
        is_loopback=marks & LOOPBACK != 0,
        is_multicast=marks & MULTICAST != 0,
        is_reserved=marks & RESERVED != 0,
        is_link_local=marks & LINK_LOCAL != 0,
        is_unique_local=marks & UNIQUE_LOCAL != 0,
        is_documentation=marks & DOCUMENTATION != 0,
        is_shared=marks & SHARED != 0,
        is_benchmark=marks & BENCHMARK != 0,
        tunnel=through,
        embedded_ipv4=embedded,
        decimal_ipv4=decimal,
        as_ipv4_mapped=mapped,
        as_6to4=sixtofour,
        as_nat64=nat64,
        found=bool(ground or wires or abuse),
        place=None if ground is None else Place(*ground[0], clock(ground[1], moment)),
        network=None if wires is None else _spanned(*wires, value, wide),
        abuse=abuse,
        dns=dns,
    )


def _system(rows: Rows) -> System:
    record = rows.get("abuse")
    user_type = _user_type(None, rows)
    asn, handle, *_, operator, carrier = _network(rows, user_type)[0]
    brand = "" if operator is None or operator.brand is None else operator.brand
    return System(
        asn=asn,
        handle=handle,
        found=True,
        network=Network(asn=asn, handle=handle, operator=operator, carrier=carrier),
        abuse=_abuse(None, record, user_type, brand),
    )


def _covered(held: list[tuple[int, int]], bits: int) -> int:
    total = reach = 0
    for start, prefix in sorted(held):
        end = start + (1 << (bits - prefix))
        if end <= reach:
            continue
        total += end - max(start, reach)
        reach = end
    return total


def _routed(file: File, row: int, version: int) -> tuple[tuple[Span, ...], int]:
    wide = version == 6
    bits = 128 if wide else 32
    held = file.spans(row, version)
    widest = sorted(held, key=lambda one: (one[1], one[0]))
    spans = tuple(Span(*span(start, wide, prefix), version, prefix, 1 << (bits - prefix))
                  for start, prefix in widest)
    return spans, _covered(held, bits)


def _asn(value: int | str) -> int:
    text = str(value).strip().lower().removeprefix("as")
    return int(text) if text.isdigit() else 0


def _spanned(wires: Wires, prefix: int | None, value: int, wide: bool) -> Network:
    asn, handle, rir, registered, since, rpki, roas, operator, carrier = wires
    cidr, start, end = (None, None, None) if prefix is None else span(
        value, wide, prefix)
    return Network(asn, handle, prefix, cidr, start, end, rir, registered, since, rpki,
                   roas, operator, carrier)


def _found() -> Path:
    named = os.environ.get(ENVIRONMENT)
    if named:
        return Path(named)
    for package in PACKAGES:
        try:
            module = import_module(package)
        except ModuleNotFoundError:
            continue
        return Path(module.PATH)
    raise LookupError(MISSING)


class Plevin:
    """One database, opened once and asked as often as a log has addresses."""

    def __init__(self, path: str | PathLike[str] | None = None) -> None:
        self.file = File(_found() if path is None else path)
        self.stored = Cache(self._stored)
        self.results = Cache(self._result, ANSWERED)
        self.announced = Cache(self._routes)
        self.second = 0

    @property
    def path(self) -> str:
        return self.file.path

    @property
    def built(self) -> str:
        return self.file.built

    @property
    def selection(self) -> str:
        return self.file.selection

    @property
    def fields(self) -> list[str]:
        return self.file.fields

    def _stored(self, found: Found) -> Stored:
        return _stored(self.file.answers[found])

    def _result(self, key: int) -> Result:
        wide = key >= WIDE
        value = key - WIDE if wide else key
        found = self.file.locate(value, wide)
        return _result(value, wide, None if found is None else self.stored[found], None)

    def lookup(self, value: Value, moment: datetime | None = None,
               dns: bool = False) -> Result:
        """One address as everything the file answers, and DNS only where asked."""
        number, wide = parse(value)
        if moment is not None or dns:
            found = self.file.locate(number, wide)
            held = None if found is None else self.stored[found]
            names = naming.named(number, wide) if dns else None
            return _result(number, wide, held, moment, names)
        second = int(now())
        if second != self.second:
            self.second = second
            self.results.clear()
        answer: Result = self.results[number + WIDE if wide else number]
        return answer

    def system(self, asn: int | str) -> System:
        """One ASN as everything the file stores about the network behind it."""
        number = _asn(asn)
        rows = self.file.system(number)
        return System(asn=number or None) if rows is None else _system(rows)

    def _routes(self, asn: int) -> Routes:
        row = self.file.system_row(asn)
        if row < 0:
            return Routes(asn=asn or None)
        ipv4, four = _routed(self.file, row, 4)
        ipv6, six = _routed(self.file, row, 6)
        return Routes(asn, True, ipv4, ipv6, four, six)

    def routes(self, asn: int | str) -> Routes:
        """Every prefix one ASN is announced as, widest first, and the space covered."""
        found: Routes = self.announced[_asn(asn)]
        return found

    def search(self, text: str, limit: int = 20) -> list[System]:
        """The networks whose handle or company carries this text, best match first."""
        found = self.system(text)
        if found.found:
            return [found]
        return [_system(rows) for rows in self.file.find(text, limit)]


_opened: Plevin | None = None


def database() -> Plevin:
    """The database the module reads, opened on the first address asked of it."""
    global _opened
    if _opened is None:
        _opened = Plevin()
    return _opened


def use(path: str | PathLike[str] | None) -> Plevin:
    """Read a database of your own from here on, or forget the one in use."""
    global _opened
    _opened = None if path is None else Plevin(path)
    return database()


def lookup(value: Value, moment: datetime | None = None,
           dns: bool = False) -> Result:
    """One address as everything the file answers, and DNS only where asked."""
    return database().lookup(value, moment, dns)


def system(asn: int | str) -> System:
    """One ASN as everything the file stores about the network behind it."""
    return database().system(asn)


def routes(asn: int | str) -> Routes:
    """Every prefix one ASN is announced as, widest first, and the space covered."""
    return database().routes(asn)


def search(text: str, limit: int = 20) -> list[System]:
    """The networks whose handle or company carries this text, best match first."""
    return database().search(text, limit)
