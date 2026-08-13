"""Databases built in the temporary directory, so no test needs a shipped file."""

from __future__ import annotations

from pathlib import Path

import pytest

from plv import Writer

POOL = [
    "085",
    "1600 Amphitheatre Parkway",
    "94035",
    "94043",
    "California",
    "GOOGLE",
    "Google LLC",
    "Mountain View",
    "Mountain Viewer",
    "San Jose, CA",
    "Santa Clara County",
    "State",
    "Tor",
    "US",
    "US-CA",
    "arin",
    "network-abuse@google.com",
    "https://about.google/intl/en/",
    "Global",
    "A" * 200,
]
TEXT = {value: index + 1 for index, value in enumerate(POOL)}

VOCABULARIES = {
    "categories": ["", "residential", "business", "hosting", "content", "cellular"],
    "services": ["", "public_proxy", "residential_proxy", "anonymous_vpn",
                 "tor_exit_node", "private_relay"],
    "evidence": ["", "published", "measured", "reported", "inferred"],
    "granularity": ["city", "region", "country"],
    "place_types": ["city", "national capital", "regional capital"],
    "rpki": ["unknown", "valid", "invalid"],
    "timezones": ["America/Los_Angeles", "UTC", "Nowhere/Nothing"],
}

V4 = [0x00000000, 0x01000000, 0x08080800, 0x09000000, 0x0A000000, 0x0B000000,
      0x0C000000, 0x0D000000, 0x0E000000]
HOST_V4 = 0x08080808
CLOUDFLARE = 0x26064700 << 96
HOST_V6 = CLOUDFLARE | 0x1111
V6 = [0, CLOUDFLARE]


def _tables(writer: Writer) -> None:
    writer.strings("strings", POOL)

    writer.column("col.city.name", [TEXT["Mountain View"], TEXT["Mountain Viewer"]],
                  read="text")
    writer.column("col.city.ascii", [TEXT["Mountain View"], 0], read="text")
    writer.column("col.city.country", [TEXT["US"], 0], read="text")
    writer.column("col.city.postal", [TEXT["94035"], 0], read="text")
    writer.column("col.city.id", [5375480, 0])
    writer.column("col.city.population", [80435, 0])
    writer.column("col.city.elevation", [32, -5], signed=True)
    writer.column("col.city.postal_partial", [3, 0])
    writer.column("col.city.timezone", [0, 1])
    writer.column("col.city.type", [0, 1])
    writer.column("link.city.region", [1, 0])
    writer.column("link.city.district", [1, 0])
    writer.column("link.city.metro", [1, 0])

    writer.column("col.region.id", [5332921])
    writer.column("col.region.code", [TEXT["California"]], read="text")
    writer.column("col.region.iso", [TEXT["US-CA"]], read="text")
    writer.column("col.region.name", [TEXT["California"]], read="text")
    writer.column("col.region.type", [TEXT["State"]], read="text")

    writer.column("col.district.id", [5393021])
    writer.column("col.district.code", [TEXT["085"]], read="text")
    writer.column("col.district.name", [TEXT["Santa Clara County"]], read="text")

    writer.column("col.metro.code", [807])
    writer.column("col.metro.label", [TEXT["San Jose, CA"]], read="text")

    writer.column("col.operator.company", [TEXT["Google LLC"]], read="text")
    writer.column("col.operator.website", [TEXT["https://about.google/intl/en/"]],
                  read="text")
    writer.column("col.operator.abuse_email", [TEXT["network-abuse@google.com"]],
                  read="text")
    writer.column("col.operator.street", [TEXT["1600 Amphitheatre Parkway"]],
                  read="text")
    writer.column("col.operator.state", [TEXT["California"]], read="text")
    writer.column("col.operator.postal", [TEXT["94043"]], read="text")
    writer.column("col.operator.country", [TEXT["US"]], read="text")
    writer.column("col.operator.rir", [TEXT["arin"]], read="text")
    writer.column("col.operator.scope", [TEXT["Global"]], read="text")
    writer.column("col.operator.category", [4])
    writer.column("col.operator.tier", [2])
    writer.column("col.operator.peering", [176])
    writer.column("col.operator.since", [2000])
    writer.column("link.operator.city", [1])

    writer.column("col.carrier.mcc", [262])
    writer.column("col.carrier.mnc", [1])
    writer.column("col.carrier.user_count", [66])

    writer.column("col.abuse.name", [0, TEXT["Tor"], TEXT["A" * 200]], read="text")
    writer.column("col.abuse.service", [0, 4, 1])
    writer.column("col.abuse.evidence", [0, 2, 0])
    writer.column("col.abuse.is_anycast", [0, 0, 1])
    writer.column("col.abuse.is_satellite", [0, 1, 0])
    writer.column("col.abuse.risk", [255, 97, 20])
    writer.column("col.abuse.last_seen_days", [0, 1, 5])
    writer.column("col.abuse.user_type", [3, 3, 1])

    writer.column("col.network.asn", [15169])
    writer.column("col.network.handle", [TEXT["GOOGLE"]], read="text")
    writer.column("link.network.operator", [1])
    writer.column("link.network.carrier", [1])
    writer.column("link.network.abuse", [1])

    writer.column("col.place.lat", [373861, 0], read="degrees", signed=True)
    writer.column("col.place.lon", [-1220838, 0], read="degrees", signed=True,
                  dictionary=True)
    writer.column("col.place.accuracy", [200, 0])
    writer.column("col.place.confidence", [35, 0])
    writer.column("col.place.granularity", [0, 2])
    writer.column("link.place.city", [1, 2])


def _spines(writer: Writer) -> None:
    rows = len(V4)
    writer.index("spine.v4", V4, wide=False)
    writer.column("spine.v4.place", [0, 1, 1, 2] + [0] * (rows - 4))
    writer.column("spine.v4.network", [0, 1, 1, 0] + [0] * (rows - 4))
    writer.column("spine.v4.abuse", [0, 2, 1, 0] + [0] * (rows - 4))
    writer.column("spine.v4.prefix", [0, 8, 24, 8] + [0] * (rows - 4))
    writer.column("spine.v4.rpki", [0, 1, 1, 0] + [0] * (rows - 4))
    writer.column("spine.v4.roas", [0, 0, 1, 0] + [0] * (rows - 4))
    writer.index("hosts.v4", [HOST_V4], wide=False)
    writer.column("hosts.v4.abuse", [2])

    writer.index("spine.v6", V6, wide=True)
    writer.column("spine.v6.place", [0, 1])
    writer.column("spine.v6.network", [0, 1])
    writer.column("spine.v6.abuse", [0, 1])
    writer.column("spine.v6.prefix", [0, 32])
    writer.column("spine.v6.rpki", [0, 2])
    writer.column("spine.v6.roas", [0, 3])
    writer.index("hosts.v6", [HOST_V6], wide=True)
    writer.column("hosts.v6.abuse", [1])


def written(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


@pytest.fixture(scope="session")
def full(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Every section the reader knows, in a file of a few kilobytes."""
    writer = Writer()
    writer.vocabularies = VOCABULARIES
    _tables(writer)
    _spines(writer)
    return written(tmp_path_factory.mktemp("full") / "full.plv",
                   writer.build(fields=["place.city.name"]))


@pytest.fixture(scope="session")
def slim(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A v4 spine and nothing else: no hosts, no v6, no tables to link into."""
    writer = Writer()
    writer.vocabularies = {"rpki": VOCABULARIES["rpki"]}
    writer.index("spine.v4", [0x0A000000], wide=False)
    writer.column("spine.v4.place", [1])
    writer.column("spine.v4.prefix", [8])
    writer.column("spine.v4.rpki", [0])
    return written(tmp_path_factory.mktemp("slim") / "slim.plv",
                   writer.build(selection="place"))


@pytest.fixture(scope="session")
def bare(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A spine that carries a place and not one column of network."""
    writer = Writer()
    writer.index("spine.v4", [0x0A000000], wide=False)
    writer.column("spine.v4.place", [1])
    return written(tmp_path_factory.mktemp("bare") / "bare.plv",
                   writer.build(selection="place"))


@pytest.fixture
def opened(full: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The full database, as the one a bare `plevin.lookup` should find."""
    import plevin

    monkeypatch.setattr(plevin, "_opened", None)
    monkeypatch.setenv(plevin.ENVIRONMENT, str(full))
    return full
