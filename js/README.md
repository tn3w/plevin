<div align="center">
<a href="https://www.npmjs.com/package/plevinjs">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-light.png" width="320" alt="plevin">
</picture>
</a>

**Location, network and abuse information for any IP address in one offline file.**<br>
No API, no rate limit, no lookup leaving the machine or the browser tab.

[![npm](https://img.shields.io/npm/v/plevinjs?color=1868f2)](https://www.npmjs.com/package/plevinjs)
[![Types](https://img.shields.io/badge/types-included-1868f2)](https://www.npmjs.com/package/plevinjs?activeTab=code)
[![License](https://img.shields.io/badge/license-Apache--2.0-1868f2)](https://github.com/tn3w/plevin/blob/master/LICENSE)
[![Fields](https://img.shields.io/badge/fields-101-6f42c1)](#fields)
[![Warm](https://img.shields.io/badge/warm%20lookups-5M%2Fs-2ea043)](#speed)

</div>

## Quick start

```bash
npm install plevinjs
```

```js
import { open } from "plevinjs";

const db = await open("https://plevin.tn3w.dev/db/plevin.plv");
const found = db.lookup("1.1.1.1");       // string, number, bigint or bytes

found.place.city.name;                    // 'Brisbane'
found.place.time.local;                   // '2026-08-13T23:27:58+10:00'
found.network.operator.brand;             // 'Cloudflare'
found.network.cidr;                       // '1.1.1.0/24'
db.lookup("185.220.101.1").abuse.service; // 'tor_exit_node'
```

- `lookup` always answers a `Result` and throws for non-addresses.
- Numbers up to `0xffffffff` are v4, so `lookup(1)` is `0.0.0.1`.
- Pure ESM, zero dependencies: Node, Deno, Bun, Cloudflare Workers, browsers.

## Opening a database

| where           | how                                                        |
| --------------- | ---------------------------------------------------------- |
| browser, worker | `await open(url)` or `await open(response)`                |
| Node, Deno, Bun | `openFile(path)` from `plevinjs/node`; `PLEVIN_DB` if no path |
| bytes in hand   | `new Plevin(uint8Array)`                                   |

Open once, reuse for every lookup. Nothing is downloaded or cached for you.

| file                                                  | size    | carries                                  |
| ----------------------------------------------------- | ------- | ---------------------------------------- |
| `plevin.plv`                                          | 17.3 MB | every field                              |
| `plevin.metro-place.plv`                              | 5.4 MB  | city, region, postal, coordinates, metro |
| `plevin.network.plv`                                  | 7.0 MB  | ASN, operator, routing                   |
| `plevin.abuse-level-abuse-provider-abuse-service.plv` | 4.1 MB  | abuse level, service and provider        |
| `plevin.place-country-code.plv`                       | 378 KB  | country code                             |

All are served with open CORS from [plevin.tn3w.dev/db](https://plevin.tn3w.dev/db/);
GitHub release downloads send no CORS header.

## In a browser

No build step:

```html
<script type="module">
  import { open } from "https://cdn.jsdelivr.net/npm/plevinjs";

  const db = await open("https://plevin.tn3w.dev/db/plevin.place-country-code.plv");
  const { flag, name } = db.lookup("8.8.8.8").place.country;
  document.body.textContent = `${flag} ${name}`;   // '🇺🇸 United States'
</script>
```

| URL                                            | serves                            |
| ---------------------------------------------- | --------------------------------- |
| `https://cdn.jsdelivr.net/npm/plevinjs`        | `plevin.min.js`, one 52 kB file   |
| `https://unpkg.com/plevinjs`                   | the same                          |
| `https://esm.sh/plevinjs`                      | the modules, imports rewritten    |
| `https://plevin.tn3w.dev/plevin/plevin.min.js` | the bundle beside the databases   |

- **Pin a version for production:** `cdn.jsdelivr.net/npm/plevinjs@0.2.1`.
- **Pick the smallest build:** the country build is 378 KB against 17.3 MB.
- **Cache the file** so it downloads once per visitor:

```js
const store = await caches.open("plevin");
const url = "https://plevin.tn3w.dev/db/plevin.plv";
if (!(await store.match(url))) await store.add(url);
const db = new Plevin(new Uint8Array(await (await store.match(url)).arrayBuffer()));
```

## Fields

<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-light.png" width="840" alt="address to place, network and abuse">
</picture>

Identical to the
[Python package](https://github.com/tn3w/plevin/blob/master/python/README.md#fields),
field for field; see there for what each one means. A missing value is `null`, never
`""` or `0`.

```js
found.place;
{
  lat: -27.4675, lon: 153.0281, accuracy: 200, confidence: 36, granularity: 'city',
  city: {
    id: 2174003, name: 'Brisbane', ascii: 'Brisbane', country: 'AU',
    population: 2780063, elevation: 27, postal: '4000', postal_partial: null,
    timezone: 'Australia/Brisbane', type: 'regional capital', capital: 'region',
    region: { id: 2152274, code: '04', iso: 'AU-QLD', name: 'Queensland', type: 'State' },
    district: { id: 7839562, code: '31000', name: 'Brisbane' },
    metro: null,
  },
  country: {
    code: 'AU', name: 'Australia', official: null, common: null, iso3: 'AUS',
    numeric: '036', flag: '🇦🇺', european_union: false, driving_side: 'left',
  },
  time: {
    timezone: 'Australia/Brisbane', abbreviation: 'AEST',
    local: '2026-08-13T19:20:00+10:00', utc_offset: '+10:00', is_dst: false,
    dst_start: null, dst_end: null,
  },
}

found.network;
{
  asn: 13335, handle: 'CLOUDFLARENET', prefix: 24, cidr: '1.1.1.0/24',
  start: '1.1.1.0', end: '1.1.1.255', rir: 'apnic', rpki: 'valid', roas: 1,
  operator: {
    company: 'Cloudflare, Inc.', brand: 'Cloudflare', domain: 'cloudflare.com',
    website: 'https://www.cloudflare.com', category: 'content', tier: 2,
    peering: 356, scope: 'Global', rir: 'arin', since: 2010,
    street: '101 Townsend St', state: 'CA', postal: '94107-1934', country: 'US',
    abuse_email: 'abuse@cloudflare.com', city: { name: 'San Francisco', ... },
  },
  carrier: { user_type: 'hosting', user_count: 19, mcc: null, mnc: null,
             is_mobile: false },
}

db.lookup("185.220.101.1").abuse;
{
  name: 'Tor', provider: 'Tor', service: 'tor_exit_node', evidence: 'measured',
  threat: 'spam', level: 'high', risk: 0.99, network_risk: 0.86, last_seen_days: 1,
  is_malicious: true, is_anycast: false, is_satellite: false,
  is_hosting_provider: true, is_proxy: false, is_public_proxy: false,
  is_residential_proxy: false, is_anonymous_vpn: false, is_tor_exit_node: true,
  is_private_relay: false, is_anonymous: true,
}
```

JavaScript specifics:

- `country` comes from an ISO 3166 table in the package and `time` from the runtime's
  `Intl` data, so neither needs an install or a network call. A different zone
  database can move a daylight-saving boundary.
- `number` is a `bigint` for v6, so `JSON.stringify` needs a replacer.

Address fields (`compressed`, `expanded`, `arpa`, `is_*`, `tunnel`, `embedded_ipv4`,
`decimal_ipv4`, `as_*`) work without any database.

## DNS

`lookup` stays synchronous and offline. `resolve` adds DNS only when asked:

```js
(await db.resolve("8.8.8.8", { dns: true })).dns;
{
  asked: '8.8.8.8', hostname: 'dns.google', hostnames: ['dns.google'],
  ipv4: '8.8.4.4', ipv6: '2001:4860:4860::8888',
  ipv4_addresses: ['8.8.4.4', '8.8.8.8'],
  ipv6_addresses: ['2001:4860:4860::8888', '2001:4860:4860::8844'],
  alias: null, zone: '8.8.8.in-addr.arpa', zone_primary: 'ns1.google.com',
  zone_contact: 'dns-admin@google.com', is_confirmed: true, is_signed: true,
}
```

- **Node, Deno, Bun:** raw DNS over UDP, raced across the system resolver plus
  1.1.1.1, 8.8.8.8 and 9.9.9.9, with TCP on truncation.
- **Browsers, workers:** DNS-over-HTTPS to Cloudflare and Google.
- **Cache:** answers are kept for one hour.

## Own address

```js
import { publicAddress } from "plevinjs";

const own = await publicAddress();   // '203.0.113.42', or null
own && db.lookup(own);
```

- **How:** one STUN binding request, answered in tens of milliseconds.
- **Browsers:** go through `RTCPeerConnection` instead.
- **Fallback:** after 2 s, asks `api.ipify.org`, then `icanhazip.com`.

## ASNs

```js
const found = db.system("AS13335");        // 'AS13335', 'as13335' or 13335
found.network.operator.brand;              // 'Cloudflare'
found.abuse.network_risk;                  // 0.14

db.search("hetzner").map((one) => one.asn);
// [24940, 212317, 213230, 215859]

const routes = db.routes("AS13335");
routes.ipv4.length;                        // 1411
routes.ipv4[0].cidr;                       // '152.114.0.0/17', widest first
routes.ipv6_addresses >> 64n;              // space as /64 networks, a bigint
```

| call                      | answers                                                  |
| ------------------------- | -------------------------------------------------------- |
| `system(asn)`             | `System`: handle, network, operator, carrier, ASN abuse; `found` false if unknown |
| `search(text, limit=20)`  | `System`s whose handle or company matches, best first    |
| `routes(asn)`             | `Routes`: every announced prefix as a `Span`, widest first |

## HTTP

The same JSON without a file, CORS open, no key:

```bash
curl https://plevin.tn3w.dev/api/1.1.1.1   # any address
curl https://plevin.tn3w.dev/api/me        # the caller
curl https://plevin.tn3w.dev/api/about     # build and fields
```

Self-host with [`worker/`](https://github.com/tn3w/plevin/blob/master/worker).

## Speed

Full file, Node 26, one core:

| operation    | speed                                  |
| ------------ | -------------------------------------- |
| open         | 9 ms, header only                      |
| first lookup | 70 ms                                  |
| repeats      | 5,000,000/s                            |
| random v4    | 8,000/s cold, 72,000/s warm            |
| `system`     | 1,000,000/s                            |
| `routes`     | 100–160 ms, then cached                |
| `search`     | 1 ms, after 0.07 s building the index  |

Blocks decode lazily, only as far as a lookup reaches, and stay decoded: about 160 MB
of heap with the whole world touched.

## LZMA

Blocks are raw LZMA1, which neither `DecompressionStream` nor `zlib` reads, so the
package ships its own decoder, checked against liblzma on every block.

```js
import { decompress } from "plevinjs/lzma";

decompress(block, [3, 0, 0]);   // tuning: literal context, literal position, match position bits
```

## Development

| module       | job                                                 |
| ------------ | --------------------------------------------------- |
| `index.ts`   | `Plevin`, `open`, result shaping                    |
| `reader.ts`  | file format: sections, blocks, groups, bisection    |
| `lzma.ts`    | resumable LZMA1 decoder                             |
| `address.ts` | parsing, spelling, special ranges                   |
| `naming.ts`  | DNS and own address                                 |
| `extra.ts`   | country and clock, from `countries.ts`/`zones.ts`   |
| `derive.ts`  | brand, domain, capital                              |
| `models.ts`  | published types                                     |
| `node.ts`    | `openFile`, the only `node:fs` import               |

```bash
npm ci
npm test && npm run lint && npm run typecheck
npm run build                                   # dist/ and the CDN bundle

node test/compare.ts ../plevin.plv sample.json  # field for field against Python
node test/blocks.ts ../plevin.plv 100000        # every block against liblzma
```

## License

Apache 2.0, see [LICENSE](https://github.com/tn3w/plevin/blob/master/LICENSE). The
database carries the licenses of its
[sources](https://github.com/tn3w/plevin/blob/master/builder/README.md#sources).

<!-- brand: Noto Sans 800, wordmark bar #1868f2 place, #6f42c1 network, #2ea043 abuse; #7d8894 address, ink #0b1220 light, #f0f6fc dark -->
