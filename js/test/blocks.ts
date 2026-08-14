import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decompress, loadDictionary } from "../src/zstd.ts";

const data = new Uint8Array(readFileSync(process.argv[2]));
const view = new DataView(data.buffer);
const size = view.getUint32(8, true);
type Entry = { offset: number };
const head = JSON.parse(new TextDecoder().decode(data.subarray(12, 12 + size))) as {
  sections: Record<string, Entry>;
};
const body = 12 + size;
const limit = Number(process.argv[3] ?? 3);

const digests: Record<string, string> = {};
for (const [name, entry] of Object.entries(head.sections) as [string, Entry][]) {
  const at = body + entry.offset;
  const blocks = view.getUint32(at, true);
  const width = view.getUint32(at + 4, true);
  const book = view.getUint32(at + 8, true);
  const offsets = Array.from({ length: blocks + 1 }, (_, index) =>
    view.getUint32(at + 12 + index * 4, true),
  );
  const start = at + 12 + 4 * (blocks + 1) + width * blocks;
  const dictionary = book ? loadDictionary(data.subarray(start, start + book)) : null;
  const held = start + book;
  const digest = createHash("sha256");
  for (let index = 0; index < Math.min(blocks, limit); index += 1) {
    const block = data.subarray(held + offsets[index], held + offsets[index + 1]);
    digest.update(decompress(block, dictionary));
  }
  digests[name] = digest.digest("hex");
}
console.log(JSON.stringify(digests, null, 1));
