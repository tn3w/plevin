import { readFileSync, writeFileSync } from "node:fs";
import { Slimmer } from "../src/slim.ts";

const [path = "../plevin.raw", output = "../site/db/stats.json"] = process.argv.slice(2);
const started = performance.now();
const stats = new Slimmer(new Uint8Array(readFileSync(path))).stats();
const json = JSON.stringify(stats);
writeFileSync(output, json);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`${output}: ${json.length} bytes in ${seconds} s`);
