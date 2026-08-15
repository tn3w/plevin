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
    MAPPED,
    MULTICAST,
    PRIVATE,
    RESERVED,
    SHARED,
    SIXTOFOUR,
    TEREDO,
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
    "Time",
    "address",
    "database",
    "lookup",
    "use",
]

try:
    __version__ = version("plevin")
except PackageNotFoundError:  # pragma: no cover
    __version__ = "0.0.0"

ENVIRONMENT = "PLEVIN_DB"
PACKAGES = ("plevin_db", "plevin_db_place", "plevin_db_network", "plevin_db_country")
MISSING = (
    "no database found: install one of "
    f"{', '.join(name.replace('_', '-') for name in PACKAGES)}, set {ENVIRONMENT},"
    " or pass a path"
)

WIDE = 1 << 128
ANSWERED = 1 << 10

Rows = dict[str, Any]
Ground = tuple[Any, Any, Any, Any, str | None, City | None, Country | None]
Wires = tuple[int | None, str | None, str | None, Any, Operator | None, Carrier | None]
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
    """One model per row object the file hands back, and the file hands back one."""

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
        country=_text(rows.get("country")),
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


def _place(rows: Rows | None) -> tuple[Ground, str] | None:
    """The place without its clock, which is the one part an address does not fix."""
    if rows is None:
        return None
    city = _city(rows.get("city"))
    code = "" if city is None or city.country is None else city.country
    zone = "" if city is None or city.timezone is None else city.timezone
    ground = (rows.get("lat"), rows.get("lon"), rows.get("accuracy"),
              rows.get("confidence"), _text(rows.get("granularity")), city,
              country(code))
    return ground, zone


def _built_operator(rows: Rows, handle: str) -> Operator:
    company = str(rows.get("company", ""))
    website = str(rows.get("website", ""))
    mailbox = str(rows.get("abuse_email", ""))
    return Operator(
        company=_text(company),
        brand=_text(derive.brand(handle, company)),
        domain=_text(derive.domain(website, mailbox)),
        website=_text(website),
        category=_text(rows.get("category")),
        tier=_count(rows.get("tier")),
        peering=_count(rows.get("peering")),
        scope=_text(rows.get("scope")),
        rir=_text(rows.get("rir")),
        since=_count(rows.get("since")),
        street=_text(rows.get("street")),
        state=_text(rows.get("state")),
        postal=_text(rows.get("postal")),
        country=_text(rows.get("country")),
        abuse_email=_text(mailbox),
        city=_city(rows.get("city")),
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


def _abuse(record: Rows | None, system: Rows | None, user_type: str) -> Abuse | None:
    if record is None and system is None:
        return None
    held = record or {}
    named, inferred = derive.service(str(held.get("service", "")), user_type)
    evidence = str(held.get("evidence", "")) or inferred
    return Abuse(
        name=_text(held.get("name")),
        service=_text(named),
        evidence=_text(evidence),
        risk=held.get("risk"),
        network_risk=None if system is None else system.get("risk"),
        last_seen_days=_count(held.get("last_seen_days")),
        is_anycast=bool(held.get("is_anycast")),
        is_satellite=bool(held.get("is_satellite")),
        is_hosting_provider=user_type in derive.SERVERS,
        is_proxy=named in derive.PROXIES,
        is_public_proxy=named == "public_proxy",
        is_residential_proxy=named == "residential_proxy",
        is_anonymous_vpn=named == "anonymous_vpn",
        is_tor_exit_node=named == "tor_exit_node",
        is_private_relay=named == "private_relay",
        is_anonymous=bool(named),
    )


def _network(rows: Rows | None, user_type: str) -> tuple[Wires, int | None] | None:
    """The network without its span, which the address the lookup asked about fixes."""
    if rows is None:
        return None
    handle = str(rows.get("handle", ""))
    wires = (_count(rows.get("asn")), _text(handle), _text(rows.get("rpki")),
             rows.get("roas"), _operator(rows.get("operator"), handle),
             _carrier(rows.get("carrier"), user_type))
    return wires, _count(rows.get("prefix"))


def _user_type(record: Rows | None, system: Rows | None) -> str:
    """The ASN's type sits on the system row; the record carries only an override."""
    held, below = record or {}, system or {}
    return str(held.get("user_type") or below.get("user_type") or "")


def _stored(rows: Rows) -> Stored:
    """Everything a boundary answers that no address of it changes, built once."""
    network = rows.get("network")
    system = None if network is None else network.get("abuse")
    user_type = _user_type(rows.get("abuse"), system)
    return (_place(rows.get("place")), _network(network, user_type),
            _abuse(rows.get("abuse"), system, user_type))


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
        compressed=text,
        expanded=expanded,
        arpa=arpa,
        is_global=marks == 0,
        is_bogon=marks != 0,
        is_private=marks & PRIVATE != 0,
        is_loopback=marks & LOOPBACK != 0,
        is_multicast=marks & MULTICAST != 0,
        is_reserved=marks & RESERVED != 0,
        is_link_local=marks & LINK_LOCAL != 0,
        is_unique_local=marks & UNIQUE_LOCAL != 0,
        is_documentation=marks & DOCUMENTATION != 0,
        is_shared=marks & SHARED != 0,
        is_benchmark=marks & BENCHMARK != 0,
        is_ipv4_mapped=through == MAPPED,
        is_6to4=through == SIXTOFOUR,
        is_teredo=through == TEREDO,
        tunnel=through,
        embedded_ipv4=embedded,
        decimal_ipv4=decimal,
        as_ipv4_mapped=mapped,
        as_6to4=sixtofour,
        as_nat64=nat64,
        found=stored is not None,
        place=None if ground is None else Place(*ground[0], clock(ground[1], moment)),
        network=None if wires is None else _spanned(*wires, value, wide),
        abuse=abuse,
        dns=dns,
    )


def _spanned(wires: Wires, prefix: int | None, value: int, wide: bool) -> Network:
    asn, handle, rpki, roas, operator, carrier = wires
    cidr, start, end = (None, None, None) if prefix is None else span(
        value, wide, prefix)
    return Network(asn, handle, prefix, cidr, start, end, rpki, roas, operator, carrier)


def _found() -> Path:
    """The database a reader that was given no path should open."""
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
