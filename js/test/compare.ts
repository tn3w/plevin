import { readFileSync } from "node:fs";
import { openFile } from "../src/node.ts";

const MOMENT = new Date("2026-03-29T12:30:00Z");

const expected = JSON.parse(readFileSync(process.argv[3], "utf8")) as Record<
  string,
  Record<string, unknown>
>;
const db = await openFile(process.argv[2]);

const plain = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

const differs = (left: unknown, right: unknown, path: string): string[] => {
  const held = plain(left);
  if (held === right) return [];
  if (typeof held === "number" && typeof right === "number") {
    return Math.abs(held - right) < 1e-9 ? [] : [`${path}: ${held} vs ${right}`];
  }
  if (held && right && typeof held === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(held), ...Object.keys(right)]);
    return [...keys].flatMap((key) =>
      differs(
        (held as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`,
      ),
    );
  }
  return [`${path}: ${JSON.stringify(held)} vs ${JSON.stringify(right)}`];
};

let checked = 0;
const problems: string[] = [];
for (const [ip, held] of Object.entries(expected)) {
  const found = db.lookup(ip, MOMENT) as unknown as Record<string, unknown>;
  problems.push(...differs({ ...found, number: String(found.number) }, held, ip));
  checked += 1;
}

console.log(`${checked} addresses compared against the python package`);
for (const problem of problems.slice(0, 40)) console.log(problem);
console.log(problems.length ? `${problems.length} differences` : "identical");
process.exitCode = problems.length ? 1 : 0;
