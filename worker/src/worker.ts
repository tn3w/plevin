/** An IP lookup API, reading a database kept in KV. */

import { Plevin } from "plevinjs";

type Environment = {
  PLEVIN: KVNamespace;
  DATABASE?: string;
};

const DATABASE = "plevin.plv";

let opened: Promise<Plevin> | null = null;

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, OPTIONS",
};

const answer = (body: unknown, status = 200, age = 300): Response =>
  new Response(JSON.stringify(body, (_, value) =>
    typeof value === "bigint" ? value.toString() : value), {
    status,
    headers: {
      ...headers,
      "cache-control": status === 200 ? `public, max-age=${age}` : "no-store",
    },
  });

/** The database out of KV, kept for as long as the isolate lives. */
const database = (environment: Environment): Promise<Plevin> => {
  opened ??= (async () => {
    const name = environment.DATABASE ?? DATABASE;
    const held = await environment.PLEVIN.get(name, "arrayBuffer");
    if (held === null) throw new Error(`${name} is missing from KV`);
    return new Plevin(new Uint8Array(held));
  })().catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
};

const lookup = async (
  environment: Environment,
  address: string,
): Promise<Response> => {
  const plevin = await database(environment);
  try {
    return answer(plevin.lookup(address));
  } catch (error) {
    return answer({ error: (error as Error).message }, 400);
  }
};

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers });

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/^api\/*/, "");

    try {
      if (path === "about") {
        const plevin = await database(environment);
        return answer({
          built: plevin.built,
          selection: plevin.selection,
          fields: plevin.fields,
        });
      }

      const asked = path || url.searchParams.get("ip") || "";
      if (asked && asked !== "me") return lookup(environment, asked);

      const held = request.headers.get("cf-connecting-ip");
      if (!held) return answer({ error: "no address to look up" }, 400);
      return lookup(environment, held);
    } catch (error) {
      return answer({ error: (error as Error).message }, 503);
    }
  },
};
