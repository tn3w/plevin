"""The plevin lookup with no package around it: one file, one answer, no shaping."""

from __future__ import annotations

import json
import lzma
import mmap
import struct
import sys
from array import array
from bisect import bisect_right
from collections.abc import Callable
from itertools import accumulate
from socket import AF_INET, AF_INET6, inet_pton
from typing import Any

Row = dict[str, Any]

MAGIC, FORMAT, WINDOW, CACHED, DEGREES = b"PLEVIN\0", 2, 1 << 20, 1 << 14, 10_000
FORMATS = {1: "B", 2: "H", 4: "I", 8: "Q"}
SIGNED = {1: "b", 2: "h", 4: "i", 8: "q"}
CARRIED = ("place", "network", "abuse", "prefix", "rpki", "roas")
LINKED = ("place", "network", "abuse")
BOOKS = {"rpki": "rpki", "place.granularity": "granularity",
         "city.timezone": "timezones", "city.type": "place_types",
         "operator.category": "categories", "abuse.user_type": "categories",
         "abuse.service": "services", "abuse.evidence": "evidence"}
READS: dict[str, Callable[[int], Any]] = {
    "abuse.risk": lambda value: None if value == 255 else value / 100,
    "abuse.is_anycast": bool, "abuse.is_satellite": bool}


def varint(data: bytearray, at: int) -> tuple[int, int]:
    value = shift = 0
    while data[at] & 0x80:
        value |= (data[at] & 0x7F) << shift
        at, shift = at + 1, shift + 7
    return value | data[at] << shift, at + 1


def varints(data: bytearray, at: int, count: int) -> tuple[list[int], int]:
    values = []
    for _ in range(count):
        value, at = varint(data, at)
        values.append(value)
    return values, at


class Stream:
    def __init__(self, packed: memoryview, filters: list[dict[str, int]]) -> None:
        self.decoder = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=filters)
        self.packed: memoryview | bytes = packed
        self.decoded = bytearray()

    def until(self, want: int) -> bytearray:
        while len(self.decoded) < want and not self.decoder.eof:
            more = max(want - len(self.decoded), 4096)
            chunk = self.decoder.decompress(self.packed, more)
            self.packed = b""
            if not chunk and self.decoder.needs_input:
                raise ValueError("the block ends early")
            self.decoded += chunk
        return self.decoded


class Section:
    def __init__(self, view: memoryview, entry: dict[str, Any]) -> None:
        self.entry, self.count = entry, int(entry["count"])
        self.per_block, self.per_group = int(entry["block"]), int(entry["group"])
        self.fanout = self.per_block // self.per_group
        blocks, self.width = struct.unpack_from("<II", view)
        self.offsets = struct.unpack_from(f"<{blocks + 1}I", view, 8)
        at = 8 + 4 * (blocks + 1)
        self.keys = [int.from_bytes(view[head:head + self.width], "big")
                     for head in range(at, at + self.width * blocks, self.width or 1)]
        self.data = view[at + self.width * blocks:]
        context, position, matches = entry["lzma"]
        self.filters = [{"id": lzma.FILTER_LZMA1, "dict_size": WINDOW, "lc": context,
                         "lp": position, "pb": matches}]
        self.blocks: dict[int, Any] = {}
        self.groups: dict[int, list[Any]] = {}

    def block(self, index: int) -> Any:
        if index not in self.blocks:
            packed = self.data[self.offsets[index]:self.offsets[index + 1]]
            self.blocks[index] = self.opened(Stream(packed, self.filters), index)
        return self.blocks[index]

    def group(self, number: int) -> list[Any]:
        if number not in self.groups:
            self.groups[number] = self.values(number)
        return self.groups[number]

    def held(self, group: int) -> int:
        return min(self.per_group, self.count - group * self.per_group)

    def opened(self, stream: Stream, index: int) -> Any:
        return stream

    def values(self, group: int) -> list[Any]:
        raise NotImplementedError(group)

    def __getitem__(self, row: int) -> Any:
        index, place = divmod(row, self.per_block)
        stream = self.block(index)
        width, encoding = stream.until(1)[0], self.entry["encoding"]
        stop = 1 + (place + 1) * width
        codes = SIGNED if encoding in ("signed", "delta") else FORMATS
        values = array(codes[width], stream.until(stop)[1:stop])
        if sys.byteorder == "big":
            values.byteswap()
        return sum(values) if encoding == "delta" else values[place]


class Strings(Section):
    def opened(self, stream: Stream, index: int) -> Any:
        left = self.count - index * self.per_block
        total = min(self.fanout, -(-left // self.per_group)) - 1
        lengths, at = varints(stream.until(total * 3), 0, total)
        return stream, [*accumulate(lengths, initial=at), sys.maxsize]

    def values(self, group: int) -> list[Any]:
        index, at = divmod(group, self.fanout)
        stream, starts = self.block(index)
        raw, cursor = stream.until(starts[at + 1]), starts[at]
        values, previous = [], b""
        for _ in range(self.held(group)):
            shared = raw[cursor]
            fresh, cursor = varint(raw, cursor + 1)
            previous = previous[:shared] + raw[cursor:cursor + fresh]
            cursor += fresh
            values.append(previous.decode("utf-8", "replace"))
        return values

    def __getitem__(self, identifier: int) -> Any:
        group, place = divmod(identifier - 1, self.per_group)
        return self.group(group)[place] if identifier else ""


class Index(Section):
    def opened(self, stream: Stream, index: int) -> Any:
        raw = stream.until(3 + self.fanout * (8 if self.width == 4 else 22))
        count, at = varint(raw, 0)
        total = -(-count // self.per_group)
        gaps, at = varints(raw, at, total - 1)
        lengths, at = varints(raw, at, total - 1)
        heads = list(accumulate(gaps, initial=self.keys[index]))
        return heads, [*accumulate(lengths, initial=at), sys.maxsize], stream

    def values(self, group: int) -> list[Any]:
        index, at = divmod(group, self.fanout)
        heads, starts, stream = self.block(index)
        raw, size = stream.until(starts[at + 1]), self.held(group)
        host_bits = 0 if self.width == 4 else 64
        gaps, cursor = varints(raw, starts[at], size - 1)
        networks = list(accumulate(gaps, initial=heads[at] >> host_bits))
        if not host_bits:
            return networks
        hosts, _ = varints(raw, cursor, size)
        pairs = zip(networks, hosts, strict=True)
        return [network << host_bits | host for network, host in pairs]

    def __getitem__(self, row: int) -> Any:
        group, spot = divmod(row, self.per_group)
        return self.group(group)[spot]

    def row(self, address: int) -> int | None:
        index = bisect_right(self.keys, address) - 1
        if index < 0:
            return None
        group = index * self.fanout + bisect_right(self.block(index)[0], address) - 1
        spot = bisect_right(self.group(group), address) - 1
        return None if spot < 0 else group * self.per_group + spot

    def holds(self, address: int) -> int | None:
        row = self.row(address)
        return row if row is not None and self[row] == address else None


class Plevin:
    def __init__(self, path: str) -> None:
        with open(path, "rb") as handle:
            view = memoryview(mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ))
        if bytes(view[:len(MAGIC)]) != MAGIC or view[len(MAGIC)] != FORMAT:
            raise ValueError(f"{path} is not a plevin {FORMAT} database")
        size = struct.unpack_from("<I", view, len(MAGIC) + 1)[0]
        head = json.loads(bytes(view[len(MAGIC) + 5:len(MAGIC) + 5 + size]))
        body = len(MAGIC) + 5 + size
        kinds = {"index": Index, "front": Strings}
        self.sections: dict[str, Any] = {}
        for name, entry in head["sections"].items():
            at = body + entry["offset"]
            kind = kinds.get(entry["encoding"], Section)
            self.sections[name] = kind(view[at:at + entry["bytes"]], entry)
        books = head["vocabularies"]
        self.reads = READS | {field: self.worded(books[book])
                              for field, book in BOOKS.items() if book in books}
        self.tables: dict[str, list[tuple[int, str, Any, Any]]] = {}
        for name, section in self.sections.items():
            parts = name.split(".")
            if len(parts) == 3 and parts[0] in ("col", "link"):
                self.column(parts[0], parts[1], parts[2], section)
        for columns in self.tables.values():
            columns.sort(key=lambda column: column[0])
        self.answers: dict[str, Row | None] = {}

    def column(self, kind: str, table: str, field: str, section: Section) -> None:
        rank, read = self.reader(kind, f"{table}.{field}", section)
        self.tables.setdefault(table, []).append((rank, field, section, read))

    @staticmethod
    def worded(book: list[str]) -> Callable[[int], str]:
        return lambda code: book[code] if code < len(book) else ""

    def reader(self, kind: str, name: str, section: Section) -> tuple[int, Any]:
        if kind == "link":
            return 4, None
        if name in self.reads:
            return 3, self.reads[name]
        if section.entry["read"] == "text":
            return 1, self.sections["strings"].__getitem__
        if section.entry["read"]:
            return 2, lambda value: value / DEGREES
        return 0, lambda value: value

    def row(self, table: str, row: int) -> Row:
        out: Row = {}
        for _, field, section, read in self.tables.get(table, []):
            value = section[row]
            if read:
                out[field] = read(value)
            elif value:
                out[field] = self.row(field, value - 1)
        if "postal_partial" in out:
            out["postal_partial"] = out["postal"][:out["postal_partial"]]
        return out

    def answer(self, version: int, row: int, override: int) -> Row:
        out: Row = {}
        for name in CARRIED:
            column = self.sections.get(f"spine.v{version}.{name}")
            if column is None:
                continue
            value = override if override and name == "abuse" else column[row]
            if name not in LINKED:
                read = self.reads.get(name)
                out.setdefault("network", {})[name] = read(value) if read else value
            elif value:
                out[name] = self.row(name, value - 1)
        return out

    def found(self, text: str) -> Row | None:
        version = 6 if ":" in text else 4
        family = AF_INET6 if version == 6 else AF_INET
        address = int.from_bytes(inet_pton(family, text), "big")
        index = self.sections.get(f"spine.v{version}")
        row = None if index is None else index.row(address)
        if row is None:
            return None
        hosts = self.sections.get(f"hosts.v{version}")
        records = self.sections.get(f"hosts.v{version}.abuse")
        if hosts is None or records is None:
            return self.answer(version, row, 0)
        at = hosts.holds(address)
        return self.answer(version, row, 0 if at is None else records[at] + 1)

    def lookup(self, text: str) -> Row | None:
        if text not in self.answers:
            if len(self.answers) >= CACHED:
                self.answers.clear()
            self.answers[text] = self.found(text)
        return self.answers[text]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: plevin_mini.py path address")
    print(json.dumps(Plevin(sys.argv[1]).lookup(sys.argv[2]), indent=2))
