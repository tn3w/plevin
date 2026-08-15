<div align="center">
<a href="https://www.npmjs.com/package/plevinjs">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-light.png" width="320" alt="plevin">
</picture>
</a>

**Location, network and abuse information for any IP address in one offline file.**<br>
No API, no rate limit, no lookup leaving the machine, or the browser tab.

[![npm](https://img.shields.io/npm/v/plevinjs?color=1868f2)](https://www.npmjs.com/package/plevinjs)
[![Types](https://img.shields.io/badge/types-included-1868f2)](https://www.npmjs.com/package/plevinjs?activeTab=code)
[![License](https://img.shields.io/badge/license-Apache--2.0-1868f2)](https://github.com/tn3w/plevin/blob/master/LICENSE)
[![Fields](https://img.shields.io/badge/fields-98-6f42c1)](#every-field)
[![Boundaries](https://img.shields.io/badge/boundaries-2.6M-6f42c1)](https://github.com/tn3w/plevin/blob/master/README.md#data)
[![Warm](https://img.shields.io/badge/warm%20lookups-4M%2Fs-2ea043)](#speed)

</div>

```bash
npm install plevinjs
```

```js
import { Plevin, open } from "plevinjs";

const db = await open("https://plevin.tn3w.dev/db/plevin.plv");
const found = db.lookup("1.1.1.1");  // string, number, bigint or packed bytes
```

Always a `Result`, never `undefined`; it throws for anything that is not an address, and
a number reads as v6 only above `0xffffffff`, so `lookup(1)` is `0.0.0.1`.

```js
found.place.city.name;                    // 'Brisbane'
found.place.city.region.name;             // 'Queensland'
found.place.country.name;                 // 'Australia'
found.place.time.local;                   // '2026-08-13T23:27:58+10:00'

found.network.asn;                        // 13335
found.network.operator.brand;             // 'Cloudflare'
found.network.cidr;                       // '1.1.1.0/24'

const exit = db.lookup("185.220.101.1");
exit.abuse.service;                       // 'tor_exit_node'
exit.abuse.risk;                          // 0.97
exit.abuse.is_tor_exit_node;              // true
```

Pure ESM with no dependencies, so it runs wherever fetch does: Node, Deno, Bun,
Cloudflare Workers, and any browser off a CDN.

```html
<script type="module">
import { open } from "https://cdn.jsdelivr.net/npm/plevinjs";

const db = await open("https://plevin.tn3w.dev/db/plevin.place-country-code.plv");
const { flag, name } = db.lookup("8.8.8.8").place.country;
document.body.textContent = `${flag} ${name}`;              // '🇺🇸 United States'
</script>
```

That build is 423 KB, the country code and nothing else, and the name and flag are
derived in the reader. `https://esm.sh/plevinjs` serves the same thing. Every database is rehosted with open
CORS at [plevin.tn3w.dev/db](https://plevin.tn3w.dev/db/), because GitHub release
downloads send no CORS header.

## Where the file comes from

| where it runs | how to open it |
| --- | --- |
| browser, worker | `await open(url)`, or `await open(response)` |
| Node, Deno, Bun | `import { openFile } from "plevinjs/node"`, then `await openFile(path)` |
| bytes you hold | `new Plevin(bytes)`, taking a `Uint8Array` |

`openFile()` reads `PLEVIN_DB` where no path is given. Nothing is downloaded for you
and nothing is cached for you: hand the same `Plevin` to every lookup and the file is
read once.

| file | size | carries |
| --- | --- | --- |
| `plevin.plv` | 16.9 MB | every field |
| `plevin.metro-place.plv` | 6.3 MB | city, region, postal, coordinates, metro |
| `plevin.abuse-network.plv` | 10.3 MB | ASN, operator, routing, abuse |
| `plevin.place-country-code.plv` | 423 KB | the country code |

## The same answers over HTTP

Where a file is one dependency too many, the reader runs on a Cloudflare Worker at
[plevin.tn3w.dev/api](https://plevin.tn3w.dev/api/1.1.1.1) and returns the same JSON,
field for field, with no key and CORS open to every origin.

```bash
curl https://plevin.tn3w.dev/api/1.1.1.1   # any address
curl https://plevin.tn3w.dev/api/me        # the caller's own
curl https://plevin.tn3w.dev/api/about     # the build and its fields
```

[`worker/`](https://github.com/tn3w/plevin/blob/master/worker) is that worker, ready to
run on an account of your own.

## Every field

<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-light.png" width="840" alt="address to place, network and abuse">
</picture>

`found.place` is where the address is, `found.network` who announces it, `found.abuse`
what has been seen from it. Any of the three is `null` where the build carries none of
it, and every leaf is `null` rather than `""` or `0` where a source says nothing. The
shapes and the field names are the ones the
[Python package](https://github.com/tn3w/plevin/blob/master/python/README.md#every-field)
answers with, to the letter.

```js
{
  lat: -27.4675, lon: 153.0281, accuracy: 200, confidence: 36,
  granularity: 'city',
  city: {
    id: 2174003, name: 'Brisbane', ascii: 'Brisbane', country: 'AU',
    population: 2780063, elevation: 27, postal: '4000', postal_partial: null,
    timezone: 'Australia/Brisbane', type: 'regional capital', capital: 'region',
    region: { id: 2152274, code: '04', iso: 'AU-QLD', name: 'Queensland',
              type: 'State' },
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
```

`country` and `time` are derived, not stored: `country` out of an ISO 3166 table in the
package, `time` out of the runtime's own `Intl` zone data, so neither needs an install
and neither is a network call. Where the host's zone data is older or newer than the
one the Python package reads, a daylight boundary may move by a transition.

```js
{
  asn: 13335, handle: 'CLOUDFLARENET', prefix: 24, cidr: '1.1.1.0/24',
  start: '1.1.1.0', end: '1.1.1.255', rpki: 'valid', roas: 1,
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
```

`cidr` is the announcement the address falls in, masked out of the address itself.
`rpki` is `valid`, `invalid` or `unknown` and `roas` how many ROAs agree. `brand` drops
the legal form and the words every network carries, so `GOOGLE` and `Google LLC` both
read `Google`.

```js
db.lookup("185.220.101.1").abuse;
{
  name: 'Tor', service: 'tor_exit_node', evidence: 'measured', risk: 0.97,
  network_risk: null, last_seen_days: 1, is_anycast: false, is_satellite: false,
  is_hosting_provider: true, is_proxy: false, is_public_proxy: false,
  is_residential_proxy: false, is_anonymous_vpn: false, is_tor_exit_node: true,
  is_private_relay: false, is_anonymous: true,
}
```

`risk` is 0 to 1 for the address, `network_risk` the same for the whole ASN, `null`
where nothing has ever been seen, so which is not a risk of zero.

## What an address says on its own

Answered without the database, so they hold for every address:

```js
const found = db.lookup("2606:4700::1111");
found.number;    // 50543257672059871404715951523469725969n
found.compressed // '2606:4700::1111'
found.expanded;  // '2606:4700:0000:0000:0000:0000:0000:1111'
found.arpa;      // '1.1.1.1.0.0.….0.7.4.6.0.6.2.ip6.arpa'
```

`number` is a `bigint` for v6 and a `number` for v4, so `JSON.stringify` needs a
replacer where you hand a v6 result on. Then `is_global` and `is_bogon`, `is_private`,
`is_loopback`, `is_multicast`, `is_reserved`, `is_link_local`, `is_unique_local`,
`is_documentation`, `is_shared` (100.64/10) and `is_benchmark` (198.18/15), bisected
out of the IANA special-purpose registries.

```js
db.lookup("::ffff:8.8.8.8").tunnel;         // 'ipv4-mapped'
db.lookup("::ffff:8.8.8.8").embedded_ipv4;  // '8.8.8.8'
db.lookup("2002:808:808::1").is_6to4;       // true
```

`tunnel` is `ipv4-mapped`, `6to4`, `teredo`, `nat64` or `null`.

```js
db.lookup("2001:67c:e60:c0c:192:42:116:55").decimal_ipv4;  // '192.42.116.55'
```

`decimal_ipv4` is a guess and never a tunnel: the last four hextets where an operator
wrote a v4 address into them as decimal. It is `null` wherever a real tunnel answers.

```js
db.lookup("8.8.8.8").as_ipv4_mapped;  // '::ffff:8.8.8.8'
db.lookup("8.8.8.8").as_6to4;         // '2002:808:808::'
db.lookup("8.8.8.8").as_nat64;        // '64:ff9b::808:808'
```

`as_ipv4_mapped`, `as_6to4` and `as_nat64` write a v4 address the other way about, as
the v6 addresses that carry it; all three are `null` for a v6 address, where
`embedded_ipv4` already says what it carries.

## What DNS says, where you ask for it

`lookup` never leaves the machine and stays synchronous. `resolve` is the same lookup
with DNS behind a flag, and does nothing more than `lookup` unless the flag is set:

```js
(await db.resolve("8.8.8.8", { dns: true })).dns;
{
  asked: '8.8.8.8',
  hostname: 'dns.google',
  hostnames: [ 'dns.google' ],
  ipv4: '8.8.4.4',
  ipv6: '2001:4860:4860::8888',
  ipv4_addresses: [ '8.8.4.4', '8.8.8.8' ],
  ipv6_addresses: [ '2001:4860:4860::8888', '2001:4860:4860::8844' ],
  alias: null,
  zone: '8.8.8.in-addr.arpa',
  zone_primary: 'ns1.google.com',
  zone_contact: 'dns-admin@google.com',
  is_confirmed: true,
  is_signed: true,
}
```

`hostname` is the first PTR name and `hostnames` all of them, `ipv4` and `ipv6` that
name resolved forward with `ipv4_addresses` and `ipv6_addresses` all of those, so each
address names its other half; `is_confirmed` says the name leads back to the address,
which is forward-confirmed reverse DNS; `zone`, `zone_primary` and `zone_contact` come
from the reverse zone's SOA, naming who runs the range; `is_signed` is the DNSSEC
verdict and `alias` a CNAME in the way; `asked` is the address actually asked about,
which for a tunnel is the v4 it carries. Four questions go out in two rounds, PTR and
SOA on the reverse name together and then A and AAAA of the hostname: Node, Deno and
Bun write those onto the wire themselves and send them to every server at once, so the
machine's own from `node:dns` and 1.1.1.1, 8.8.8.8 and 9.9.9.9, so first real answer
winning, TCP where one comes back truncated, while a browser or a worker, having no
datagram, sends the same queries to Cloudflare and Google over DNS-over-HTTPS. Answers
are kept for an hour, and nothing is asked where the flag is off, which keeps a bundled
reader as offline as it was.

## In a browser

No build step and no install: the package is plain ESM with no dependencies, so any npm
CDN serves it as it is.

```html
<script type="module">
  import { open } from "https://cdn.jsdelivr.net/npm/plevinjs";

  const db = await open(
    "https://plevin.tn3w.dev/db/plevin.place-country-code.plv"
  );
  const { flag, name } = db.lookup("1.1.1.1").place.country;
  document.body.textContent = `${flag} ${name}`;             // '🇺🇸 United States'
</script>
```

Open the smallest build a page actually needs: `plevin.place-country-code.plv` is
423 KB against the 16.9 MB of `plevin.plv`, so the first lookup lands in a moment
rather than a download.

| | |
| --- | --- |
| `https://cdn.jsdelivr.net/npm/plevinjs` | `dist/plevin.min.js`, the whole reader in one file |
| `https://unpkg.com/plevinjs` | the same as jsDelivr |
| `https://esm.sh/plevinjs` | the modules as published, imports rewritten |
| `https://plevin.tn3w.dev/plevin/plevin.min.js` | the reader beside the databases |

jsDelivr and unpkg serve the bundle named by the `jsdelivr`/`unpkg` fields, 44 kB of
JavaScript with no further requests. The bare `dist/index.js` is not usable from those
URLs: it imports `./reader.js` and neighbours, which resolve against `/npm/` there and
404. Pin a version for anything that ships: `cdn.jsdelivr.net/npm/plevinjs@0.1.2`.
`plevinjs/node` is the only entry that touches Node, so a CDN import never reaches for
`node:fs`.

18 MB crosses the wire once, so keep it out of the critical path and out of the next
visit's way:

```js
const store = await caches.open("plevin");
const url = "https://plevin.tn3w.dev/db/plevin.plv";
if (!(await store.match(url))) await store.add(url);

const held = await store.match(url);
const db = new Plevin(new Uint8Array(await held.arrayBuffer()));
```

`plevin.place-country-code.plv` is 423 KB where the country code is all a page needs.
[The lookup page](https://plevin.tn3w.dev/) is the whole idea in one file of
plain JavaScript: it reads the database in the tab and calls out only for the visitor's
own address and for hostnames.

## Speed

Measured on the full file, Node 26, one core:

| | |
| --- | --- |
| open | 14 ms, the header only |
| first answer | 44 ms, the blocks it lands in |
| repeats | 4,600,000/s |
| uniformly random v4 | 13,000/s cold, 200,000/s over the same log again |

Blocks decode on reach and stay decoded, so a real log lands between the two. Memory is
the file plus whatever it decoded, around 120 MB of heap with the whole world touched.

## Zstandard

The file is Zstandard with trained dictionaries, which no runtime decompresses on its
own, so `DecompressionStream` has no zstd and Node's `zlib` takes no dictionary. So the
package carries one, condensed from [fzstd](https://github.com/101arrowz/fzstd) (MIT)
with the dictionary support it leaves out, and verified block for block against
libzstd over the whole database.

```js
import { decompress, loadDictionary } from "plevin/zstd";

decompress(frame);                          // one frame
decompress(frame, loadDictionary(trained)); // with a trained dictionary
```

## Development

```bash
cd js
npm ci
npm test          # node --test, no database needed for most of it
npm run lint      # biome
npm run typecheck # tsc, strict
npm run build     # dist/, ESM and .d.ts, plus the CDN bundle
npm run bundle    # dist/plevin.min.js only (esbuild)

node test/compare.ts ../plevin.plv sample.json  # field for field against Python
node test/blocks.ts ../plevin.plv 100000        # every block against libzstd
```

## License

Apache 2.0, see [LICENSE](https://github.com/tn3w/plevin/blob/master/LICENSE). The
database carries the licenses of the sources it was built from, listed in
[`builder/README.md`](https://github.com/tn3w/plevin/blob/master/builder/README.md#sources).

<!-- brand: Noto Sans 800, wordmark bar #1868f2 place, #6f42c1 network, #2ea043 abuse; #7d8894 address, ink #0b1220 light, #f0f6fc dark -->
