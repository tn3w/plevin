"""The wire the resolver speaks, answered by a server that never leaves the machine."""

from __future__ import annotations

import socket
import struct
import sys
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest

from plevin import naming
from plevin.address import parse

GOOGLE = bytes([8, 8, 8, 8])
LOOPBACK = bytes(15) + b"\x01"
Answer = Callable[[bytes], bytes | None]


def record(kind: int, data: bytes) -> bytes:
    return b"\xc0\x0c" + struct.pack("!HHIH", kind, 1, 300, len(data)) + data


def replied(query: bytes, records: bytes = b"", answers: int = 0,
            authorities: int = 0, flags: int = 0x8180) -> bytes:
    """The question read back with records under it, the way a server answers."""
    end = query.index(b"\0", 12) + 5
    ident = struct.unpack_from("!H", query)[0]
    header = struct.pack("!HHHHHH", ident, flags, 1, answers, authorities, 0)
    return header + query[12:end] + records


def question_of(query: bytes) -> tuple[str, int]:
    name, at = naming.read_name(query, 12)
    return name, struct.unpack_from("!H", query, at)[0]


class Stub:
    """A resolver on the loopback, answering only what a test has written down."""

    def __init__(self, table: dict[tuple[str, int], Answer]) -> None:
        self.table = table
        self.datagrams = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.datagrams.bind(("", 0))
        self.stream = socket.create_server(("", self.port))
        self.running = True
        self.streamed = False
        self.threads = [threading.Thread(target=run, args=(self,), daemon=True)
                        for run in (over_datagrams, over_stream)]
        for thread in self.threads:
            thread.start()

    @property
    def port(self) -> int:
        return int(self.datagrams.getsockname()[1])

    def answer(self, query: bytes) -> bytes | None:
        held = self.table.get(question_of(query))
        return None if held is None else held(query)

    def close(self) -> None:
        self.running = False
        self.datagrams.close()
        self.stream.close()


def over_datagrams(stub: Stub) -> None:
    while stub.running:
        try:
            query, sender = stub.datagrams.recvfrom(4096)
        except OSError:
            return
        stub.streamed = False
        answer = stub.answer(query)
        if answer is not None:
            stub.datagrams.sendto(answer, sender)


def over_stream(stub: Stub) -> None:
    while stub.running:
        try:
            held, _ = stub.stream.accept()
        except OSError:
            return
        with held:
            size = struct.unpack("!H", naming.exactly(held, 2))[0]
            stub.streamed = True
            answer = stub.answer(naming.exactly(held, size))
            if answer is not None:
                held.sendall(struct.pack("!H", len(answer)) + answer)


@pytest.fixture
def stub(request: pytest.FixtureRequest) -> Iterator[Stub]:
    """A stub the module asks instead of the internet, put back afterwards."""
    held = Stub(getattr(request, "param", {}))
    servers, port = naming.SERVERS, naming.PORT
    naming.SERVERS, naming.PORT = ["127.0.0.1"], held.port
    naming.HELD.clear()
    yield held
    naming.SERVERS, naming.PORT = servers, port
    held.close()


REVERSE = "8.8.8.8.in-addr.arpa"
SOA_DATA = (b"\x03ns1\x06google\x03com\x00\x03dns\x06google\x03com\x00"
            + struct.pack("!IIIII", *(1,) * 5))
GOOGLE_DNS: dict[tuple[str, int], Answer] = {
    (REVERSE, 12): lambda query: replied(query, record(12, b"\x03dns\xc0\x0c"), 1,
                                         flags=0x81A0),
    (REVERSE, 6): lambda query: replied(query, record(6, SOA_DATA), authorities=1),
    ("dns.8.8.8.8.in-addr.arpa", 1): lambda query: replied(
        query, record(5, b"\x03www\xc0\x0c") + record(1, GOOGLE), 2),
    ("dns.8.8.8.8.in-addr.arpa", 28): lambda query: replied(
        query, record(28, LOOPBACK), 1),
}


def test_a_question_is_written_as_labels_with_an_edns_hint() -> None:
    query = naming.encode_query("example.com", "A", 1234)
    assert query[:2] == struct.pack("!H", 1234)
    assert query[12:25] == b"\x07example\x03com\x00"
    assert struct.unpack_from("!HH", query, 25) == (1, 1)
    assert struct.unpack_from("!HH", query, 30) == (41, naming.PAYLOAD)


def test_a_reply_reads_back_as_the_records_it_carries() -> None:
    query = naming.encode_query("example.com", "A", 7)
    answer = record(1, GOOGLE) + record(28, LOOPBACK) + record(2, b"\x02ns\xc0\x0c")
    reply = naming.decode(replied(query, answer, 3))
    assert naming.answers(reply, "A") == ["8.8.8.8"]
    assert naming.answers(reply, "AAAA") == ["::1"]
    assert reply["code"] == 0 and not reply["truncated"] and not reply["authentic"]


def test_a_name_that_points_at_itself_is_refused() -> None:
    with pytest.raises(ValueError, match="loops"):
        naming.read_name(b"\xc0\x0c" * 200, 0)


def test_the_servers_a_machine_uses_are_addresses_without_a_scope() -> None:
    held = ["1.1.1.1", "fe80::1%eth0", "[2606:4700::1111]", "nope", ""]
    assert naming.usable(held) == ["1.1.1.1", "2606:4700::1111"]


def test_a_machine_without_a_resolver_file_asks_the_public_servers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(naming, "RESOLV_CONF", str(tmp_path / "missing"))
    assert naming.system_servers() == []
    written = tmp_path / "resolv.conf"
    written.write_text("# a comment\nnameserver\t1.1.1.1 # ours\nsearch lan\n")
    monkeypatch.setattr(naming, "RESOLV_CONF", str(written))
    assert naming.system_servers() == ["1.1.1.1"]


@pytest.mark.parametrize("stub", [GOOGLE_DNS], indirect=True)
def test_an_address_is_answered_by_the_name_it_points_at(stub: Stub) -> None:
    found = naming.facts(*parse("8.8.8.8"))
    assert found.asked == "8.8.8.8"
    assert (found.hostname, found.hostnames) == ("dns.8.8.8.8.in-addr.arpa",
                                                 ("dns.8.8.8.8.in-addr.arpa",))
    assert found.ipv4 == "8.8.8.8" and found.ipv6 == "::1"
    assert found.alias == "www.dns.8.8.8.8.in-addr.arpa"
    assert found.is_confirmed and found.is_signed
    assert found.zone == REVERSE
    assert (found.zone_primary, found.zone_contact) == ("ns1.google.com",
                                                        "dns@google.com")


@pytest.mark.parametrize("stub", [GOOGLE_DNS], indirect=True)
def test_a_tunnel_is_asked_about_as_the_address_it_carries(stub: Stub) -> None:
    found = naming.facts(*parse("::ffff:8.8.8.8"))
    assert found.asked == "8.8.8.8" and found.hostname == "dns.8.8.8.8.in-addr.arpa"


@pytest.mark.parametrize("stub", [{}], indirect=True)
def test_a_server_that_says_nothing_leaves_the_address_unnamed(stub: Stub) -> None:
    found = naming.facts(*parse("8.8.8.8"))
    assert found.hostname is None and found.zone is None
    assert not found.is_confirmed and not found.is_signed


@pytest.mark.parametrize("stub", [{
    (REVERSE, 12): lambda query: replied(query, record(12, b"\x03dns\xc0\x0c"), 1),
    (REVERSE, 6): lambda query: replied(query),
    ("dns.8.8.8.8.in-addr.arpa", 1): lambda query: b"\xff",
    ("dns.8.8.8.8.in-addr.arpa", 28): lambda query: replied(query, flags=0x8182),
}], indirect=True)
def test_a_reply_that_says_too_little_is_taken_for_what_it_says(stub: Stub) -> None:
    found = naming.facts(*parse("8.8.8.8"))
    assert found.hostname == "dns.8.8.8.8.in-addr.arpa"
    assert found.zone is None and found.ipv4 is None and found.ipv6 is None


@pytest.mark.parametrize("stub", [GOOGLE_DNS], indirect=True)
def test_an_answer_cut_short_is_asked_again_over_a_stream(stub: Stub) -> None:
    whole = GOOGLE_DNS[(REVERSE, 12)]
    stub.table = dict(GOOGLE_DNS)
    stub.table[(REVERSE, 12)] = lambda query: (
        whole(query) if stub.streamed else replied(query, flags=0x8380))
    found = naming.facts(*parse("8.8.8.8"))
    assert found.hostname == "dns.8.8.8.8.in-addr.arpa" and found.ipv4 == "8.8.8.8"


@pytest.mark.parametrize("stub", [GOOGLE_DNS], indirect=True)
def test_a_server_that_cannot_be_reached_is_passed_over(stub: Stub) -> None:
    naming.SERVERS = ["255.255.255.256", "127.0.0.1"]
    assert naming.facts(*parse("8.8.8.8")).ipv4 == "8.8.8.8"


@pytest.mark.parametrize("stub", [GOOGLE_DNS], indirect=True)
def test_the_same_address_is_answered_from_memory_before_asking_again(
    stub: Stub, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(naming, "KEPT", 1)
    first = naming.named(*parse("8.8.8.8"))
    assert naming.named(*parse("8.8.8.8")) is first
    naming.named(*parse("1.1.1.1"))
    assert naming.named(*parse("8.8.8.8")) is not first


class Key:
    """One registry key, holding values a machine set and keys below it."""

    def __init__(self, values: dict[str, str] | None = None,
                 children: dict[str, Key] | None = None) -> None:
        self.values = values or {}
        self.children = children or {}

    def __enter__(self) -> Key:
        return self

    def __exit__(self, *rest: object) -> None:
        return None


def registry(children: dict[str, Key]) -> SimpleNamespace:
    root = Key(children=children)

    def query_value(key: Key, name: str) -> tuple[str, int]:
        if name not in key.values:
            raise OSError(name)
        return key.values[name], 1

    return SimpleNamespace(
        HKEY_LOCAL_MACHINE=0,
        OpenKey=lambda parent, name: root if isinstance(parent, int)
        else parent.children[name],
        QueryInfoKey=lambda key: (len(key.children), 0, 0),
        EnumKey=lambda key, index: list(key.children)[index],
        QueryValueEx=query_value,
    )


def test_windows_keeps_the_servers_of_every_interface(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(sys.modules, "winreg", registry({
        "{one}": Key({"NameServer": "1.1.1.1,9.9.9.9"}),
        "{two}": Key({"DhcpNameServer": "192.168.2.1 fe80::1"}),
    }))
    monkeypatch.setattr(sys, "platform", "win32")
    assert naming.system_servers() == ["1.1.1.1", "9.9.9.9", "192.168.2.1"]


def test_a_registry_that_will_not_open_leaves_the_public_servers(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*rest: object) -> None:
        raise OSError("no registry here")

    monkeypatch.setitem(sys.modules, "winreg", SimpleNamespace(
        HKEY_LOCAL_MACHINE=0, OpenKey=refuse))
    monkeypatch.setattr(sys, "platform", "win32")
    assert naming.system_servers() == []


@pytest.mark.parametrize("stub", [{
    (REVERSE, 12): lambda query: replied(query, record(12, b"\x03dns\xc0\x0c"), 1),
    (REVERSE, 6): lambda query: replied(query),
}], indirect=True)
def test_a_second_server_saying_as_little_as_the_first_adds_nothing(stub: Stub) -> None:
    naming.SERVERS = ["127.0.0.1", "127.0.0.1"]
    found = naming.facts(*parse("8.8.8.8"))
    assert found.hostname == "dns.8.8.8.8.in-addr.arpa" and found.zone is None


@pytest.mark.parametrize("stub", [{
    (REVERSE, 12): lambda query: replied(query, flags=0x8380),
    (REVERSE, 6): lambda query: replied(query, record(6, SOA_DATA), authorities=1),
}], indirect=True)
def test_a_server_that_hangs_up_mid_answer_says_nothing(stub: Stub) -> None:
    stub.table[(REVERSE, 12)] = lambda query: (
        None if stub.streamed else replied(query, flags=0x8380))
    found = naming.facts(*parse("8.8.8.8"))
    assert found.hostname is None and found.zone == REVERSE
