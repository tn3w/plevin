"""A writer for the format, small enough to build a database a test can reason about."""

from __future__ import annotations

import json
import struct
from array import array
from itertools import pairwise
from typing import Any

try:
    from compression.zstd import compress, train_dict
except ImportError:
    from pyzstd import compress, train_dict  # type: ignore[assignment]

MAGIC = b"PLEVIN\0"
FORMAT = 1
FORMATS = {1: "B", 2: "H", 4: "I", 8: "Q"}
SIGNED = {1: "b", 2: "h", 4: "i", 8: "q"}


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | 0x80 if value else byte)
        if not value:
            return bytes(out)


def varints(values: list[int]) -> bytes:
    return b"".join(varint(value) for value in values)


def chunks(values: list[Any], size: int) -> list[list[Any]]:
    return [values[at:at + size] for at in range(0, len(values), size)]


def stepped(values: list[int]) -> list[int]:
    """A block of deltas, which is what a reader sums back into the values."""
    return [value - before for before, value in pairwise([0, *values])]


def item(values: list[int], signed: bool) -> int:
    low, high = min(values, default=0), max(values, default=0)
    for size in (1, 2, 4, 8):
        bits = size * 8 - signed
        floor = -(1 << bits) if signed else 0
        if floor <= low and high < (1 << bits):
            return size
    raise ValueError("too wide")


def wrap(blocks: list[bytes], keys: list[bytes], width: int, book: bytes) -> bytes:
    offsets, at = [0], 0
    for block in blocks:
        at += len(block)
        offsets.append(at)
    head = struct.pack("<III", len(blocks), width, len(book))
    head += struct.pack(f"<{len(offsets)}I", *offsets)
    return head + b"".join(keys) + book + b"".join(blocks)


def squeeze(blocks: list[bytes], dictionary: bool) -> tuple[list[bytes], bytes]:
    if not dictionary:
        return [compress(block) for block in blocks], b""
    trained = train_dict(blocks * 40, 1024)
    packed = [compress(block, zstd_dict=trained) for block in blocks]
    return packed, trained.dict_content


class Writer:
    """Sections in, one database out; nothing here is fast and nothing needs to be."""

    def __init__(self, block: int = 8, group: int = 4) -> None:
        self.block, self.group = block, group
        self.sections: dict[str, tuple[dict[str, Any], bytes]] = {}
        self.vocabularies: dict[str, list[str]] = {}

    def _add(self, name: str, entry: dict[str, Any], body: bytes) -> None:
        self.sections[name] = (entry, body)

    def column(self, name: str, values: list[int], read: str = "",
               signed: bool = False, dictionary: bool = False,
               delta: bool = False) -> None:
        held = [stepped(chunk) for chunk in chunks(values, self.block)] if delta else \
            chunks(values, self.block)
        size = item([value for chunk in held for value in chunk], signed or delta)
        code = (SIGNED if signed or delta else FORMATS)[size]
        blocks = [bytes([size]) + array(code, chunk).tobytes() for chunk in held]
        packed, book = squeeze(blocks or [b""], dictionary)
        encoding = "delta" if delta else "signed" if signed else ""
        entry = {"count": len(values), "read": read, "block": self.block,
                 "group": self.group, "encoding": encoding}
        self._add(name, entry, wrap(packed, [], 0, book))

    def strings(self, name: str, values: list[str]) -> None:
        blocks = []
        for chunk in chunks(values, self.block):
            groups = [self._group(part) for part in chunks(chunk, self.group)]
            lengths = varints([len(part) for part in groups[:-1]])
            blocks.append(lengths + b"".join(groups))
        packed, book = squeeze(blocks or [b""], False)
        entry = {"count": len(values), "read": "", "block": self.block,
                 "group": self.group, "encoding": "front"}
        self._add(name, entry, wrap(packed, [], 0, book))

    def _group(self, values: list[str]) -> bytes:
        out, previous = bytearray(), b""
        for value in values:
            held = value.encode()
            shared = 0
            while (shared < min(len(previous), len(held), 255)
                   and previous[shared] == held[shared]):
                shared += 1
            out += bytes([shared]) + varint(len(held) - shared) + held[shared:]
            previous = held
        return bytes(out)

    def index(self, name: str, addresses: list[int], wide: bool, skew: int = 0) -> None:
        width = 16 if wide else 4
        host_bits = 64 if wide else 0
        blocks, keys = [], []
        for chunk in chunks(addresses, self.block):
            keys.append(chunk[0].to_bytes(width, "big"))
            groups = chunks(chunk, self.group)
            heads = [part[0] for part in groups]
            gaps = [after - before for before, after in pairwise(heads)]
            payloads = [self._payload(part, host_bits, skew) for part in groups]
            lengths = varints([len(part) for part in payloads[:-1]])
            blocks.append(varint(len(chunk)) + varints(gaps) + lengths
                          + b"".join(payloads))
        packed, book = squeeze(blocks or [b""], False)
        entry = {"count": len(addresses), "read": "", "block": self.block,
                 "group": self.group, "encoding": "index"}
        self._add(name, entry, wrap(packed, keys, width, book))

    def _payload(self, addresses: list[int], host_bits: int, skew: int = 0) -> bytes:
        """A skew stores hosts the group head does not name, which no builder writes."""
        networks = [value >> host_bits for value in addresses]
        gaps = varints([after - before for before, after in pairwise(networks)])
        if not host_bits:
            return gaps
        hosts = [value & (1 << host_bits) - 1 for value in addresses]
        return gaps + varints([hosts[0] + skew, *hosts[1:]])

    def build(self, **head: Any) -> bytes:
        body, entries, at = bytearray(), {}, 0
        for name, (entry, packed) in self.sections.items():
            entries[name] = {**entry, "offset": at, "bytes": len(packed)}
            body += packed
            at += len(packed)
        head = {"format": FORMAT, "built": "2026-08-13", "selection": "full",
                "length": len(body), "carries": [True, True, True], "fields": [],
                "vocabularies": self.vocabularies, "sections": entries, **head}
        written = json.dumps(head).encode()
        return MAGIC + bytes([FORMAT]) + struct.pack("<I", len(written)) + written + body
