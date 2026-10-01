import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compress } from "../src/compress.ts";
import { Plevin } from "../src/index.ts";
import { decompress, type Tuning } from "../src/lzma.ts";
import { fileName, Slimmer, slim } from "../src/slim.ts";

const PATH = process.env.PLEVIN_DB ?? "../plevin.plv";
const RAW = process.env.PLEVIN_RAW ?? "../plevin.raw";
const BIGGEST = 8_000_000;
const held = {
  skip: (!existsSync(PATH) || !existsSync(RAW)) && "no database beside the package",
};
const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const builtBeside = (): string[] =>
  existsSync(RAW)
    ? readdirSync(dirname(RAW))
        .filter((name) => /^plevin\..+\.plv$/.test(name))
        .map((name) => join(dirname(RAW), name))
        .filter((path) => statSync(path).size < BIGGEST)
    : [];
const ADDRESSES = ["1.1.1.1", "8.8.8.8", "185.220.101.1", "2606:4700:4700::1111"];

const TUNINGS: Tuning[] = [
  [3, 0, 0],
  [0, 0, 0],
  [0, 2, 2],
  [0, 3, 3],
];

const samples = (): Uint8Array[] => {
  let seed = 7;
  const noise = Uint8Array.from({ length: 3000 }, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  });
  const text = Array.from({ length: 2000 }, (_, at) => `row ${at % 97} of the pool\n`);
  const column = new DataView(new ArrayBuffer(4800));
  for (let at = 0; at < 1200; at += 1)
    column.setUint32(at * 4, (at * 7919) % 50000, true);
  return [
    new Uint8Array(0),
    new TextEncoder().encode("a"),
    new Uint8Array(400).fill(7),
    noise,
    new TextEncoder().encode(text.join("")),
    new Uint8Array(column.buffer),
  ];
};

const DIGESTS: Record<string, string[]> = {
  "3,0,0": [
    "535caa8a8e2f23f5",
    "e132eff5d51d96a5",
    "ebbd0e46291e7c07",
    "1a3de66190c39e11",
    "104ca26d4c740b3f",
    "a169fef5365681b0",
  ],
  "0,2,2": [
    "535caa8a8e2f23f5",
    "7d983783be032a1d",
    "05605ca5dcbdee9c",
    "5680e8e951a9da1c",
    "ddfaa703a84764f1",
    "3db001ef4fc11a09",
  ],
  "0,3,3": [
    "535caa8a8e2f23f5",
    "7d983783be032a1d",
    "05605ca5dcbdee9c",
    "3d816251eea11ebc",
    "eae93da3b68bff0c",
    "d931999df98405db",
  ],
};

test("compresses what the decoder reads back", () => {
  for (const tuning of TUNINGS) {
    for (const bytes of samples()) {
      const stream = compress(bytes, tuning);
      assert.deepEqual(decompress(stream, tuning), bytes);
    }
  }
});

test("compresses to the bytes liblzma writes at preset 9", () => {
  for (const [key, digests] of Object.entries(DIGESTS)) {
    const tuning = key.split(",").map(Number) as Tuning;
    samples().forEach((bytes, at) => {
      const digest = createHash("sha256").update(compress(bytes, tuning)).digest("hex");
      assert.equal(digest.slice(0, 16), digests[at], `${key} sample ${at}`);
    });
  }
});

test("writes the empty stream the way liblzma does", () => {
  const empty = compress(new Uint8Array(0), [3, 0, 0]);
  assert.equal(Buffer.from(empty).toString("base64"), "AIP/+///wAAAAA==");
});

test("names a file the way the builder does", () => {
  assert.equal(fileName("full"), "plevin.plv");
  assert.equal(fileName("place+metro"), "plevin.metro-place.plv");
  assert.equal(fileName("network.asn+abuse.risk"), "plevin.abuse-risk-network-asn.plv");
});

test("refuses what is not a raw database or holds no such field", held, () => {
  assert.throws(() => slim(new Uint8Array(40), "place"), /not a plevin raw/);
  assert.throws(() => slim(readBytes(PATH), "place"), /not a plevin raw/);
  assert.throws(() => slim(readBytes(RAW), "nothing"), /no field/);
});

test("keeps only the country and answers as the full file does", held, () => {
  const full = new Plevin(readBytes(PATH));
  const bytes = slim(readBytes(RAW), "place.country.code");
  const small = new Plevin(bytes);
  assert.equal(small.selection, "place.country.code");
  assert.ok(bytes.length < readFileSync(PATH).length / 10);
  for (const address of ADDRESSES) {
    assert.equal(
      small.lookup(address).place?.country?.code,
      full.lookup(address).place?.country?.code,
    );
    assert.equal(small.lookup(address).network, null);
  }
});

test("narrows a service to the one asked for", held, () => {
  const bytes = slim(readBytes(RAW), "abuse.is_tor_exit_node");
  const small = new Plevin(bytes);
  assert.equal(small.lookup("185.220.101.1").abuse?.is_tor_exit_node, true);
  assert.ok(!small.lookup("8.8.8.8").abuse?.is_tor_exit_node);
  assert.ok(bytes.length < 100_000);
});

test("rebuilds each smaller database the builder made, byte for byte", held, () => {
  const slimmer = new Slimmer(readBytes(RAW));
  for (const path of builtBeside()) {
    const built = readBytes(path);
    const size = new DataView(built.buffer, built.byteOffset).getUint32(8, true);
    const head = JSON.parse(new TextDecoder().decode(built.subarray(12, 12 + size)));
    assert.deepEqual(slimmer.slim(head.selection), built, path);
  }
});
