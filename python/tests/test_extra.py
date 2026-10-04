"""What a country code and a timezone name imply."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from plevin import extra


@pytest.fixture(autouse=True)
def _fresh() -> None:
    extra._module.cache_clear()
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
    assert (found.currency, found.currency_name) == ("USD", "US Dollar")
    assert (found.calling_code, found.languages) == ("+1", ("en",))


def test_every_country_sits_on_exactly_one_continent() -> None:
    pycountry = pytest.importorskip("pycountry")
    codes = {country.alpha_2 for country in pycountry.countries}
    held = [code for names in extra.CONTINENTS.values() for code in names.split()]
    assert len(held) == len(set(held))
    assert not codes - set(held)
    assert set(held) - codes <= {"XK"}


@pytest.mark.parametrize(
    ("code", "continent"),
    [("US", "NA"), ("BR", "SA"), ("DE", "EU"), ("RU", "EU"), ("JP", "AS"), ("TR", "AS"),
     ("ZA", "AF"), ("AU", "OC"), ("AQ", "AN"), ("ZZ", None)],
)
def test_a_country_belongs_to_a_continent(code: str, continent: str | None) -> None:
    found = extra.country(code)
    assert found is not None
    assert found.continent == continent


def test_a_language_is_named_once_whatever_its_scripts() -> None:
    found = extra.country("AZ")
    assert found is not None
    assert found.languages == ("az",)


def test_an_outermost_region_sits_in_the_union_its_state_does() -> None:
    reunion = extra.country("RE")
    assert reunion is not None
    assert reunion.european_union
    greenland = extra.country("GL")
    assert greenland is not None
    assert not greenland.european_union


def test_a_code_pycountry_lacks_takes_the_name_it_was_given() -> None:
    found = extra.country("XK")
    assert found is not None
    assert (found.name, found.iso3) == ("Kosovo", None)


def test_a_member_state_drives_on_the_side_its_neighbours_do() -> None:
    found = extra.country("IE")
    assert found is not None
    assert found.european_union
    assert found.driving_side == "left"


def test_a_code_no_table_names_keeps_the_code() -> None:
    found = extra.country("ZZ")
    assert found is not None
    assert (found.code, found.name, found.iso3) == ("ZZ", None, None)
    assert (found.currency, found.calling_code, found.languages) == (None, None, ())


def test_no_code_is_no_country() -> None:
    assert extra.country("") is None


def test_the_tables_are_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(name: str) -> Any:
        raise ModuleNotFoundError(name)

    monkeypatch.setattr(extra, "import_module", refuse)
    assert extra._table() is None
    found = extra.country("US")
    assert found is not None
    assert (found.code, found.name, found.flag) == ("US", None, "🇺🇸")
    assert (found.currency, found.calling_code, found.languages) == (None, None, ())


def test_a_zone_the_system_does_not_know_has_no_clock() -> None:
    assert extra.clock("Nowhere/Nothing") is None


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
