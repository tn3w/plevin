"""The file format, read out of databases built for the purpose."""

from __future__ import annotations

from array import array
from pathlib import Path

import pytest

from conftest import CLOUDFLARE, HOST_V4, HOST_V6, VOCABULARIES, written
from plevin import reader
from plv import Writer


def rows(file: reader.File, value: int, wide: bool = False) -> reader.Row:
    row = file.row(value, wide)
    assert row is not None
    return row


def spine(file: reader.File, name: str) -> reader.Index:
    index = file.sections[name]
    assert isinstance(index, reader.Index)
    return index


def test_a_file_that_is_not_a_database_is_refused(tmp_path: Path) -> None:
    path = written(tmp_path / "wrong.plv", b"NOTPLV\0\1" + bytes(64))
    with pytest.raises(ValueError, match="not a plevin 1 database"):
        reader.File(path)


def test_a_later_format_is_refused(tmp_path: Path) -> None:
    path = written(tmp_path / "later.plv", reader.MAGIC + bytes([2]) + bytes(64))
    with pytest.raises(ValueError, match="not a plevin 1 database"):
        reader.File(path)


def test_the_header_says_what_was_built(full: Path) -> None:
    file = reader.File(full)
    assert file.built == "2026-08-13"
    assert file.selection == "full"
    assert file.fields == ["place.city.name"]
    assert file.path == str(full)


def test_a_boundary_answers_everything_stored_for_it(full: Path) -> None:
    file = reader.File(full)
    row = file.row(HOST_V4, False)
    assert row is not None
    assert row["place"]["city"]["name"] == "Mountain View"
    assert row["place"]["city"]["region"]["iso"] == "US-CA"
    assert row["place"]["city"]["district"]["code"] == "085"
    assert row["place"]["city"]["metro"]["label"] == "San Jose, CA"
    assert row["place"]["lat"] == 37.3861
    assert row["place"]["lon"] == -122.0838
    assert row["network"]["asn"] == 15169
    assert row["network"]["prefix"] == 24
    assert row["network"]["rpki"] == "valid"
    assert row["network"]["roas"] == 1
    assert row["network"]["operator"]["city"]["name"] == "Mountain View"
    assert row["network"]["carrier"]["mcc"] == 262


def test_a_host_overrides_the_boundary_it_falls_in(full: Path) -> None:
    file = reader.File(full)
    assert rows(file, HOST_V4)["abuse"]["service"] == "public_proxy"
    assert rows(file, HOST_V4 - 8)["abuse"]["service"] == ""
    assert rows(file, 0x01000001)["abuse"]["service"] == "tor_exit_node"


def test_a_row_the_file_does_not_cover_answers_nothing(slim: Path) -> None:
    file = reader.File(slim)
    assert file.row(0x01020304, False) is None
    assert file.row(1, True) is None


def test_a_boundary_without_tables_answers_the_columns_alone(slim: Path) -> None:
    row = reader.File(slim).row(0x0A000001, False)
    assert row == {"place": {}, "network": {"prefix": 8, "rpki": "unknown"}}


def test_a_link_of_zero_links_to_nothing(full: Path) -> None:
    row = reader.File(full).row(0x09000001, False)
    assert row is not None
    assert "abuse" not in row
    assert "operator" not in row["network"]
    city = row["place"]["city"]
    assert (city["name"], city["postal_partial"]) == ("Mountain Viewer", "")
    assert not {"region", "district", "metro"} & set(city)


def test_the_partial_postal_code_is_a_prefix_of_the_postal_one(full: Path) -> None:
    city = rows(reader.File(full), HOST_V4)["place"]["city"]
    assert (city["postal"], city["postal_partial"]) == ("94035", "940")


def test_the_v6_family_reads_its_own_index(full: Path) -> None:
    file = reader.File(full)
    assert rows(file, HOST_V6, True)["abuse"]["name"] == "Tor"
    assert rows(file, CLOUDFLARE | 0x9, True)["network"]["roas"] == 3


def test_a_group_that_names_a_later_host_answers_nothing(tmp_path: Path) -> None:
    writer = Writer()
    writer.vocabularies = VOCABULARIES
    writer.index("spine.v6", [CLOUDFLARE], wide=True, skew=5)
    writer.column("spine.v6.prefix", [32])
    path = written(tmp_path / "skewed.plv", writer.build())
    assert reader.File(path).row(CLOUDFLARE, True) is None


def test_a_long_string_carries_its_length_as_a_varint(full: Path) -> None:
    assert rows(reader.File(full), HOST_V4)["abuse"]["name"] == "A" * 200


def test_the_empty_string_is_never_stored(full: Path) -> None:
    assert reader.File(full).sections["strings"][0] == ""


def test_a_code_past_the_vocabulary_reads_as_nothing() -> None:
    assert reader._word(["one"], 0) == "one"
    assert reader._word(["one"], 7) == ""


def test_the_one_scale_where_zero_is_a_verdict() -> None:
    assert reader._risk(0) == 0.0
    assert reader._risk(97) == 0.97
    assert reader._risk(reader.UNSEEN) is None


def test_a_big_endian_reader_turns_a_column_around() -> None:
    values = array("H", [1, 256])
    assert reader._turned(values).tolist() == [256, 1]
    assert reader._kept(array("H", [1])).tolist() == [1]


def test_varints_read_one_byte_and_many() -> None:
    assert reader._varints(b"\x01\x80\x02\x7f", 0, 3) == ([1, 256, 127], 4)
    assert reader._varint(b"\xff\x01", 0) == (255, 2)


def test_a_cache_starts_over_rather_than_growing_without_end() -> None:
    cache = reader.Cache(lambda key: key)
    for key in range(reader.CACHED):
        assert cache[key] == key
    assert len(cache) == reader.CACHED
    assert cache[reader.CACHED] == reader.CACHED
    assert len(cache) == 1


def test_a_section_of_no_particular_kind_reads_nothing(full: Path) -> None:
    section = reader.File(full).sections["strings"]
    bare = reader.Section.__new__(reader.Section)
    for call, argument in ((reader.Section.block, 0), (reader.Section.values, 0),
                           (reader.Section.__getitem__, 0)):
        with pytest.raises(NotImplementedError):
            call(bare, argument)
    assert section.held(0) == section.per_group


def test_an_address_the_index_starts_above_answers_nothing(slim: Path) -> None:
    index = spine(reader.File(slim), "spine.v4")
    assert index.row(0x01020304) is None
    assert index.holds(0x01020304) is None
    assert index.holds(0x0A000000) == 0
    assert index.holds(0x0A000001) is None
