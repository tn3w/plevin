import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encodeQuery, records } from "../src/naming.ts";

const record = (kind: number, data: number[]): number[] => [
  0xc0,
  0x0c,
  kind >> 8,
  kind & 255,
  0,
  1,
  0,
  0,
  1,
  44,
  data.length >> 8,
  data.length & 255,
  ...data,
];

const replied = (flags: number, answers: number[][], authorities = 0): Uint8Array =>
  new Uint8Array([
    4,
    210,
    flags >> 8,
    flags & 255,
    0,
    1,
    0,
    answers.length - authorities,
    0,
    authorities,
    0,
    0,
    7,
    101,
    120,
    97,
    109,
    112,
    108,
    101,
    3,
    99,
    111,
    109,
    0,
    0,
    1,
    0,
    1,
    ...answers.flat(),
  ]);

test("writes a question as labels with an edns hint", () => {
  const query = encodeQuery("example.com", "A");
  const view = new DataView(query.buffer);
  assert.equal(view.getUint16(2), 0x0120);
  assert.deepEqual(
    [...query.slice(12, 25)],
    [7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0],
  );
  assert.equal(view.getUint16(25), 1);
  assert.equal(view.getUint16(30), 41);
});

test("reads a reply back as the records it carries", () => {
  const answer = replied(0x81a0, [
    record(1, [8, 8, 8, 8]),
    record(28, [...Array(15).fill(0), 1]),
    record(12, [3, 100, 110, 115, 0xc0, 0x0c]),
  ]);
  const reply = decode(answer);
  assert.equal(reply.code, 0);
  assert.ok(reply.authentic && !reply.truncated);
  assert.deepEqual(
    records(reply, "A").map((one) => one.data),
    ["8.8.8.8"],
  );
  assert.deepEqual(
    records(reply, "AAAA").map((one) => one.data),
    ["::1"],
  );
  assert.deepEqual(
    records(reply, "PTR").map((one) => one.data),
    ["dns.example.com"],
  );
});

test("reads a zone out of the authority section", () => {
  const soa = record(6, [
    3,
    110,
    115,
    49,
    0xc0,
    0x0c,
    5,
    97,
    98,
    117,
    115,
    101,
    0xc0,
    0x0c,
    ...Array(20).fill(0),
  ]);
  const reply = decode(replied(0x8183, [soa], 1));
  assert.equal(reply.code, 3);
  assert.deepEqual(records(reply, "SOA"), []);
  assert.equal(records(reply, "SOA", "any")[0].data, "ns1.example.com abuse.example.com");
});

test("says nothing about what it cannot read", () => {
  assert.deepEqual(records(null, "A"), []);
  assert.throws(() => decode(new Uint8Array(4)));
});
