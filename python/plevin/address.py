"""What an address is before any database is opened."""

from __future__ import annotations

from bisect import bisect_right
from ipaddress import IPv4Address, IPv6Address, ip_address, ip_network
from socket import AF_INET, AF_INET6, inet_pton

Value = str | int | bytes | bytearray | memoryview | IPv4Address | IPv6Address

PRIVATE, LOOPBACK, MULTICAST, RESERVED = 1, 2, 4, 8
LINK_LOCAL, UNIQUE_LOCAL, DOCUMENTATION, SHARED, BENCHMARK = 16, 32, 64, 128, 256

SPECIAL_V4 = (
    ("0.0.0.0/8", RESERVED),
    ("10.0.0.0/8", PRIVATE),
    ("100.64.0.0/10", PRIVATE | SHARED),
    ("127.0.0.0/8", PRIVATE | LOOPBACK),
    ("169.254.0.0/16", PRIVATE | LINK_LOCAL),
    ("172.16.0.0/12", PRIVATE),
    ("192.0.0.0/24", RESERVED),
    ("192.0.2.0/24", RESERVED | DOCUMENTATION),
    ("192.88.99.0/24", RESERVED),
    ("192.168.0.0/16", PRIVATE),
    ("198.18.0.0/15", RESERVED | BENCHMARK),
    ("198.51.100.0/24", RESERVED | DOCUMENTATION),
    ("203.0.113.0/24", RESERVED | DOCUMENTATION),
    ("224.0.0.0/4", MULTICAST),
    ("240.0.0.0/4", RESERVED),
)
SPECIAL_V6 = (
    ("::/128", RESERVED),
    ("::1/128", PRIVATE | LOOPBACK),
    ("::ffff:0:0/96", RESERVED),
    ("64:ff9b::/96", RESERVED),
    ("64:ff9b:1::/48", RESERVED),
    ("100::/64", RESERVED),
    ("2001::/23", RESERVED),
    ("2001:db8::/32", RESERVED | DOCUMENTATION),
    ("2002::/16", RESERVED),
    ("3fff::/20", RESERVED | DOCUMENTATION),
    ("fc00::/7", PRIVATE | UNIQUE_LOCAL),
    ("fe80::/10", PRIVATE | LINK_LOCAL),
    ("ff00::/8", MULTICAST),
)

MAPPED = "ipv4-mapped"
SIXTOFOUR = "6to4"
TEREDO = "teredo"
NAT64 = "nat64"
NAT64_PREFIX = 0x0064FF9B << 96


def _table(rows: tuple[tuple[str, int], ...]) -> tuple[list[int], list[tuple[int, int]]]:
    """The rows as first addresses to bisect, and what each range ends at and marks."""
    spans = []
    for text, marks in rows:
        span = ip_network(text)
        spans.append((int(span.network_address), int(span.broadcast_address), marks))
    spans.sort()
    return [first for first, _, _ in spans], [(last, marks) for _, last, marks in spans]


SPECIAL = (_table(SPECIAL_V4), _table(SPECIAL_V6))


def parse(value: Value) -> tuple[int, bool]:
    """An address however it is written; an integer reads as v6 only above 0xFFFFFFFF."""
    if isinstance(value, str):
        wide = ":" in value
        try:
            packed = inet_pton(AF_INET6 if wide else AF_INET, value)
        except OSError:
            return parse(ip_address(value))
        return int.from_bytes(packed, "big"), wide
    if isinstance(value, bytes | bytearray | memoryview):
        return parse(ip_address(bytes(value)))
    if isinstance(value, IPv4Address | IPv6Address):
        return int(value), value.version == 6
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{value!r} is not an address")
    if value < 0 or value > 0xFFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFF:
        raise ValueError(f"{value} is not an address")
    return value, value > 0xFFFFFFFF


def written(value: int, wide: bool) -> str:
    """An address as text: v4 from its octets, v6 through the shortening rules."""
    if wide:
        return str(IPv6Address(value))
    return f"{value >> 24}.{value >> 16 & 255}.{value >> 8 & 255}.{value & 255}"


def spelled(value: int, wide: bool) -> tuple[str, str, str]:
    """How the address reads short and in full, and the name a resolver asks by."""
    if wide:
        address = IPv6Address(value)
        return str(address), address.exploded, address.reverse_pointer
    octets = [str(value >> shift & 255) for shift in (24, 16, 8, 0)]
    text = ".".join(octets)
    return text, text, ".".join(reversed(octets)) + ".in-addr.arpa"


def tunnel(value: int, wide: bool) -> tuple[str | None, str | None]:
    """The v4 address a v6 one carries, and the tunnel that puts it there."""
    if not wide:
        return None, None
    address = IPv6Address(value)
    if address.ipv4_mapped is not None:
        return MAPPED, str(address.ipv4_mapped)
    if address.sixtofour is not None:
        return SIXTOFOUR, str(address.sixtofour)
    if address.teredo is not None:
        return TEREDO, str(address.teredo[1])
    if value >> 32 == NAT64_PREFIX >> 32:
        return NAT64, written(value & 0xFFFFFFFF, False)
    return None, None


def guessed(value: int, wide: bool) -> str | None:
    """The v4 address an operator wrote into the last four hextets as decimal."""
    if not wide or tunnel(value, wide)[0] is not None:
        return None
    hextets = [f"{value >> shift & 0xFFFF:x}" for shift in (48, 32, 16, 0)]
    if not all(part.isdigit() and 0 < int(part) < 256 for part in hextets):
        return None
    return ".".join(hextets)


def carried(value: int, wide: bool) -> tuple[str | None, str | None, str | None]:
    """The v6 addresses a v4 one is written as where a tunnel carries it across."""
    if wide:
        return None, None, None
    return (
        written(0xFFFF_00000000 | value, True),
        written(0x2002 << 112 | value << 80, True),
        written(NAT64_PREFIX | value, True),
    )


def purpose(value: int, wide: bool) -> int:
    """What an address is where it is not the internet, bisected out of the table."""
    starts, ranges = SPECIAL[wide]
    at = bisect_right(starts, value) - 1
    if at >= 0:
        last, marks = ranges[at]
        if value <= last:
            return marks
    return RESERVED if wide and value >> 125 != 1 else 0


def span(value: int, wide: bool, prefix: int) -> tuple[str, str, str]:
    """The announcement the address falls in, masked out of the address itself."""
    spare = (128 if wide else 32) - prefix
    start = written(value >> spare << spare, wide)
    return f"{start}/{prefix}", start, written(value | (1 << spare) - 1, wide)
