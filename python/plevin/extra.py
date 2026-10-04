"""What a country code and a timezone name imply, for readers that installed them."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone, tzinfo
from functools import cache, lru_cache
from importlib import import_module
from itertools import pairwise
from time import time as time_now
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .models import Country, Time

EU_MEMBERS = frozenset(
    "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES"
    " SE AX GF GP MQ RE YT MF".split()
)
LEFT_DRIVING = frozenset(
    "AG AI AU BB BD BM BN BS BT BW CC CK CX CY DM FJ FK GB GD GG GY HK ID IE IM IN JE"
    " JM JP KE KI KN KY LC LK LS MO MS MT MU MV MW MY MZ NA NF NP NR NU NZ PG PK PN SB"
    " SC SG SH SR SZ TC TH TL TO TT TV TZ UG VC VG VI WS ZA ZM ZW".split()
)

CONTINENTS = {
    "AF": "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM"
          " LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD"
          " TG TN TZ UG YT ZA ZM ZW",
    "AN": "AQ BV GS HM TF",
    "AS": "AE AF AM AZ BD BH BN BT CC CN CX GE HK ID IL IN IO IQ IR JO JP KG KH KP KR"
          " KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW"
          " UZ VN YE",
    "EU": "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE"
          " IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM"
          " UA VA XK",
    "NA": "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC"
          " MF MQ MS MX NI PA PM PR SV SX TC TT UM US VC VG VI",
    "OC": "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS",
    "SA": "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
}
USER_ASSIGNED = {"XK": "Kosovo"}
CONTINENT = {code: name for name, held in CONTINENTS.items() for code in held.split()}

ZONE_CACHE = 2_048
SECOND_CACHE = 1_024
PROBE = timedelta(days=7)
WINDOW = timedelta(days=400)
NO_OFFSET = timedelta()


def flag(code: str) -> str:
    if len(code) != 2 or not code.isalpha():
        return ""
    return "".join(chr(0x1F1E6 + ord(letter) - ord("A")) for letter in code.upper())


@cache
def _module(name: str) -> Any:
    try:
        return import_module(name)
    except ModuleNotFoundError:
        return None


def _table() -> Any:
    found = _module("pycountry")
    return None if found is None else found.countries


def _money(code: str) -> tuple[str | None, str | None]:
    numbers = _module("babel.numbers")
    if numbers is None:
        return None, None
    held = numbers.get_territory_currencies(code)
    if not held:
        return None, None
    return held[0], numbers.get_currency_name(held[0], locale="en")


def _spoken(code: str) -> tuple[str, ...]:
    languages = _module("babel.languages")
    if languages is None:
        return ()
    held = languages.get_official_languages(code, de_facto=True)
    return tuple(dict.fromkeys(name.partition("_")[0] for name in held))


def _calling(code: str) -> str | None:
    numbers = _module("phonenumbers")
    prefix = 0 if numbers is None else numbers.country_code_for_region(code)
    return f"+{prefix}" if prefix else None


@cache
def country(code: str) -> Country | None:
    if not code:
        return None
    known = _table()
    found = None if known is None else known.get(alpha_2=code)
    currency, currency_name = _money(code)
    return Country(
        code=code,
        name=getattr(found, "name", None) or USER_ASSIGNED.get(code),
        official=getattr(found, "official_name", None),
        common=getattr(found, "common_name", None),
        iso3=getattr(found, "alpha_3", None),
        numeric=getattr(found, "numeric", None),
        flag=flag(code) or None,
        continent=CONTINENT.get(code),
        currency=currency,
        currency_name=currency_name,
        calling_code=_calling(code),
        languages=_spoken(code),
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
    while high - low > timedelta(seconds=1):
        middle = low + (high - low) / 2
        low, high = (middle, high) if _offset(middle) == before else (low, middle)
    return (high + timedelta(seconds=30)).replace(second=0, microsecond=0)


@lru_cache(maxsize=ZONE_CACHE)
def _changes(name: str, day: date) -> tuple[datetime, ...]:
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
    return _read(name, datetime.fromtimestamp(second, timezone.utc))


def clock(name: str, moment: datetime | None = None) -> Time | None:
    if not name:
        return None
    if moment is None:
        return _second(name, int(time_now()))
    return _read(name, moment)


def _read(name: str, moment: datetime) -> Time | None:
    zone = _zone(name)
    if zone is None:
        return None
    local = moment.astimezone(zone)
    standard, start, end = _daylight(name, local.date())
    offset = _offset(local)
    return Time(
        abbreviation=local.tzname() or None,
        local=local.isoformat(timespec="seconds"),
        utc_offset=_utc_offset(offset),
        is_dst=offset != standard,
        dst_start=_stamp(start),
        dst_end=_stamp(end),
    )
