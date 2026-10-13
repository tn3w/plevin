"""Checks every port against plevin_mini.py, field for field, address by address."""

from __future__ import annotations

import json
import random
import subprocess
import sys
from ipaddress import IPv4Address, IPv6Address
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
MINI = HERE.parent / "plevin_mini.py"

PORTS = {
    "c": (["gcc", "-O2", "-o", "{build}/c", "plevin.c"], ["{build}/c"]),
    "cpp": (
        ["g++", "-O2", "-std=c++23", "-o", "{build}/cpp", "plevin.cpp"],
        ["{build}/cpp"],
    ),
    "rust": (
        ["rustc", "--edition", "2024", "-O", "-o", "{build}/rust", "plevin.rs"],
        ["{build}/rust"],
    ),
    "go": (["go", "build", "-o", "{build}/go", "plevin.go"], ["{build}/go"]),
    "java": (
        ["javac", "-d", "{build}/java", "Plevin.java"],
        ["java", "-cp", "{build}/java", "Plevin"],
    ),
    "kotlin": (
        ["kotlinc", "plevin.kt", "-include-runtime", "-d", "{build}/kotlin.jar"],
        ["java", "-jar", "{build}/kotlin.jar"],
    ),
    "csharp": (
        ["dotnet", "build", "plevin.cs", "-c", "Release", "-o", "{build}/csharp"],
        ["{build}/csharp/plevin"],
    ),
    "php": (None, ["php", "plevin.php"]),
    "perl": (None, ["perl", "plevin.pl"]),
    "ruby": (None, ["ruby", "plevin.rb"]),
    "lua": (None, ["lua5.4", "plevin.lua"]),
    "elixir": (None, ["elixir", "plevin.exs"]),
}

FIXED = [
    "1.1.1.1",
    "8.8.8.8",
    "6.6.6.6",
    "2.2.2.2",
    "9.9.9.9",
    "185.220.101.1",
    "66.249.66.1",
    "18.9.1.1",
    "45.33.32.156",
    "104.16.0.1",
    "203.0.113.1",
    "10.0.0.1",
    "0.197.62.223",
    "255.255.255.255",
    "0.0.0.0",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:80b::200e",
    "2001:db8::1",
    "::1",
    "::",
    "ffff::1",
]


def addresses(count: int) -> list[str]:
    chance = random.Random(2026)
    fours = [str(IPv4Address(chance.getrandbits(32))) for _ in range(count)]
    sixes = [
        str(IPv6Address(0x2 << 124 | chance.getrandbits(125) >> 2)) for _ in range(count)
    ]
    return FIXED + fours + sixes


def run(command: list[str], database: str, address: str) -> object:
    done = subprocess.run(
        [*command, database, address],
        cwd=HERE,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if done.returncode:
        return f"exit {done.returncode}: {done.stderr.strip()[-300:]}"
    try:
        return json.loads(done.stdout)
    except json.JSONDecodeError:
        return f"not json: {done.stdout[:300]}"


def expand(parts: list[str]) -> list[str]:
    return [part.format(build=BUILD) for part in parts]


def build(name: str) -> list[str] | None:
    compile_with, command = PORTS[name]
    if compile_with is None:
        return expand(command)
    done = subprocess.run(
        expand(compile_with), cwd=HERE, capture_output=True, text=True, check=False
    )
    if done.returncode:
        print(f"{name}: build failed\n{done.stdout[-2000:]}{done.stderr[-2000:]}")
        return None
    return expand(command)


def differences(expected: object, found: object, path: str = "") -> list[str]:
    if isinstance(expected, dict) and isinstance(found, dict):
        keys = sorted(expected.keys() | found.keys())
        return [
            line
            for key in keys
            for line in differences(
                expected.get(key, "<absent>"), found.get(key, "<absent>"), f"{path}.{key}"
            )
        ]
    if expected == found and type(expected) is type(found):
        return []
    numbers = isinstance(expected, float) and isinstance(found, int | float)
    if numbers and abs(expected - found) < 1e-9:
        return []
    return [f"{path or '.'}: {expected!r} != {found!r}"]


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("usage: compare.py database [port ...] [--count N]")
    arguments = sys.argv[1:]
    count = 20
    if "--count" in arguments:
        at = arguments.index("--count")
        count = int(arguments[at + 1])
        del arguments[at : at + 2]
    database = str(Path(arguments[0]).resolve())
    chosen = arguments[1:] or list(PORTS)
    BUILD.mkdir(exist_ok=True)
    wanted = addresses(count)
    truth = {
        address: run([sys.executable, "-I", str(MINI)], database, address)
        for address in wanted
    }
    failed = 0
    for name in chosen:
        command = build(name)
        if command is None:
            failed += 1
            continue
        wrong = {}
        for address in wanted:
            lines = differences(truth[address], run(command, database, address))
            if lines:
                wrong[address] = lines
        print(f"{name}: {len(wanted) - len(wrong)}/{len(wanted)} match")
        for address, lines in list(wrong.items())[:5]:
            print(f"  {address}")
            for line in lines[:8]:
                print(f"    {line}")
        failed += bool(wrong)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
