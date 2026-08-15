"""What an address says before any database is opened."""

from __future__ import annotations

from ipaddress import IPv4Address, IPv6Address

import pytest

from plevin import address

GOOGLE = 0x08080808
WIDE = 0x26064700 << 96


@pytest.mark.parametrize(
    ("value", "number", "wide"),
    [
        ("8.8.8.8", GOOGLE, False),
        ("2606:4700::", WIDE, True),
        (b"\x08\x08\x08\x08", GOOGLE, False),
        (bytearray(b"\x08\x08\x08\x08"), GOOGLE, False),
        (memoryview(b"\x08\x08\x08\x08"), GOOGLE, False),
        (IPv4Address("8.8.8.8"), GOOGLE, False),
        (IPv6Address("2606:4700::"), WIDE, True),
        (GOOGLE, GOOGLE, False),
        (0, 0, False),
        (0xFFFFFFFF, 0xFFFFFFFF, False),
        (WIDE, WIDE, True),
    ],
)
def test_parse_reads_every_way_an_address_is_written(
    value: address.Value, number: int, wide: bool
) -> None:
    assert address.parse(value) == (number, wide)


@pytest.mark.parametrize("value", [-1, 1 << 128])
def test_parse_refuses_numbers_outside_both_families(value: int) -> None:
    with pytest.raises(ValueError, match="not an address"):
        address.parse(value)


@pytest.mark.parametrize("value", [None, 1.5, True, object()])
def test_parse_refuses_what_is_not_a_number_or_an_address(value: object) -> None:
    with pytest.raises(ValueError, match="not an address"):
        address.parse(value)  # type: ignore[arg-type]


def test_parse_refuses_text_that_is_not_an_address() -> None:
    with pytest.raises(ValueError, match="does not appear"):
        address.parse("not.an.address")


def test_written_spells_both_families() -> None:
    assert address.written(GOOGLE, False) == "8.8.8.8"
    assert address.written(WIDE, True) == "2606:4700::"


def test_spelled_names_what_a_resolver_would_ask_for() -> None:
    assert address.spelled(GOOGLE, False) == (
        "8.8.8.8", "8.8.8.8", "8.8.8.8.in-addr.arpa")
    text, expanded, arpa = address.spelled(WIDE, True)
    assert text == "2606:4700::"
    assert expanded == "2606:4700:0000:0000:0000:0000:0000:0000"
    assert arpa.endswith(".ip6.arpa")


@pytest.mark.parametrize(
    ("text", "marks"),
    [
        ("8.8.8.8", 0),
        ("10.0.0.1", address.PRIVATE),
        ("127.0.0.1", address.PRIVATE | address.LOOPBACK),
        ("224.0.0.1", address.MULTICAST),
        ("192.0.2.1", address.RESERVED | address.DOCUMENTATION),
        ("198.18.0.1", address.RESERVED | address.BENCHMARK),
        ("100.64.0.1", address.PRIVATE | address.SHARED),
        ("169.254.0.1", address.PRIVATE | address.LINK_LOCAL),
        ("9.9.9.9", 0),
        ("2606:4700::1", 0),
        ("::1", address.PRIVATE | address.LOOPBACK),
        ("fd00::1", address.PRIVATE | address.UNIQUE_LOCAL),
        ("fe80::1", address.PRIVATE | address.LINK_LOCAL),
        ("2001:db8::1", address.RESERVED | address.DOCUMENTATION),
        ("ff02::1", address.MULTICAST),
        ("4000::1", address.RESERVED),
    ],
)
def test_purpose_marks_the_space_that_is_not_the_internet(text: str, marks: int) -> None:
    value, wide = address.parse(text)
    assert address.purpose(value, wide) == marks


def test_purpose_answers_below_the_first_range() -> None:
    assert address.purpose(-1, False) == 0


def test_span_masks_the_announcement_out_of_the_address() -> None:
    assert address.span(GOOGLE, False, 24) == ("8.8.8.0/24", "8.8.8.0", "8.8.8.255")
    cidr, start, end = address.span(WIDE | 0x1111, True, 32)
    assert (cidr, start) == ("2606:4700::/32", "2606:4700::")
    assert end == "2606:4700:ffff:ffff:ffff:ffff:ffff:ffff"


@pytest.mark.parametrize(
    ("text", "through", "embedded"),
    [
        ("::ffff:8.8.8.8", address.MAPPED, "8.8.8.8"),
        ("2002:808:808::1", address.SIXTOFOUR, "8.8.8.8"),
        ("2001:0:4136:e378:8000:63bf:3fff:fdd2", address.TEREDO, "192.0.2.45"),
        ("64:ff9b::8.8.8.8", address.NAT64, "8.8.8.8"),
        ("2606:4700::1", None, None),
        ("8.8.8.8", None, None),
    ],
)
def test_a_wide_address_may_carry_a_narrow_one(
    text: str, through: str | None, embedded: str | None
) -> None:
    value, wide = address.parse(text)
    assert address.tunnel(value, wide) == (through, embedded)


def test_a_narrow_address_is_written_as_the_wide_ones_that_carry_it() -> None:
    value, wide = address.parse("8.8.8.8")
    assert address.carried(value, wide) == (
        "::ffff:8.8.8.8",
        "2002:808:808::",
        "64:ff9b::808:808",
    )
    assert address.carried(*address.parse("2606:4700::1")) == (None, None, None)


@pytest.mark.parametrize(
    ("text", "decimal"),
    [
        ("2001:67c:e60:c0c:192:42:116:55", "192.42.116.55"),
        ("2a01:4f8:c17:b8f::1", None),
        ("2001:db8:1:2:10:0:0:1", None),
        ("::ffff:8.8.8.8", None),
        ("8.8.8.8", None),
    ],
)
def test_an_operator_may_write_a_narrow_address_into_the_hextets(
    text: str, decimal: str | None
) -> None:
    assert address.guessed(*address.parse(text)) == decimal
