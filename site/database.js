const STORE = "plevin";

export const download = async (file, progress) => {
  const cache = "caches" in window ? await caches.open(STORE) : null;
  const cached = cache && (await cache.match(file));
  if (cached) {
    progress("reading the database out of the browser cache", 1);
    return new Uint8Array(await cached.arrayBuffer());
  }

  const response = await fetch(file);
  if (!response.ok) throw new Error(`${response.status} reading the database`);
  if (cache) await cache.put(file, response.clone());

  const total = Number(response.headers.get("content-length") ?? 0);
  const parts = [];
  let done = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done: over, value } = await reader.read();
    if (over) break;
    parts.push(value);
    done += value.length;
    progress(`downloading the database, ${(done / 1e6).toFixed(1)} MB`, total ? done / total : 0);
  }

  const bytes = new Uint8Array(done);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};
