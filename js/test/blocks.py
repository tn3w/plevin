import hashlib
import json
import struct
import sys

sys.path.insert(0, "../python")
from plevin.reader import _unpacker  # noqa: E402

data = memoryview(open(sys.argv[1], "rb").read())
size = struct.unpack_from("<I", data, 8)[0]
head = json.loads(bytes(data[12 : 12 + size]))
body = 12 + size
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 3

digests = {}
for name, entry in head["sections"].items():
    at = body + entry["offset"]
    blocks, width, book = struct.unpack_from("<III", data, at)
    offsets = struct.unpack_from(f"<{blocks + 1}I", data, at + 12)
    start = at + 12 + 4 * (blocks + 1) + width * blocks
    unpack = _unpacker(data[start : start + book])
    held = start + book
    digest = hashlib.sha256()
    for index in range(min(blocks, limit)):
        digest.update(unpack(data[held + offsets[index] : held + offsets[index + 1]]))
    digests[name] = digest.hexdigest()

print(json.dumps(digests, indent=1))
