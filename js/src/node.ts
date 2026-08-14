/** Opening a database from disk, for Node, Deno and Bun. */

import { readFile } from "node:fs/promises";
import { Plevin } from "./index.ts";

export * from "./index.ts";

/** One database read off disk, or from PLEVIN_DB where no path is given. */
export const openFile = async (path?: string): Promise<Plevin> => {
  const found = path ?? process.env.PLEVIN_DB;
  if (!found) throw new Error("no database given: pass a path or set PLEVIN_DB");
  return new Plevin(new Uint8Array(await readFile(found)));
};
