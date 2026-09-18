import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindingAddress,
  bindingRequest,
  decode,
  encodeQuery,
  records,
} from "../src/naming.ts";

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

const binding = (attribute: number, family: number, body: number[]): Uint8Array => {
  const message = new Uint8Array(20 + 4 + 4 + body.length);
  const view = new DataView(message.buffer);
  view.setUint16(0, 0x0101);
  view.setUint32(4, 0x2112a442);
  message.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 8);
  view.setUint16(20, attribute);
  view.setUint16(22, body.length + 4);
  message.set([0, family, 0x2f, 0x76], 24);
  message.set(body, 28);
  return message;
};

test("writes a binding request the cookie identifies", () => {
  const request = bindingRequest();
  const view = new DataView(request.buffer);
  assert.equal(request.length, 20);
  assert.equal(view.getUint16(0), 1);
  assert.equal(view.getUint32(4), 0x2112a442);
});

test("reads the address a binding reply xors with the cookie", () => {
  assert.equal(
    bindingAddress(binding(0x0020, 1, [0xea, 0x12, 0xd5, 0x68])),
    "203.0.113.42",
  );
  assert.equal(bindingAddress(binding(0x0001, 1, [203, 0, 113, 42])), "203.0.113.42");
  const key = [0x21, 0x12, 0xa4, 0x42, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const real = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const six = real.map((byte, at) => byte ^ key[at]);
  assert.equal(bindingAddress(binding(0x0020, 2, six)), "2001:db8::1");
});

test("says nothing about a datagram that is not a binding reply", () => {
  assert.equal(bindingAddress(new Uint8Array(20)), null);
  assert.equal(bindingAddress(new Uint8Array(4)), null);
  assert.equal(bindingAddress(binding(0x0008, 1, [1, 2, 3, 4])), null);
});
