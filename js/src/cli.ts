#!/usr/bin/env node
/** Cuts a database down from the shell: npx plevinjs place+metro. */

import { readFile, writeFile } from "node:fs/promises";
import { fileName, slim } from "./slim.ts";

const args = process.argv.slice(2);
const [input, terms, output] = args[0]?.endsWith(".raw") ? args : ["plevin.raw", ...args];

if (!terms) {
  console.error("usage: npx plevinjs [plevin.raw] <terms> [output.plv]");
  console.error(
    "terms: full, or fields joined by +, e.g. place.country.code+network.asn",
  );
  process.exit(1);
}

const bytes = slim(new Uint8Array(await readFile(input)), terms);
const target = output ?? fileName(terms);
await writeFile(target, bytes);
console.log(`${target}: ${bytes.length} bytes`);
