"""What a country code and a timezone name imply, for readers that installed them."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone, tzinfo
from functools import cache, lru_cache
from itertools import pairwise
from time import time as time_now
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .models import Country, Time

EU_MEMBERS = frozenset(
    "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES"
    " SE".split()
)
LEFT_DRIVING = frozenset(
    "AG AI AU BB BD BM BN BS BT BW CC CK CX CY DM FJ FK GB GD GG GY HK ID IE IM IN JE"
    " JM JP KE KI KN KY LC LK LS MO MS MT MU MV MW MY MZ NA NF NP NR NU NZ PG PK PN SB"
    " SC SG SH SR SZ TC TH TL TO TT TV TZ UG VC VG WS ZA ZM ZW".split()
)

ZONE_CACHE = 2_048
SECOND_CACHE = 1_024
PROBE = timedelta(days=7)
WINDOW = timedelta(days=400)
NO_OFFSET = timedelta()


def flag(code: str) -> str:
    """Regional indicator symbols, which spell any ISO country code as a flag."""
    if len(code) != 2 or not code.isalpha():
        return ""
    return "".join(chr(0x1F1E6 + ord(letter) - ord("A")) for letter in code.upper())


@cache
def _table() -> Any:
    try:
        from pycountry import countries
    except ModuleNotFoundError:
        return None
    return countries


@cache
def country(code: str) -> Country | None:
    """Everything a country code implies, or the code alone without the tables."""
    if not code:
        return None
    known = _table()
    found = None if known is None else known.get(alpha_2=code)
    return Country(
        code=code,
        name=getattr(found, "name", None),
        official=getattr(found, "official_name", None),
        common=getattr(found, "common_name", None),
        iso3=getattr(found, "alpha_3", None),
        numeric=getattr(found, "numeric", None),
        flag=flag(code) or None,
        european_union=code in EU_MEMBERS,
        driving_side="left" if code in LEFT_DRIVING else "right",
    )


@cache
def _zone(name: str) -> ZoneInfo | None:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _offset(moment: datetime) -> timedelta:
    return moment.utcoffset() or NO_OFFSET


def _noon(zone: tzinfo, day: date) -> datetime:
    return datetime.combine(day, time(12), tzinfo=zone)


def _change(low: datetime, high: datetime, before: timedelta) -> datetime:
    """The change between two probes, to the minute tzdata records it on."""
    while high - low > timedelta(seconds=1):
        middle = low + (high - low) / 2
        low, high = (middle, high) if _offset(middle) == before else (low, middle)
    return (high + timedelta(seconds=30)).replace(second=0, microsecond=0)


@lru_cache(maxsize=ZONE_CACHE)
def _changes(name: str, day: date) -> tuple[datetime, ...]:
    """Every offset change within 400 days either side of a day."""
    zone = _zone(name)
    if zone is None:
        return ()
    probe, found = _noon(zone, day) - WINDOW, []
    previous, end = _offset(probe), _noon(zone, day) + WINDOW
    while probe < end:
        following = probe + PROBE
        current = _offset(following)
        if current != previous:
            found.append(_change(probe, following, previous))
        previous, probe = current, following
    return tuple(found)


@lru_cache(maxsize=ZONE_CACHE)
def _daylight(
    name: str, day: date
) -> tuple[timedelta, datetime | None, datetime | None]:
    """The zone's standard offset, then the daylight period around that day."""
    zone = _zone(name)
    if zone is None:
        return NO_OFFSET, None, None
    noon = _noon(zone, day)
    changes = _changes(name, day)
    offsets = [_offset(noon - WINDOW), *(_offset(moment) for moment in changes)]
    standard, daylight = min(offsets), max(offsets)
    if standard == daylight:
        return standard, None, None
    for start, end in pairwise(changes):
        if _offset(start) == daylight and end >= noon:
            return standard, start, end
    return standard, None, None


def _stamp(moment: datetime | None) -> str | None:
    return moment.isoformat(timespec="seconds") if moment else None


def _utc_offset(offset: timedelta) -> str:
    minutes = round(offset.total_seconds() / 60)
    sign = "-" if minutes < 0 else "+"
    return f"{sign}{abs(minutes) // 60:02d}:{abs(minutes) % 60:02d}"


@lru_cache(maxsize=SECOND_CACHE)
def _second(name: str, second: int) -> Time | None:
    """One zone at one second, so every other lookup in it is a dictionary read."""
    return _read(name, datetime.fromtimestamp(second, timezone.utc))


def clock(name: str, moment: datetime | None = None) -> Time | None:
    """One zone read at one moment, defaulting to now."""
    if not name:
        return None
    if moment is None:
        return _second(name, int(time_now()))
    return _read(name, moment)


def _read(name: str, moment: datetime) -> Time | None:
    zone = _zone(name)
    if zone is None:
        return Time(timezone=name)
    local = moment.astimezone(zone)
    standard, start, end = _daylight(name, local.date())
    offset = _offset(local)
    return Time(
        timezone=name,
        abbreviation=local.tzname() or None,
        local=local.isoformat(timespec="seconds"),
        utc_offset=_utc_offset(offset),
        is_dst=offset != standard,
        dst_start=_stamp(start),
        dst_end=_stamp(end),
    )
