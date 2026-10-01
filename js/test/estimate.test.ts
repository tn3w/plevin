import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { estimate } from "../src/estimate.ts";
import { Slimmer } from "../src/slim.ts";

const PATH = process.env.PLEVIN_RAW ?? "../plevin.raw";
const held = { skip: !existsSync(PATH) && "no raw database beside the package" };
const SELECTIONS = ["place.country.code", "abuse.is_tor_exit_node", "network.asn"];

test("guesses the size of a build from counted facts alone", held, () => {
  const slimmer = new Slimmer(new Uint8Array(readFileSync(PATH)));
  const stats = slimmer.stats();
  for (const terms of SELECTIONS) {
    const built = slimmer.slim(terms).length;
    const guess = estimate(stats, terms);
    assert.ok(
      Math.abs(guess - built) < built * 0.25 + 4000,
      `${terms}: estimated ${guess} of ${built}`,
    );
  }
});

test("counts a few hundred kilobytes, never the database itself", held, () => {
  const stats = new Slimmer(new Uint8Array(readFileSync(PATH))).stats();
  assert.ok(JSON.stringify(stats).length < 400_000);
});
