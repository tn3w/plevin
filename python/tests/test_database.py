"""The one suite that reads a real build, skipped where no build is beside the repo."""

from __future__ import annotations

import os
import random
from pathlib import Path

import pytest

import plevin

BUILD = os.environ.get("PLEVIN_FULL_DB",
                       str(Path(__file__).resolve().parents[2] / "plevin.plv"))
SAMPLED = 2_000


@pytest.fixture(scope="module")
def built() -> plevin.Plevin:
    if not Path(BUILD).exists():
        pytest.skip(f"no database at {BUILD}")
    return plevin.Plevin(BUILD)


def test_the_file_says_what_it_was_built_from(built: plevin.Plevin) -> None:
    assert built.built.count("-") == 2
    assert built.fields
    assert built.selection


def test_a_well_known_address_reads_as_itself(built: plevin.Plevin) -> None:
    found = built.lookup("8.8.8.8")
    assert found
    assert found.is_global and not found.is_bogon
    assert found.network is not None
    assert found.network.asn == 15169
    assert found.network.operator is not None
    assert found.network.operator.brand == "Google"
    assert found.network.cidr is not None
    assert found.network.cidr.startswith("8.8.8.")
    assert found.place is not None
    assert found.place.city is not None
    assert found.place.city.country == "US"


def test_the_same_network_answers_through_two_families(built: plevin.Plevin) -> None:
    narrow, wide = built.lookup("1.1.1.1"), built.lookup("2606:4700::1111")
    assert narrow.network is not None and wide.network is not None
    assert narrow.network.asn == wide.network.asn == 13335
    assert narrow.version == 4 and wide.version == 6
    assert wide.network.cidr is not None and ":" in wide.network.cidr


def test_a_country_and_a_clock_come_off_the_stored_codes(built: plevin.Plevin) -> None:
    place = built.lookup("1.1.1.1").place
    assert place is not None and place.city is not None
    assert place.country is not None
    assert place.country.code == place.city.country
    assert place.time is not None
    assert place.time.timezone == place.city.timezone


def test_an_address_of_no_country_is_still_read(built: plevin.Plevin) -> None:
    found = built.lookup("127.0.0.1")
    assert found.is_loopback and found.is_private and not found.is_global
    assert found.place is None or found.place.city is None


def test_a_tunnel_is_read_before_the_file_is(built: plevin.Plevin) -> None:
    found = built.lookup("::ffff:8.8.8.8")
    assert found.tunnel == "ipv4-mapped"
    assert found.embedded_ipv4 == "8.8.8.8"


def test_every_address_of_a_sample_answers_without_raising(
    built: plevin.Plevin
) -> None:
    """A sweep wide enough to reach blocks no other test decodes."""
    random.seed(11)
    seen = 0
    for _ in range(SAMPLED):
        value = random.randrange(1 << 32)
        found = built.lookup(value)
        assert found.version == 4
        assert found.number == value
        assert found.ip == plevin.address.written(value, False)
        seen += bool(found)
        if found.network is not None and found.network.prefix is not None:
            assert found.network.cidr is not None
            assert found.network.cidr.endswith(f"/{found.network.prefix}")
    assert seen > SAMPLED // 2


def test_one_address_read_twice_answers_the_same(built: plevin.Plevin) -> None:
    assert built.lookup("9.9.9.9") == built.lookup("9.9.9.9")
    assert built.lookup("2001:4860:4860::8888") == built.lookup("2001:4860:4860::8888")
