import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOCUMENTATION,
  LOOPBACK,
  parse,
  purpose,
  span,
  spelled,
  tunnel,
} from "../src/address.ts";

test("reads an address however it is written", () => {
  assert.deepEqual(parse("1.1.1.1"), [16843009, false]);
  assert.deepEqual(parse(16843009), [16843009, false]);
  assert.deepEqual(parse(new Uint8Array([1, 1, 1, 1])), [16843009, false]);
  assert.deepEqual(parse("::1"), [1n, true]);
  assert.deepEqual(parse(1n << 100n), [1n << 100n, true]);
  assert.equal(parse("2606:4700::1111")[0], 50543257672059871404715951523469725969n);
});

test("refuses what is not an address", () => {
  for (const held of [
    "",
    "1.2.3",
    "1.2.3.4.5",
    "256.0.0.1",
    "01.2.3.4",
    "::x",
    "1::2::3",
  ]) {
    assert.throws(() => parse(held), /not an address/, held);
  }
  assert.throws(() => parse(-1), /not an address/);
  for (const held of [null, undefined, 1.5, Number.NaN, {}]) {
    assert.throws(() => parse(held as never), /not an address/, String(held));
  }
});

test("spells an address short, in full and for a resolver", () => {
  assert.deepEqual(spelled(16843009, false), [
    "1.1.1.1",
    "1.1.1.1",
    "1.1.1.1.in-addr.arpa",
  ]);
  const [compressed, expanded, arpa] = spelled(parse("2606:4700::1111")[0], true);
  assert.equal(compressed, "2606:4700::1111");
  assert.equal(expanded, "2606:4700:0000:0000:0000:0000:0000:1111");
  assert.equal(
    arpa,
    "1.1.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.7.4.6.0.6.2.ip6.arpa",
  );
  assert.equal(spelled(parse("::ffff:8.8.8.8")[0], true)[0], "::ffff:8.8.8.8");
});

test("says what an address is where it is not the internet", () => {
  assert.equal(purpose(parse("8.8.8.8")[0], false), 0);
  assert.equal(purpose(parse("127.0.0.1")[0], false) & LOOPBACK, LOOPBACK);
  assert.equal(purpose(parse("2001:db8::1")[0], true) & DOCUMENTATION, DOCUMENTATION);
});

test("reads the v4 address a v6 one carries", () => {
  assert.deepEqual(tunnel(parse("::ffff:8.8.8.8")[0], true), ["ipv4-mapped", "8.8.8.8"]);
  assert.deepEqual(tunnel(parse("2002:808:808::1")[0], true), ["6to4", "8.8.8.8"]);
  assert.deepEqual(tunnel(parse("64:ff9b::808:808")[0], true), ["nat64", "8.8.8.8"]);
  assert.deepEqual(tunnel(16843009, false), [null, null]);
});

test("masks an announcement out of the address", () => {
  assert.deepEqual(span(parse("1.1.1.1")[0], false, 24), [
    "1.1.1.0/24",
    "1.1.1.0",
    "1.1.1.255",
  ]);
  assert.deepEqual(span(parse("2606:4700::1111")[0], true, 44)[0], "2606:4700::/44");
});
