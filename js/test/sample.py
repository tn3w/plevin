import json
import random
import sys
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone

sys.path.insert(0, "../python")
import plevin  # noqa: E402

MOMENT = datetime(2026, 3, 29, 12, 30, 0, tzinfo=timezone.utc)


def addresses(count: int) -> list[str]:
    random.seed(7)
    held = [
        "1.1.1.1", "8.8.8.8", "185.220.101.1", "9.9.9.9", "0.0.0.0",
        "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "192.0.2.1",
        "198.18.0.1", "224.0.0.1", "255.255.255.255", "203.0.113.9",
        "2606:4700::1111", "2001:4860:4860::8888", "::1", "::",
        "::ffff:8.8.8.8", "2002:808:808::1", "64:ff9b::808:808",
        "2001:0:5ef5:79fd:0:59d:a862:7d7e", "fe80::1", "fc00::1", "ff02::1",
        "2001:db8::1", "3fff::1",
    ]
    for _ in range(count):
        held.append(".".join(str(random.randrange(256)) for _ in range(4)))
    for _ in range(count // 4):
        groups = [f"{random.randrange(1 << 16):x}" for _ in range(8)]
        held.append(":".join(groups))
    return held


def plain(found: object) -> dict[str, object]:
    held = asdict(found)  # type: ignore[call-overload]
    held["number"] = str(held["number"])
    return held


plevin.use(sys.argv[1])
count = int(sys.argv[2]) if len(sys.argv) > 2 else 400
out = {ip: plain(plevin.lookup(ip, MOMENT)) for ip in addresses(count)}
print(json.dumps(out, indent=1, ensure_ascii=False, sort_keys=True))
