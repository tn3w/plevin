"""The package as a reader uses it."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType

import pytest

import plevin
from conftest import HOST_V4, HOST_V6
from plevin import Dns, reader

MOMENT = datetime(2026, 8, 13, 12, tzinfo=timezone.utc)


def test_an_address_answers_what_it_says_on_its_own(opened: Path) -> None:
    found = plevin.lookup("127.0.0.1")
    assert (found.ip, found.version) == ("127.0.0.1", 4)
    assert found.arpa == "1.0.0.127.in-addr.arpa"
    assert found.is_bogon and found.is_private and found.is_loopback
    assert not found.is_multicast and not found.is_reserved


def test_an_address_the_file_does_not_cover_is_falsy(slim: Path) -> None:
    found = plevin.Plevin(slim).lookup("1.2.3.4")
    assert not found
    assert not found.found
    assert (found.place, found.network, found.abuse) == (None, None, None)


def test_a_covered_address_answers_place_network_and_abuse(opened: Path) -> None:
    found = plevin.lookup("8.8.8.8", MOMENT)
    assert found
    assert found.place is not None
    assert found.place.city is not None
    assert found.place.city.name == "Mountain View"
    assert found.place.city.ascii == "Mountain View"
    assert found.place.city.population == 80435
    assert found.place.city.elevation == 32
    assert found.place.city.postal_partial == "940"
    assert found.place.city.capital is None
    assert found.place.city.region is not None
    assert found.place.city.region.name == "California"
    assert found.place.city.district is not None
    assert found.place.city.district.name == "Santa Clara County"
    assert found.place.city.metro is not None
    assert found.place.city.metro.code == 807
    assert (found.place.lat, found.place.lon) == (37.3861, -122.0838)
    assert found.place.granularity == "city"


def test_a_country_code_becomes_a_country(opened: Path) -> None:
    place = plevin.lookup("8.8.8.8", MOMENT).place
    assert place is not None
    assert place.country is not None
    assert (place.country.code, place.country.iso3) == ("US", "USA")
    assert place.country.flag == "🇺🇸"


def test_a_timezone_becomes_a_clock(opened: Path) -> None:
    place = plevin.lookup("8.8.8.8", MOMENT).place
    assert place is not None
    assert place.time is not None
    assert place.time.timezone == "America/Los_Angeles"
    assert place.time.local == "2026-08-13T05:00:00-07:00"
    assert place.time.is_dst


def test_a_network_carries_the_announcement_it_falls_in(opened: Path) -> None:
    network = plevin.lookup("8.8.8.8").network
    assert network is not None
    assert (network.asn, network.handle) == (15169, "GOOGLE")
    assert (network.cidr, network.start, network.end) == (
        "8.8.8.0/24", "8.8.8.0", "8.8.8.255")
    assert (network.rpki, network.roas, network.prefix) == ("valid", 1, 24)
    assert network.rir == "arin"


def test_an_operator_is_named_by_the_shorter_of_its_names(opened: Path) -> None:
    network = plevin.lookup("8.8.8.8").network
    assert network is not None
    assert network.operator is not None
    assert network.operator.brand == "Google"
    assert network.operator.domain == "google.com"
    assert network.operator.company == "Google LLC"
    assert (network.operator.tier, network.operator.since) == (2, 2000)
    assert network.operator.city is not None
    assert network.operator.city.name == "Mountain View"


def test_a_carrier_reads_its_type_off_the_abuse_rows(opened: Path) -> None:
    network = plevin.lookup("8.8.8.8").network
    assert network is not None
    assert network.carrier is not None
    assert network.carrier.user_type == "residential"
    assert (network.carrier.mcc, network.carrier.mnc) == (262, 1)
    assert network.carrier.user_count == 66
    assert not network.carrier.is_mobile


def test_a_public_proxy_on_a_home_line_is_read_as_a_resold_one(opened: Path) -> None:
    abuse = plevin.lookup("8.8.8.8").abuse
    assert abuse is not None
    assert abuse.service == "residential_proxy"
    assert abuse.evidence == "inferred"
    assert abuse.is_proxy and abuse.is_residential_proxy and abuse.is_anonymous
    assert not abuse.is_public_proxy
    assert not abuse.is_hosting_provider
    assert abuse.risk == 0.2
    assert abuse.network_risk is None
    assert abuse.last_seen_days == 5
    assert abuse.is_anycast


def test_an_exit_node_is_read_as_one(opened: Path) -> None:
    abuse = plevin.lookup("1.2.3.4").abuse
    assert abuse is not None
    assert (abuse.name, abuse.service) == ("Tor", "tor_exit_node")
    assert abuse.evidence == "measured"
    assert abuse.is_tor_exit_node and abuse.is_anonymous and abuse.is_satellite
    assert abuse.is_hosting_provider
    assert abuse.risk == 0.97


def test_a_boundary_without_an_abuse_record_still_reads_the_asn(opened: Path) -> None:
    found = plevin.lookup("9.9.9.9")
    assert found.abuse is None
    assert found.network is not None
    assert found.network.asn is None
    assert found.network.operator is None
    assert found.network.carrier is None
    assert found.place is not None
    assert found.place.city is not None
    assert found.place.city.capital == "country"
    assert found.place.city.country is None
    assert found.place.city.metro is None
    assert found.place.country is None
    assert found.place.time is not None
    assert found.place.time.timezone == "UTC"


def test_a_v6_address_reads_the_same_way(opened: Path) -> None:
    found = plevin.lookup("2606:4700::1111")
    assert found.version == 6
    assert found.network is not None
    assert found.network.cidr == "2606:4700::/32"
    assert found.abuse is not None
    assert found.abuse.name == "Tor"


@pytest.mark.parametrize("value", ["8.8.8.8", HOST_V4, b"\x08\x08\x08\x08"])
def test_one_address_reads_the_same_however_it_is_written(
    opened: Path, value: plevin.address.Value
) -> None:
    assert plevin.lookup(value).ip == "8.8.8.8"


def test_a_wide_address_reads_the_same_however_it_is_written(opened: Path) -> None:
    assert plevin.lookup(HOST_V6).ip == "2606:4700::1111"


def test_a_place_with_nothing_linked_to_it_stays_empty(slim: Path) -> None:
    found = plevin.Plevin(slim).lookup("10.0.0.1")
    assert found
    assert found.place is not None
    assert found.place.city is None
    assert found.place.country is None
    assert found.place.time is None
    assert found.network is not None
    assert found.network.cidr == "10.0.0.0/8"
    assert found.network.operator is None
    assert found.network.carrier is None


def test_a_database_names_what_it_was_built_from(full: Path) -> None:
    database = plevin.Plevin(full)
    assert database.built == "2026-08-13"
    assert database.selection == "full"
    assert database.fields == ["place.city.name"]
    assert database.path == str(full)


def test_the_module_reads_one_database_until_told_otherwise(
    full: Path, slim: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plevin, "_opened", None)
    monkeypatch.delenv(plevin.ENVIRONMENT, raising=False)
    assert plevin.use(full).path == str(full)
    assert plevin.database().path == str(full)
    assert plevin.lookup("8.8.8.8").found
    assert plevin.use(slim).path == str(slim)
    monkeypatch.setenv(plevin.ENVIRONMENT, str(full))
    assert plevin.use(None).path == str(full)


def test_a_database_package_is_found_where_no_path_is_given(
    full: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plevin, "_opened", None)
    monkeypatch.delenv(plevin.ENVIRONMENT, raising=False)
    module = ModuleType("plevin_db_country")
    module.PATH = full  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "plevin_db_country", module)
    assert plevin.database().path == str(full)


def test_without_a_database_the_reader_says_where_to_get_one(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plevin, "_opened", None)
    monkeypatch.delenv(plevin.ENVIRONMENT, raising=False)
    for package in plevin.PACKAGES:
        monkeypatch.setitem(sys.modules, package, None)
    with pytest.raises(LookupError, match="plevin-db"):
        plevin.database()


def test_a_spine_without_one_network_column_answers_no_network(bare: Path) -> None:
    found = plevin.Plevin(bare).lookup("10.0.0.1")
    assert found
    assert found.network is None
    assert found.place == plevin.Place()


def test_a_result_carries_the_forms_an_address_is_written_in(opened: Path) -> None:
    found = plevin.lookup("2606:4700::1111")
    assert found.number == HOST_V6
    assert found.compressed == "2606:4700::1111"
    assert found.expanded == "2606:4700:0000:0000:0000:0000:0000:1111"
    assert found.is_global
    assert not found.is_bogon


def test_a_narrow_result_is_written_the_same_way_twice(opened: Path) -> None:
    found = plevin.lookup("8.8.8.8")
    assert (found.number, found.compressed, found.expanded) == (
        HOST_V4, "8.8.8.8", "8.8.8.8")


@pytest.mark.parametrize(
    ("text", "name"),
    [
        ("100.64.0.1", "is_shared"),
        ("198.18.0.1", "is_benchmark"),
        ("169.254.0.1", "is_link_local"),
        ("192.0.2.1", "is_documentation"),
        ("fd00::1", "is_unique_local"),
        ("fe80::1", "is_link_local"),
        ("2001:db8::1", "is_documentation"),
    ],
)
def test_an_address_says_which_special_range_it_sits_in(
    opened: Path, text: str, name: str
) -> None:
    found = plevin.lookup(text)
    assert getattr(found, name)
    assert found.is_bogon and not found.is_global


def test_a_tunnel_names_the_address_it_carries(opened: Path) -> None:
    mapped = plevin.lookup("::ffff:8.8.8.8")
    assert mapped.is_ipv4_mapped and mapped.embedded_ipv4 == "8.8.8.8"
    assert mapped.tunnel == "ipv4-mapped"
    sixtofour = plevin.lookup("2002:808:808::1")
    assert sixtofour.is_6to4 and sixtofour.embedded_ipv4 == "8.8.8.8"
    teredo = plevin.lookup("2001:0:4136:e378:8000:63bf:3fff:fdd2")
    assert teredo.is_teredo and teredo.embedded_ipv4 == "192.0.2.45"
    plain = plevin.lookup("8.8.8.8")
    assert (plain.tunnel, plain.embedded_ipv4) == (None, None)
    assert not plain.is_ipv4_mapped and not plain.is_6to4 and not plain.is_teredo


def test_one_model_serves_every_read_of_the_same_row(opened: Path) -> None:
    found = plevin.lookup("8.8.8.8")
    assert found.place is not None and found.network is not None
    assert found.network.operator is not None
    assert found.network.operator.city is found.place.city
    beside = plevin.lookup("8.8.8.9").place
    assert beside is not None
    assert beside.city is found.place.city


def test_a_shape_starts_over_rather_than_growing_without_end() -> None:
    shaped = plevin.Shaped(lambda rows: dict(rows))
    kept = [{"name": str(count)} for count in range(reader.CACHED)]
    for rows in kept:
        shaped(rows)
    assert len(shaped.held) == reader.CACHED
    assert shaped(kept[0]) is not None
    shaped({"name": "one more"})
    assert len(shaped.held) == 1


def test_a_row_the_file_has_forgotten_is_shaped_again() -> None:
    first, second = {"name": "one"}, {"name": "one"}
    shaped = plevin.Shaped(lambda rows: dict(rows))
    assert shaped(first) is not shaped(second)
    assert shaped(None) is None


def test_a_moment_of_your_own_is_read_without_the_cache(
    opened: Path, slim: Path
) -> None:
    aside = plevin.lookup("8.8.8.8", MOMENT)
    assert aside.place is not None and aside.place.time is not None
    assert aside.place.time.local == "2026-08-13T05:00:00-07:00"
    assert not plevin.Plevin(slim).lookup("1.2.3.4", MOMENT)


def test_the_answers_are_dropped_when_the_second_turns(opened: Path) -> None:
    database = plevin.database()
    database.lookup("8.8.8.8")
    assert database.results
    database.second -= 1
    database.lookup("8.8.8.8")
    assert len(database.results) == 1


def test_an_address_is_written_as_the_wide_ones_that_carry_it(opened: Path) -> None:
    found = plevin.lookup("8.8.8.8")
    assert found.as_ipv4_mapped == "::ffff:8.8.8.8"
    assert (found.as_6to4, found.as_nat64) == ("2002:808:808::", "64:ff9b::808:808")
    wide = plevin.lookup("2606:4700::1")
    assert (wide.as_ipv4_mapped, wide.as_6to4, wide.as_nat64) == (None, None, None)


def test_dns_is_asked_about_an_address_only_where_the_flag_says_so(
    opened: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked = []

    def named(value: int, wide: bool) -> Dns:
        asked.append((value, wide))
        return Dns(asked="8.8.8.8", hostname="dns.google")

    monkeypatch.setattr(plevin.naming, "named", named)
    assert plevin.lookup("8.8.8.8").dns is None
    assert asked == []
    found = plevin.lookup("8.8.8.8", dns=True)
    assert found.dns is not None and found.dns.hostname == "dns.google"
    assert asked == [(0x08080808, False)]
    assert found.ip == "8.8.8.8" and found.found


def test_hextets_that_read_as_decimal_are_guessed_at(opened: Path) -> None:
    found = plevin.lookup("2001:67c:e60:c0c:192:42:116:55")
    assert found.decimal_ipv4 == "192.42.116.55"
    assert (found.tunnel, found.embedded_ipv4) == (None, None)
    assert plevin.lookup("2606:4700::1111").decimal_ipv4 is None
