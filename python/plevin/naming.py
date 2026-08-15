"""What DNS says about an address, written on the wire, every server asked at once."""

from __future__ import annotations

import random
import select
import socket
import struct
import sys
from collections.abc import Iterable
from importlib import import_module
from ipaddress import ip_address
from time import monotonic
from typing import Any

from .address import parse, spelled, tunnel
from .models import Dns

PUBLIC_SERVERS = ("1.1.1.1", "8.8.8.8", "9.9.9.9")
RESOLV_CONF = "/etc/resolv.conf"
PORT = 53
REGISTRY = r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces"
TIMEOUT = 2.0
KEPT = 4096
KEPT_FOR = 3600.0
PAYLOAD = 1232
ANSWERED = (0, 3)

KINDS = {"A": 1, "CNAME": 5, "SOA": 6, "PTR": 12, "AAAA": 28}
NAMED = (KINDS["CNAME"], KINDS["PTR"])

Question = tuple[str, str, str]
Record = dict[str, Any]
Reply = dict[str, Any]
Found = Reply | None
Waiting = dict[socket.socket, tuple[int, int, str, bytes]]


def usable(candidates: Iterable[str]) -> list[str]:
    """The candidates that are addresses a socket can reach without a scope id."""
    servers = []
    for candidate in candidates:
        try:
            address = ip_address(candidate.split("%")[0].strip("[]"))
        except ValueError:
            continue

        if not address.is_link_local:
            servers.append(str(address))

    return servers


def resolv_conf_servers() -> list[str]:
    """What every unix writes down, systemd and dnsmasq stubs included."""
    try:
        with open(RESOLV_CONF, encoding="utf-8") as file:
            lines = file.read().splitlines()
    except OSError:
        return []

    words = [line.split("#")[0].split() for line in lines]
    return [word[1] for word in words if len(word) > 1 and word[0] == "nameserver"]


def interface_servers(interface: Any) -> list[str]:
    winreg = import_module("winreg")
    found = []
    with interface:
        for name in ("NameServer", "DhcpNameServer"):
            try:
                value = winreg.QueryValueEx(interface, name)[0]
            except OSError:
                continue

            found += str(value).replace(",", " ").split()

    return found


def registry_servers() -> list[str]:
    """What Windows keeps per interface, set by hand or handed out by DHCP."""
    winreg = import_module("winreg")
    found = []
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, REGISTRY) as interfaces:
        for index in range(winreg.QueryInfoKey(interfaces)[0]):
            name = winreg.EnumKey(interfaces, index)
            found += interface_servers(winreg.OpenKey(interfaces, name))

    return found


def system_servers() -> list[str]:
    """The servers the machine itself uses, wherever this machine keeps them."""
    finding = registry_servers if sys.platform == "win32" else resolv_conf_servers
    try:
        return usable(finding())
    except OSError:
        return []


SERVERS = list(dict.fromkeys(system_servers() + list(PUBLIC_SERVERS)))


def encode_query(name: str, kind: str, ident: int) -> bytes:
    """One question, recursion asked for, DNSSEC status asked for, EDNS0 announced."""
    labels = [label.encode() for label in name.rstrip(".").split(".") if label]
    question = b"".join(bytes([len(label)]) + label for label in labels) + b"\0"
    header = struct.pack("!HHHHHH", ident, 0x0120, 1, 0, 0, 1)
    return (
        header
        + question
        + struct.pack("!HH", KINDS[kind], 1)
        + b"\0"
        + struct.pack("!HHIH", 41, PAYLOAD, 0, 0)
    )


def read_name(message: bytes, at: int) -> tuple[str, int]:
    """A name, following compression pointers, and where the record goes on."""
    labels: list[str] = []
    after = None
    for _ in range(128):
        length = message[at]
        if length >= 0xC0:
            after = at + 2 if after is None else after
            at = struct.unpack_from("!H", message, at)[0] & 0x3FFF
            continue

        at += 1
        if not length:
            return ".".join(labels), at if after is None else after

        labels.append(message[at : at + length].decode("ascii", "replace").lower())
        at += length

    raise ValueError("name loops")


def read_data(message: bytes, at: int, kind: int) -> str:
    if kind == KINDS["A"]:
        return socket.inet_ntop(socket.AF_INET, message[at : at + 4])

    if kind == KINDS["AAAA"]:
        return socket.inet_ntop(socket.AF_INET6, message[at : at + 16])

    if kind in NAMED:
        return read_name(message, at)[0]

    if kind == KINDS["SOA"]:
        primary, at = read_name(message, at)
        return f"{primary} {read_name(message, at)[0]}"

    return ""


def decode(message: bytes) -> Reply:
    """A reply as its header bits, its answers and the zone that owns them."""
    ident, flags, questions, *counts = struct.unpack_from("!HHHHHH", message, 0)
    at = 12
    for _ in range(questions):
        _, at = read_name(message, at)
        at += 4

    sections = []
    for count in counts[:2]:
        records = []
        for _ in range(count):
            name, at = read_name(message, at)
            kind, _, _, length = struct.unpack_from("!HHIH", message, at)
            at += 10
            records.append({"name": name, "kind": kind,
                            "data": read_data(message, at, kind)})
            at += length
        sections.append(records)

    return {
        "ident": ident,
        "code": flags & 15,
        "authentic": bool(flags & 0x20),
        "truncated": bool(flags & 0x200),
        "answer": sections[0],
        "authority": sections[1],
    }


def records(reply: Found, kind: str, section: str = "answer") -> list[Record]:
    if reply is None:
        return []

    found = reply["answer"] + reply["authority"] if section == "any" else reply[section]
    return [record for record in found if record["kind"] == KINDS[kind]]


def answers(reply: Found, kind: str) -> list[str]:
    return [record["data"] for record in records(reply, kind)]


def datagram(server: str, query: bytes) -> socket.socket:
    family = socket.AF_INET6 if ":" in server else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_DGRAM)
    try:
        sock.setblocking(False)
        sock.connect((server, PORT))
        sock.send(query)
    except OSError:
        sock.close()
        raise

    return sock


def over_tcp(server: str, query: bytes) -> bytes:
    """The same question again where the datagram came back cut short."""
    with socket.create_connection((server, PORT), TIMEOUT) as sock:
        sock.sendall(struct.pack("!H", len(query)) + query)
        size = struct.unpack("!H", exactly(sock, 2))[0]
        return exactly(sock, size)


def exactly(sock: socket.socket, size: int) -> bytes:
    held = b""
    while len(held) < size:
        piece = sock.recv(size - len(held))
        if not piece:
            raise OSError("the server hung up")
        held += piece

    return held


def taken(sock: socket.socket, ident: int, server: str, query: bytes) -> Found:
    try:
        reply = decode(sock.recv(4096))
        if reply["ident"] != ident or reply["code"] not in ANSWERED:
            return None
        return decode(over_tcp(server, query)) if reply["truncated"] else reply
    except (OSError, IndexError, ValueError, struct.error):
        return None


def asked(waiting: Waiting, questions: list[Question]) -> list[Found]:
    """Every question at every server at once, each answered by whoever is first."""
    replies: list[Found] = [None] * len(questions)
    spare: list[Found] = [None] * len(questions)
    deadline = monotonic() + TIMEOUT
    while waiting and None in replies:
        left = deadline - monotonic()
        ready = select.select(list(waiting), [], [], left)[0] if left > 0 else []
        if not ready:
            break

        for sock in ready:
            index, ident, server, query = waiting.pop(sock)
            reply = taken(sock, ident, server, query)
            sock.close()
            wanted = questions[index][2]
            if reply is None or replies[index] is not None:
                continue
            if not wanted or records(reply, wanted, "any"):
                replies[index] = reply
            elif spare[index] is None:
                spare[index] = reply

    for sock in waiting:
        sock.close()

    return [reply or spare[index] for index, reply in enumerate(replies)]


def resolve(questions: list[Question]) -> list[Found]:
    """Each question sent to every server, all of them in flight together."""
    waiting: Waiting = {}
    for index, (name, kind, _) in enumerate(questions):
        ident = random.randrange(65536)
        query = encode_query(name, kind, ident)
        for server in SERVERS:
            try:
                waiting[datagram(server, query)] = (index, ident, server, query)
            except OSError:
                continue

    return asked(waiting, questions)


def zone_of(reply: Found, found: Dns) -> None:
    soa = records(reply, "SOA", "any")
    if not soa:
        return

    primary, contact = soa[0]["data"].split(" ")
    local, _, domain = contact.partition(".")
    found.zone = soa[0]["name"]
    found.zone_primary = primary
    found.zone_contact = f"{local}@{domain}" if domain else contact


def facts(value: int, wide: bool) -> Dns:
    """Everything DNS says about the address, in two rounds of questions."""
    embedded = tunnel(value, wide)[1]
    if embedded is not None:
        value, wide = parse(embedded)

    text, _, arpa = spelled(value, wide)
    reverse, zone = resolve([(arpa, "PTR", ""), (arpa, "SOA", "SOA")])
    found = Dns(asked=text, is_signed=bool(reverse and reverse["authentic"]))
    zone_of(zone, found)

    hostnames = answers(reverse, "PTR")
    if not hostnames:
        return found

    found.hostname, found.hostnames = hostnames[0], tuple(hostnames)
    forward_v4, forward_v6 = resolve([(hostnames[0], "A", ""),
                                      (hostnames[0], "AAAA", "")])
    forward = answers(forward_v4, "A"), answers(forward_v6, "AAAA")
    found.ipv4_addresses, found.ipv6_addresses = tuple(forward[0]), tuple(forward[1])
    found.ipv4 = forward[0][0] if forward[0] else None
    found.ipv6 = forward[1][0] if forward[1] else None

    aliases = answers(forward_v4, "CNAME") + answers(forward_v6, "CNAME")
    found.alias = aliases[0] if aliases else None
    found.is_confirmed = value in {parse(one)[0] for one in forward[0] + forward[1]}
    return found


HELD: dict[tuple[int, bool], tuple[float, Dns]] = {}


def named(value: int, wide: bool) -> Dns:
    """The same address answered from memory for an hour before asking again."""
    key = (value, wide)
    held = HELD.get(key)
    if held is not None and held[0] > monotonic():
        return held[1]

    found = facts(value, wide)
    if len(HELD) >= KEPT:
        HELD.clear()

    HELD[key] = (monotonic() + KEPT_FOR, found)
    return found
