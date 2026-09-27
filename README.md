<div align="center">
<a href="https://plevin.tn3w.dev">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-light.png" width="320" alt="plevin">
</picture>
</a>

**Location, network and abuse information for any IP address in one offline file.**<br>
No API, no rate limit, no lookup leaving the machine.

[![PyPI](https://img.shields.io/pypi/v/plevin?color=1868f2)](https://pypi.org/project/plevin)
[![npm](https://img.shields.io/npm/v/plevinjs?color=1868f2&label=npm)](https://www.npmjs.com/package/plevinjs)
[![License](https://img.shields.io/badge/license-Apache--2.0-1868f2)](LICENSE)
[![Fields](https://img.shields.io/badge/fields-101-6f42c1)](#fields)
[![Boundaries](https://img.shields.io/badge/boundaries-3.0M-6f42c1)](#data)
[![Warm](https://img.shields.io/badge/warm%20lookups-2M%2Fs-2ea043)](python/README.md#speed)

[Python](python/README.md) · [JavaScript](js/README.md) · [Builder](builder/README.md) ·
[Lookup page](https://plevin.tn3w.dev) · [API](#http-api)

</div>

## Quick start

```bash
pip install "plevin[db,full]"               # Python
npm install plevinjs                        # Node, Deno, Bun, Workers, browsers
curl https://plevin.tn3w.dev/api/1.1.1.1    # HTTP, nothing to install
```

```python
>>> import plevin
>>> found = plevin.lookup("1.1.1.1")
>>> found.place.city.name, found.network.operator.brand, found.network.cidr
('Brisbane', 'Cloudflare', '1.1.1.0/24')

>>> plevin.lookup("185.220.101.1").abuse.service
'tor_exit_node'
```

```js
import { open } from "plevinjs";

const db = await open("https://plevin.tn3w.dev/db/plevin.plv");
db.lookup("1.1.1.1").network.operator.brand;   // 'Cloudflare'
```

## Databases

One file per build, rebuilt daily. Pick the smallest one that answers your question.

| build   | pip extra         | size    | carries                                  |
| ------- | ----------------- | ------- | ---------------------------------------- |
| full    | `plevin[db]`      | 17.3 MB | every field                              |
| place   | `plevin[place]`   | 5.4 MB  | city, region, postal, coordinates, metro |
| network | `plevin[network]` | 7.0 MB  | ASN, operator, routing                   |
| abuse   | `plevin[abuse]`   | 4.1 MB  | abuse level, service and provider        |
| country | `plevin[country]` | 378 KB  | country code                             |

Download from the [latest release](https://github.com/tn3w/plevin/releases/latest), or
from [plevin.tn3w.dev/db](https://plevin.tn3w.dev/db/) with open CORS.

## Fields

<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-light.png" width="840" alt="address to place, network and abuse">
</picture>

| group     | answers                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `place`   | coordinates, accuracy, city, region, district, metro, country, local time   |
| `network` | ASN, handle, CIDR, registry, RPKI, operator with address, mobile carrier    |
| `abuse`   | risk, level, service (Tor, VPN, proxy, relay), threat, evidence, provider, flags |
| address   | spellings, special ranges, tunnels, embedded IPv4, no database needed      |
| `dns`     | PTR, forward-confirmed name, SOA, DNSSEC, only when asked                  |

A missing value is `None`/`null`, never `""` or `0`. Full reference with every field:
[Python](python/README.md#fields) · [JavaScript](js/README.md#fields).

## Blocklist

[`blocklist.netset`](https://github.com/tn3w/plevin/releases/latest/download/blocklist.netset)
holds 542k CIDRs, 8.2 MB: every address feeds reported at 40 or above, plus every address a
current list names as an anonymising service. Per-address only: no ASN-wide scores, no
reserved space.

```bash
ipset create plevin hash:net
awk '!/^#/' blocklist.netset | xargs -n1 ipset add plevin
```

## Lookup page

[plevin.tn3w.dev](https://plevin.tn3w.dev) runs the database inside the browser tab.
Type an address, a hostname, an ASN (`AS13335`) or a network name. Only your own
address and DNS questions leave the tab. Source: [`site/`](site).

## HTTP API

[`worker/`](worker) is a Cloudflare Worker answering the same JSON as the readers:

```bash
curl https://plevin.tn3w.dev/api/1.1.1.1          # any address
curl https://plevin.tn3w.dev/api/me               # the caller
curl https://plevin.tn3w.dev/api/about            # build and fields
curl "https://plevin.tn3w.dev/api/1.1.1.1?dns=1"  # with DNS
```

- CORS open, no key.
- Cached 5 min, 1 min with DNS.
- `400` for a bad or missing address, `503` without a database.

<details>
<summary>Deploy your own</summary>

```bash
cd worker && npm install
npx wrangler kv namespace create PLEVIN   # id → KV_NAMESPACE_ID secret
npx wrangler kv key put --binding PLEVIN --remote plevin.plv --path ../plevin.plv
npx wrangler deploy
```

[`deploy-worker.yml`](.github/workflows/deploy-worker.yml) deploys on a push to
`worker/` or `js/` and refreshes KV on every release.

- **Secrets:** `KV_NAMESPACE_ID`, `ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_API_TOKEN`.
- **Variable:** `WORKER_ROUTE`.
- **Token needs:** Workers Scripts, Workers KV Storage and Workers Routes edit rights.
- **Smaller build:** set `DATABASE` to a file other than `plevin.plv`.

</details>

## Mini file

[`plevin_mini.py`](plevin_mini.py): the lookup without the package. 280 lines, standard
library only. Plain dictionaries, no derived fields.

```bash
python plevin_mini.py plevin.plv 8.8.8.8
```

## Data

| rows              | count                                   |
| ----------------- | --------------------------------------- |
| v4 boundaries     | 2,848,750, plus 4,513,313 host overrides |
| v6 boundaries     | 451,590                                 |
| cities            | 76,867 in 3,175 regions                 |
| districts, metros | 19,997 and 210                          |
| ASNs, networks    | 86,164 and 148,809 (registry holders included) |
| timezones         | 394                                     |
| abuse records     | 5,630 from 210 feeds                    |

Sources: MaxMind GeoLite2, IP2Location LITE, DB-IP Lite, GeoNames, Natural Earth, RIPE RIS, RPKI,
NRO, RIPE/APNIC/AFRINIC/LACNIC whois, operator geofeeds, CAIDA, PeeringDB, [asn-abuse](https://github.com/tn3w/asn-abuse)
and [210 feeds](builder/README.md#sources).

## Development

```bash
cd python && uv run pytest && uv run mypy && uv run basedpyright
uvx ruff check . ../plevin_mini.py --config pyproject.toml

cd ../js && npm ci && npm test && npm run lint && npm run typecheck

cd ../builder && cargo fmt --check && cargo clippy && cargo test
```

`js/test/compare.ts` checks both readers field for field; `js/test/blocks.ts` checks
the JavaScript LZMA decoder against liblzma on every block.

## License

Apache 2.0 for code ([LICENSE](LICENSE)). The database carries the licenses of its
[sources](builder/README.md#sources).

<!-- brand: Noto Sans 800, wordmark bar #1868f2 place, #6f42c1 network, #2ea043 abuse; #7d8894 address, ink #0b1220 light, #f0f6fc dark -->
