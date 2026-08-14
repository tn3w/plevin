import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { decompress, loadDictionary } from "../src/zstd.ts";

const roundTrip = (data: Uint8Array, level?: number): void => {
  const packed = zstdCompressSync(
    data,
    level === undefined ? {} : { params: { 100: level } },
  );
  assert.deepEqual(decompress(new Uint8Array(packed)), data);
};

test("reads back what zstd wrote", () => {
  roundTrip(new Uint8Array(0));
  roundTrip(Uint8Array.from([1]));
  roundTrip(new Uint8Array(70000));
  roundTrip(new Uint8Array(randomBytes(1 << 17)));
  roundTrip(new TextEncoder().encode("plevin ".repeat(5000)));
});

test("reads back what every level wrote", () => {
  const held = new TextEncoder().encode(
    Array.from({ length: 4000 }, (_, index) => `row ${index % 97} of the pool\n`).join(
      "",
    ),
  );
  for (const level of [1, 3, 9, 19]) roundTrip(held, level);
});

test("refuses what is not a frame", () => {
  assert.throws(() => decompress(new Uint8Array(8)), /not a zstd frame/);
});

test("reads a dictionary that carries no entropy tables", () => {
  const content = new TextEncoder().encode("the pool a raw dictionary carries");
  const dictionary = loadDictionary(content);
  assert.equal(dictionary.id, 0);
  assert.deepEqual(dictionary.content, content);
  assert.equal(dictionary.huffman, null);
});
