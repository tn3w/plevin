"""The file format: one address in, the stored rows out, codes as words."""

from __future__ import annotations

import json
import mmap
import struct
import sys
from array import array
from bisect import bisect_right
from collections.abc import Callable, Sequence
from functools import partial
from heapq import nsmallest
from itertools import accumulate
from os import PathLike
from typing import Any

try:
    from compression.zstd import ZstdDict, decompress
except ImportError:
    from pyzstd import ZstdDict, decompress  # type: ignore[assignment]

Entry = dict[str, Any]
Row = dict[str, Any]
Read = Callable[[int], Any]
Plan = tuple[Any, Any, Any, Any, Any]
Family = tuple[Any, Any, Any, Any]
Found = tuple[int, int, int]
Words = tuple[str, list[int], list[int], list[int]]

MAGIC = b"PLEVIN\0"
FORMAT = 1
CACHED = 1 << 14
MATCHES = 512
BREAKS = frozenset(" \t-,./()&_+'")
DEGREES = 10_000
UNSEEN = 255
EMPTY: Plan = ((), (), (), (), ())
FORMATS = {1: "B", 2: "H", 4: "I", 8: "Q"}
SIGNED = {1: "b", 2: "h", 4: "i", 8: "q"}
STEPPED = ("signed", "delta")
CARRIED = ("place", "network", "abuse", "prefix", "rpki", "roas", "rir")
LINKED = frozenset(("place", "network", "abuse"))
SPAN = "network"
BOOKS = {"rpki": "rpki", "rir": "rirs", "place.granularity": "granularity",
         "city.timezone": "timezones",
         "city.type": "place_types",
         "operator.category": "categories", "abuse.user_type": "categories",
         "abuse.service": "services", "abuse.evidence": "evidence"}


def _kept(values: array[int]) -> array[int]:
    return values


def _turned(values: array[int]) -> array[int]:
    """Every column is little endian, so a big endian reader turns it around."""
    values.byteswap()
    return values


ORDERED = _turned if sys.byteorder == "big" else _kept


def _risk(value: int) -> float | None:
    """The one scale where zero is a verdict, so unseen needs a code of its own."""
    return None if value == UNSEEN else value / 100


def _word(book: list[str], code: int) -> str:
    return book[code] if code < len(book) else ""


READS: dict[str, Read] = {"abuse.risk": _risk, "abuse.is_anycast": bool,
                          "abuse.is_satellite": bool}


def _varint(data: bytes, at: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, at
        shift += 7


def _varints(data: bytes, at: int, count: int) -> tuple[list[int], int]:
    """The stream a block is mostly made of, read in one loop that never calls out."""
    values: list[int] = []
    append = values.append
    for _ in range(count):
        byte = data[at]
        at += 1
        if byte < 0x80:
            append(byte)
            continue
        value, shift = byte & 0x7F, 7
        while True:
            byte = data[at]
            at += 1
            value |= (byte & 0x7F) << shift
            if byte < 0x80:
                break
            shift += 7
        append(value)
    return values, at


def _unpacker(dictionary: memoryview) -> Callable[[Any], bytes]:
    if not dictionary:
        return decompress
    book = ZstdDict(bytes(dictionary))
    return lambda block: decompress(block, zstd_dict=book)


class Cache(dict[Any, Any]):
    """What a reader would otherwise rebuild, kept until there is too much of it."""

    def __init__(self, build: Callable[[Any], Any], limit: int = CACHED) -> None:
        super().__init__()
        self.build = build
        self.limit = limit

    def __missing__(self, key: Any) -> Any:
        if len(self) >= self.limit:
            self.clear()
        value = self[key] = self.build(key)
        return value


class Section:
    """A block is what the codec packed; a group is all of one a lookup decodes."""

    __slots__ = ("blocks", "cache", "count", "data", "fanout", "groups", "keys",
                 "offsets", "per_block", "per_group", "read", "unpack", "width")

    def __init__(self, view: memoryview, entry: Entry) -> None:
        self.count: int = entry["count"]
        self.read: str = entry["read"]
        self.per_block: int = entry["block"]
        self.per_group: int = entry["group"]
        self.fanout = self.per_block // self.per_group
        blocks, self.width, book = struct.unpack_from("<III", view, 0)
        self.blocks: int = blocks
        at = 12
        self.offsets: tuple[int, ...] = struct.unpack_from(f"<{blocks + 1}I", view, at)
        at += 4 * (blocks + 1)
        width: int = self.width
        self.keys = [int.from_bytes(view[head:head + width], "big")
                     for head in range(at, at + width * blocks, width or 1)]
        at += width * blocks
        self.unpack = _unpacker(view[at:at + book])
        self.data = view[at + book:]
        self.cache = Cache(self.block)
        self.groups = Cache(self.values)

    def raw(self, index: int) -> bytes:
        return self.unpack(self.data[self.offsets[index]:self.offsets[index + 1]])

    def held(self, group: int) -> int:
        return min(self.per_group, self.count - group * self.per_group)

    def block(self, index: int) -> Any:
        raise NotImplementedError(index)

    def values(self, group: int) -> Any:
        raise NotImplementedError(group)

    def __getitem__(self, row: int) -> Any:
        raise NotImplementedError(row)


class Column(Section):
    """A block is one array: reading a value is a subscript, and never a decode."""

    __slots__ = ("formats",)

    def __init__(self, view: memoryview, entry: Entry) -> None:
        super().__init__(view, entry)
        self.formats = SIGNED if entry["encoding"] in STEPPED else FORMATS

    def block(self, index: int) -> Sequence[int]:
        raw = self.raw(index)
        return ORDERED(array(self.formats[raw[0]], raw[1:]))

    def __getitem__(self, row: int) -> Any:
        index, place = divmod(row, self.per_block)
        return self.cache[index][place]

    def rows(self, value: int) -> list[int]:
        """Every row holding this value, searched a block at a time and not a row."""
        found: list[int] = []
        for index in range(self.blocks):
            values, head, at = self.cache[index], index * self.per_block, 0
            while True:
                try:
                    at = values.index(value, at)
                except ValueError:
                    break
                found.append(head + at)
                at += 1
        return found


class Deltas(Column):
    """The steps between values, summed once a block: monotone columns cost a byte."""

    __slots__ = ()

    def block(self, index: int) -> Sequence[int]:
        return list(accumulate(super().block(index)))


class Strings(Section):
    """One pool, front-coded, restarting every group so a group decodes alone."""

    __slots__ = ()

    def block(self, index: int) -> tuple[bytes, list[int]]:
        """Where every group of the block starts, read once and kept for the rest."""
        raw = self.raw(index)
        left = self.count - index * self.per_block
        lengths, at = _varints(raw, 0, min(self.fanout, -(-left // self.per_group)) - 1)
        return raw, [*accumulate(lengths, initial=at), len(raw)]

    def values(self, group: int) -> list[str]:
        index, at = divmod(group, self.fanout)
        raw, starts = self.cache[index]
        cursor = starts[at]
        values, previous = [], b""
        for _ in range(self.held(group)):
            shared, fresh = raw[cursor], raw[cursor + 1]
            cursor += 2
            if fresh > 0x7F:
                fresh, cursor = _varint(raw, cursor - 1)
            previous = previous[:shared] + raw[cursor:cursor + fresh]
            cursor += fresh
            values.append(previous.decode("utf-8", "replace"))
        return values

    def __getitem__(self, identifier: int) -> Any:
        if not identifier:
            return ""
        group, place = divmod(identifier - 1, self.per_group)
        return self.groups[group][place]


class Index(Section):
    """The one section a lookup bisects: block keys, group heads, then gaps."""

    __slots__ = ("host_bits",)

    def __init__(self, view: memoryview, entry: Entry) -> None:
        super().__init__(view, entry)
        self.host_bits = 0 if self.width == 4 else 64

    def block(self, index: int) -> tuple[list[int], list[int], bytes]:
        raw = self.raw(index)
        count, at = _varint(raw, 0)
        total = -(-count // self.per_group)
        gaps, at = _varints(raw, at, total - 1)
        heads = list(accumulate(gaps, initial=self.keys[index]))
        lengths, at = _varints(raw, at, total - 1)
        return heads, list(accumulate(lengths, initial=at)), raw

    def values(self, group: int) -> list[int]:
        index, at = divmod(group, self.fanout)
        heads, starts, raw = self.cache[index]
        size = self.held(group)
        gaps, cursor = _varints(raw, starts[at], size - 1)
        networks = accumulate(gaps, initial=heads[at] >> self.host_bits)
        if not self.host_bits:
            return list(networks)
        hosts, _ = _varints(raw, cursor, size)
        return [network << self.host_bits | host
                for network, host in zip(networks, hosts, strict=True)]

    def __getitem__(self, row: int) -> Any:
        group, spot = divmod(row, self.per_group)
        return self.groups[group][spot]

    def row(self, address: int) -> int | None:
        """The row whose address covers this one, or None below the first of them."""
        index = bisect_right(self.keys, address) - 1
        if index < 0:
            return None
        group = index * self.fanout + bisect_right(self.cache[index][0], address) - 1
        spot = bisect_right(self.groups[group], address) - 1
        return None if spot < 0 else group * self.per_group + spot

    def holds(self, address: int) -> int | None:
        """The row the address is stored at, or None where the file does not name it."""
        row = self.row(address)
        return row if row is not None and self[row] == address else None


class File:
    """The database on disk, mapped once and read a group at a time."""

    def __init__(self, path: str | PathLike[str]) -> None:
        with open(path, "rb") as handle:
            view = memoryview(mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ))
        if bytes(view[:len(MAGIC)]) != MAGIC or view[len(MAGIC)] != FORMAT:
            raise ValueError(f"{path} is not a plevin {FORMAT} database")
        size = struct.unpack_from("<I", view, len(MAGIC) + 1)[0]
        head = len(MAGIC) + 5
        self.head: Entry = json.loads(bytes(view[head:head + size]))
        self.path = str(path)

        body = head + size
        kinds = {"index": Index, "front": Strings, "delta": Deltas}
        self.sections: dict[str, Section] = {}
        for name, entry in self.head["sections"].items():
            at = body + entry["offset"]
            kind = kinds.get(entry["encoding"], Column)
            self.sections[name] = kind(view[at:at + entry["bytes"]], entry)

        books: dict[str, list[str]] = self.head["vocabularies"]
        self.reads: dict[str, Read] = {
            **READS,
            **{field: partial(_word, books[book])
               for field, book in BOOKS.items() if book in books},
        }

        self.tables = self._tables()
        self.rows = Cache(self._linked)
        self.words: Words | None = None
        self.families = {version: self._family(version) for version in (4, 6)}
        self.located = {version: Cache(partial(self._locate, version))
                        for version in (4, 6)}
        self.answers = Cache(self._answer)

    @property
    def built(self) -> str:
        return str(self.head["built"])

    @property
    def selection(self) -> str:
        return str(self.head["selection"])

    @property
    def fields(self) -> list[str]:
        return list(self.head["fields"])

    def _tables(self) -> dict[str, Plan]:
        """Each table's columns split by how they decode, so a read never branches."""
        tables: dict[str, Plan] = {}
        for name, section in self.sections.items():
            parts = name.split(".")
            if len(parts) != 3 or parts[0] not in ("col", "link"):
                continue
            kind, table, field = parts
            lists = tables.setdefault(table, ([], [], [], [], []))
            read = self.reads.get(f"{table}.{field}")
            if kind == "link":
                lists[4].append((field, section))
            elif read:
                lists[3].append((field, section, read))
            elif section.read == "text":
                lists[1].append((field, section, self.sections["strings"]))
            elif section.read:
                lists[2].append((field, section))
            else:
                lists[0].append((field, section))
        return tables

    def _family(self, version: int) -> Family:
        """The index a lookup bisects, the columns read at that row, and the hosts."""
        spine, hosts = f"spine.v{version}", f"hosts.v{version}"
        return (self.sections.get(spine),
                [(name, self.sections[f"{spine}.{name}"], self.reads.get(name))
                 for name in CARRIED if f"{spine}.{name}" in self.sections],
                self.sections.get(hosts), self.sections.get(f"{hosts}.abuse"))

    def _linked(self, key: tuple[str, int]) -> Row:
        """A row of a table, kept: a city is read once however many link to it."""
        table, row = key
        return self._row(table, row)

    def _row(self, table: str, row: int) -> Row:
        plain, text, degrees, coded, links = self.tables.get(table, EMPTY)
        out: Row = {}
        for field, section in plain:
            out[field] = section[row]
        for field, section, pool in text:
            out[field] = pool[section[row]]
        for field, section in degrees:
            out[field] = section[row] / DEGREES
        for field, section, read in coded:
            out[field] = read(section[row])
        for target, section in links:
            linked = section[row]
            if linked:
                out[target] = self.rows[(target, linked - 1)]
        if "postal_partial" in out:
            out["postal_partial"] = out["postal"][:out["postal_partial"]]
        return out

    def _answer(self, key: Found) -> Row:
        """The columns the boundary reads, cached by the row rather than its values."""
        version, row, override = key
        out: Row = {}
        for name, column, read in self.families[version][1]:
            value = override if override and name == "abuse" else column[row]
            if name in LINKED:
                if value:
                    out[name] = self.rows[(name, value - 1)]
            else:
                out.setdefault(SPAN, {})[name] = read(value) if read else value
        return out

    def _locate(self, version: int, address: int) -> Found | None:
        """Which boundary answers, and the record a host overrides it with."""
        index, _, hosts, records = self.families[version]
        row = None if index is None else index.row(address)
        if row is None:
            return None
        if hosts is None or records is None:
            return version, row, 0
        at = hosts.holds(address)
        return version, row, 0 if at is None else records[at] + 1

    def locate(self, value: int, wide: bool) -> Found | None:
        """Which boundary and host record answer, kept so a repeat never bisects."""
        found: Found | None = self.located[6 if wide else 4][value]
        return found

    def row(self, value: int, wide: bool) -> Row | None:
        """The stored answer, or None where the file covers nothing; do not edit it."""
        found = self.locate(value, wide)
        return None if found is None else self.answers[found]

    def _seek(self, column: Section, value: int) -> int:
        """The first row of a sorted column that is not below the value asked for."""
        low, high = 0, column.count
        while low < high:
            middle = (low + high) // 2
            if column[middle] < value:
                low = middle + 1
            else:
                high = middle
        return low

    def system_row(self, asn: int) -> int:
        """The row one ASN is stored at, or -1 where the file carries no such network."""
        column = self.sections.get("col.network.asn")
        if column is None or asn <= 0:
            return -1
        row = self._seek(column, asn)
        return row if row < column.count and column[row] == asn else -1

    def system(self, asn: int) -> Row | None:
        """The network row one ASN is stored at, no address and no bisecting a spine."""
        row = self.system_row(asn)
        if row < 0:
            return None
        found: Row = self.rows[("network", row)]
        return found

    def spans(self, network: int, version: int) -> list[tuple[int, int]]:
        """Every prefix a network row is announced as, deduped, in the spine's order."""
        spine = self.sections.get(f"spine.v{version}")
        links = self.sections.get(f"spine.v{version}.network")
        prefixes = self.sections.get(f"spine.v{version}.prefix")
        if spine is None or prefixes is None or not isinstance(links, Column):
            return []

        bits = 128 if version == 6 else 32
        seen: set[tuple[int, int]] = set()
        held: list[tuple[int, int]] = []
        for row in links.rows(network + 1):
            prefix = prefixes[row]
            spare = bits - prefix
            found = (spine[row] >> spare << spare, prefix)
            if found in seen:
                continue
            seen.add(found)
            held.append(found)
        return held

    def _searchable(self) -> Words:
        """Every ASN's handle and company in one lowercase text a search scans whole."""
        asns = self.sections["col.network.asn"]
        handles = self.sections["col.network.handle"]
        operators = self.sections["link.network.operator"]
        carriers = self.sections["link.network.carrier"]
        companies = self.sections["col.operator.company"]
        peerings = self.sections["col.operator.peering"]
        people = self.sections["col.carrier.user_count"]
        pool = self.sections["strings"]
        rows, words, weights = [], [], []
        for row in range(self._seek(asns, 1), asns.count):
            operator, carrier = operators[row], carriers[row]
            company = pool[companies[operator - 1]] if operator else ""
            peering = peerings[operator - 1] if operator else 0
            users = people[carrier - 1] if carrier else 0
            rows.append(row)
            words.append(f"{pool[handles[row]]}\t{company}".lower())
            weights.append(peering + users.bit_length())
        starts = list(accumulate((len(word) + 1 for word in words), initial=0))
        return "\n".join(words), starts, weights, rows

    def find(self, text: str, limit: int) -> list[Row]:
        """The networks whose handle or company carries the text, widest reach first."""
        needle = text.strip().lower()
        if not needle or "col.network.asn" not in self.sections:
            return []
        if self.words is None:
            self.words = self._searchable()
        haystack, starts, weights, rows = self.words
        found: list[tuple[bool, int, int, int]] = []
        at = haystack.find(needle)
        while at >= 0 and len(found) < MATCHES:
            index = bisect_right(starts, at) - 1
            head, stop = starts[index], starts[index + 1]
            inside = at > head and haystack[at - 1] not in BREAKS
            found.append((inside, -weights[index], stop - head, index))
            at = haystack.find(needle, stop)
        return [self.rows[("network", rows[index])]
                for *_, index in nsmallest(limit, found)]
