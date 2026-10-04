import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { openFile } from "../src/node.ts";

const PATH = process.env.PLEVIN_DB ?? "../plevin.plv";
const missing = !existsSync(PATH);
const db = missing ? null : await openFile(PATH);
const held = { skip: missing && "no database beside the package" };
const registry = {
  skip: held.skip || (!db?.fields.includes("network.rir") && "a build before rir"),
};
const registered = {
  skip: held.skip || (!db?.fields.includes("network.country") && "a build before 1.1"),
};

test("opens a database and says what it carries", held, () => {
  assert.match(db?.built ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.ok((db?.fields.length ?? 0) > 0);
});

test("answers where an address is", held, () => {
  const found = db?.lookup("1.1.1.1");
  assert.equal(found?.place?.city?.name, "Brisbane");
  assert.equal(found?.place?.city?.region?.name, "Queensland");
  assert.equal(found?.place?.country?.code, "AU");
  assert.equal(found?.place?.country?.iso3, "AUS");
  assert.equal(found?.place?.country?.flag, "🇦🇺");
  assert.equal(found?.place?.country?.driving_side, "left");
  assert.equal(found?.place?.city?.timezone, "Australia/Brisbane");
  assert.equal(found?.place?.time?.abbreviation, "AEST");
});

test("answers who announces an address", held, () => {
  const found = db?.lookup("1.1.1.1");
  assert.equal(found?.network?.asn, 13335);
  assert.equal(found?.network?.operator?.brand, "Cloudflare");
  assert.equal(found?.network?.cidr, "1.1.1.0/24");
  assert.equal(found?.network?.operator?.domain, "cloudflare.com");
});

const unannounced = () => {
  for (const first of [36, 41, 102, 103]) {
    for (let second = 0; second < 256; second += 2) {
      for (let third = 0; third < 256; third += 8) {
        const network = db?.lookup(`${first}.${second}.${third}.1`).network;
        if (network && network.asn === null && network.handle) return network;
      }
    }
  }
  return null;
};

test("names who a registry gave a span to where no one announces it", registry, (t) => {
  assert.equal(db?.lookup("1.1.1.1").network?.rir, "apnic");
  const found = unannounced();
  if (!found) return t.skip("every span sampled is announced");
  assert.ok(found.rir);
  assert.ok(found.operator?.company);
});

test("names the country and year a registry gave a block out", registered, (t) => {
  const found = unannounced();
  if (!found) return t.skip("every span sampled is announced");
  assert.match(found.country ?? "", /^[A-Z]{2}$/);
  assert.ok((found.since ?? 0) > 1980);
  assert.equal(found.rpki, null);
  assert.equal(found.roas, null);
  assert.equal(db?.lookup("100.64.0.1").network, null);
});

test("reads a country's currency, calling code and languages", held, () => {
  const found = db?.lookup("8.8.8.8").place?.country;
  assert.equal(found?.currency, "USD");
  assert.equal(found?.currency_name, "US Dollar");
  assert.equal(found?.calling_code, "+1");
  assert.deepEqual(found?.languages, ["en"]);
});

test("names a continent, and each language once", held, () => {
  const found = db?.lookup("8.8.8.8").place?.country;
  assert.equal(found?.continent, "NA");
  assert.deepEqual(db?.lookup("1.1.1.1").place?.country?.languages, ["en"]);
});

test("reads the size of a network and its customer cone", held, () => {
  const operator = db?.lookup("1.1.1.1").network?.operator;
  assert.ok((operator?.cone ?? 0) > 1);
  assert.equal(operator?.website, "https://cloudflare.com");
  assert.equal(operator?.city?.population, null);
});

test("types a network by its operator unless the range says otherwise", held, () => {
  const found = db?.system("AS3");
  assert.equal(found?.network?.carrier?.user_type, "education");
  assert.equal(db?.lookup("18.9.1.1").network?.carrier?.user_type, "education");
});

test("finds nothing where nothing is known", held, () => {
  const found = db?.lookup("0.197.62.223");
  assert.equal(found?.found, false);
  assert.equal(found?.expanded, null);
});

test("flags crawlers and names no town for a point coarser than one", held, () => {
  const found = db?.lookup("66.249.66.1");
  assert.equal(found?.abuse?.is_crawler, true);
  for (const value of ["1.1.1.1", "8.8.8.8", "185.220.101.1"]) {
    const place = db?.lookup(value).place;
    if (place?.granularity !== "city") assert.equal(place?.city?.name, null);
  }
});

test("answers what has been seen from an address", held, () => {
  const found = db?.lookup("185.220.101.1");
  assert.equal(found?.abuse?.service, "tor_exit_node");
  assert.equal(found?.abuse?.is_tor_exit_node, true);
  assert.equal(found?.abuse?.is_anonymous, true);
  assert.ok((found?.abuse?.risk ?? 0) > 0.5);
});

test("names who runs an address, the feed's name before the network's", held, () => {
  const found = db?.lookup("185.220.101.1");
  assert.equal(found?.abuse?.provider, "Tor");
  const bare = db?.lookup("1.1.1.1");
  assert.equal(bare?.abuse?.provider, null);
});

test("answers the same for v6 as for v4", held, () => {
  const found = db?.lookup("2606:4700::1111");
  assert.equal(found?.version, 6);
  assert.equal(found?.network?.asn, 13335);
  assert.equal(found?.ip, "2606:4700::1111");
});

test("answers for an address the file covers nothing of", held, () => {
  const found = db?.lookup("240.0.0.1");
  assert.equal(found?.is_reserved, true);
  assert.equal(found?.is_global, false);
  assert.equal(found?.ip, "240.0.0.1");
});

test("reads a repeat out of the cache", held, () => {
  assert.equal(db?.lookup("8.8.8.8"), db?.lookup("8.8.8.8"));
  assert.equal(db?.lookup(134744072).network?.asn, 15169);
});

test("hands back the stored rows underneath", held, () => {
  const row = db?.row("8.8.8.8") as Record<string, Record<string, unknown>>;
  assert.equal(row.network.asn, 15169);
});

test("answers one ASN without an address to ask about", held, () => {
  const found = db?.system("AS13335");
  assert.equal(found?.found, true);
  assert.equal(found?.handle, "CLOUDFLARENET");
  assert.equal(found?.network?.operator?.company, "Cloudflare, Inc.");
  assert.equal(found?.network?.cidr, null);
  assert.equal(db?.system(4294967295).found, false);
  assert.equal(db?.system("nowhere").asn, null);
});

test("answers every prefix an ASN is announced as", held, () => {
  const found = db?.routes("AS13335");
  assert.equal(found?.found, true);
  assert.ok(found?.ipv4.some((one) => one.cidr === "1.1.1.0/24"));
  assert.ok((found?.ipv6.length ?? 0) > 0);
  const [widest] = found?.ipv4 ?? [];
  assert.equal(widest?.addresses, 2 ** (32 - (widest?.prefix ?? 0)));
  assert.equal(widest?.cidr, `${widest?.start}/${widest?.prefix}`);
  assert.ok((found?.ipv4_addresses ?? 0) >= Number(widest?.addresses));
  assert.ok((found?.ipv6_addresses ?? 0n) >= (found?.ipv6[0]?.addresses ?? 0n));
  assert.deepEqual(
    found?.ipv4.map((one) => one.prefix),
    [...(found?.ipv4 ?? [])].map((one) => one.prefix).sort((one, two) => one - two),
  );
  assert.equal(db?.routes("AS13335"), found);
  assert.equal(db?.routes("nowhere").found, false);
  assert.deepEqual(db?.routes(4294967295).ipv4, []);
});

test("finds the widest networks a name belongs to", held, () => {
  assert.equal(db?.search("cloudflare")[0]?.asn, 13335);
  assert.equal(db?.search("google")[0]?.asn, 15169);
  assert.equal(db?.search("amazon")[0]?.asn, 16509);
  assert.equal(db?.search("as15169")[0]?.handle, "GOOGLE");
  assert.deepEqual(db?.search("  "), []);
});
