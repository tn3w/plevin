import hashlib
import json
import struct
import sys

sys.path.insert(0, "../python")
from plevin.reader import Stream, _filters  # noqa: E402

data = memoryview(open(sys.argv[1], "rb").read())
size = struct.unpack_from("<I", data, 8)[0]
head = json.loads(bytes(data[12 : 12 + size]))
body = 12 + size
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 3

digests = {}
for name, entry in head["sections"].items():
    at = body + entry["offset"]
    blocks, width = struct.unpack_from("<II", data, at)
    offsets = struct.unpack_from(f"<{blocks + 1}I", data, at + 8)
    held = at + 8 + 4 * (blocks + 1) + width * blocks
    filters = _filters(entry["lzma"])
    digest = hashlib.sha256()
    for index in range(min(blocks, limit)):
        packed = data[held + offsets[index] : held + offsets[index + 1]]
        digest.update(Stream(packed, filters).until(sys.maxsize))
    digests[name] = digest.hexdigest()

print(json.dumps(digests, indent=1))
