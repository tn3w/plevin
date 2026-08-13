"""What a country code and a timezone name imply."""

from __future__ import annotations

import builtins
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from plevin import extra


@pytest.fixture(autouse=True)
def _fresh() -> None:
    extra._table.cache_clear()
    extra.country.cache_clear()


@pytest.mark.parametrize(
    ("code", "emoji"), [("US", "🇺🇸"), ("de", "🇩🇪"), ("USA", ""), ("1", "")]
)
def test_a_country_code_spells_itself_as_a_flag(code: str, emoji: str) -> None:
    assert extra.flag(code) == emoji


def test_a_known_code_carries_everything_the_tables_name() -> None:
    found = extra.country("US")
    assert found is not None
    assert (found.name, found.iso3, found.numeric) == ("United States", "USA", "840")
    assert found.official == "United States of America"
    assert found.flag == "🇺🇸"
    assert found.driving_side == "right"
    assert not found.european_union


def test_a_member_state_drives_on_the_side_its_neighbours_do() -> None:
    found = extra.country("IE")
    assert found is not None
    assert found.european_union
    assert found.driving_side == "left"


def test_a_code_no_table_names_keeps_the_code() -> None:
    found = extra.country("ZZ")
    assert found is not None
    assert (found.code, found.name, found.iso3) == ("ZZ", None, None)


def test_no_code_is_no_country() -> None:
    assert extra.country("") is None


def test_the_tables_are_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    real: Callable[..., Any] = builtins.__import__

    def refuse(name: str, *rest: Any) -> Any:
        if name == "pycountry":
            raise ModuleNotFoundError(name)
        return real(name, *rest)

    monkeypatch.setattr(builtins, "__import__", refuse)
    assert extra._table() is None
    found = extra.country("US")
    assert found is not None
    assert (found.code, found.name, found.flag) == ("US", None, "🇺🇸")


def test_a_zone_the_system_does_not_know_keeps_its_name() -> None:
    read = extra.clock("Nowhere/Nothing")
    assert read is not None
    assert read.timezone == "Nowhere/Nothing"
    assert read.local is None


def test_no_zone_is_no_clock() -> None:
    assert extra.clock("") is None


def test_a_zone_on_daylight_time_says_when_it_started_and_ends() -> None:
    noon = datetime(2026, 8, 13, 12, tzinfo=timezone.utc)
    read = extra.clock("America/Los_Angeles", noon)
    assert read is not None
    assert read.is_dst
    assert read.abbreviation == "PDT"
    assert read.utc_offset == "-07:00"
    assert read.local == "2026-08-13T05:00:00-07:00"
    assert read.dst_start == "2026-03-08T03:00:00-07:00"
    assert read.dst_end == "2026-11-01T02:00:00-08:00"


def test_a_zone_in_winter_is_on_standard_time() -> None:
    noon = datetime(2026, 1, 13, 12, tzinfo=timezone.utc)
    read = extra.clock("America/Los_Angeles", noon)
    assert read is not None
    assert not read.is_dst
    assert read.utc_offset == "-08:00"


def test_a_zone_that_never_moves_names_no_daylight_period() -> None:
    read = extra.clock("UTC", datetime(2026, 8, 13, 12, tzinfo=timezone.utc))
    assert read is not None
    assert (read.utc_offset, read.is_dst) == ("+00:00", False)
    assert read.dst_start is None and read.dst_end is None


def test_a_zone_that_gave_daylight_up_reports_none_after_it() -> None:
    standard, start, end = extra._daylight("Asia/Tehran", date(2023, 1, 1))
    assert standard == timedelta(seconds=12600)
    assert (start, end) == (None, None)
    assert extra._changes("Asia/Tehran", date(2023, 1, 1))


def test_the_clock_defaults_to_now() -> None:
    read = extra.clock("UTC")
    assert read is not None
    assert read.local is not None


def test_offsets_read_as_the_hours_and_minutes_they_are() -> None:
    assert extra._utc_offset(timedelta(hours=5, minutes=30)) == "+05:30"
    assert extra._utc_offset(timedelta(hours=-3, minutes=-30)) == "-03:30"
    assert extra._utc_offset(timedelta()) == "+00:00"


def test_a_zone_the_system_does_not_know_moves_at_no_point() -> None:
    assert extra._changes("Nowhere/Nothing", date(2026, 8, 13)) == ()
    assert extra._daylight("Nowhere/Nothing", date(2026, 8, 13)) == (
        timedelta(), None, None)
