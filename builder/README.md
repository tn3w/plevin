<div align="center">

# plevin builder

**26 source files, operator geofeeds and 210 feeds in one offline `.plv` database.**

![Rust 2024](https://img.shields.io/badge/rust-2024-CE422B?logo=rust&logoColor=white)
![License](https://img.shields.io/badge/license-Apache--2.0-1868f2)
![Full build](https://img.shields.io/badge/full%20build-18.2%20MB-2ea043)
![Sources](https://img.shields.io/badge/sources-26%20files%20%2B%20210%20feeds%20%2B%20geofeeds-6f42c1)

[everything](https://github.com/tn3w/plevin/releases/latest/download/plevin.plv) 18.2 MB ·
[location](https://github.com/tn3w/plevin/releases/latest/download/plevin.metro-place.plv) 6.3 MB ·
[network](https://github.com/tn3w/plevin/releases/latest/download/plevin.network.plv) 7.0 MB ·
[abuse](https://github.com/tn3w/plevin/releases/latest/download/plevin.abuse-level-abuse-provider-abuse-service.plv) 4.1 MB ·
[country](https://github.com/tn3w/plevin/releases/latest/download/plevin.place-country-code.plv) 378 KB ·
[blocklist](https://github.com/tn3w/plevin/releases/latest/download/blocklist.netset) 8.2 MB

</div>

```mermaid
flowchart LR
    S["26 files + geofeeds + 210 feeds"] --> B[builder] --> D[("plevin.plv")] --> Q["lookup(8.8.8.8)"]
```

## Build

```bash
cargo build --release

./target/release/plevin-builder                    # dist/plevin.plv, every field
./target/release/plevin-builder place+metro        # dist/plevin.metro-place.plv
./target/release/plevin-builder network            # dist/plevin.network.plv
./target/release/plevin-builder blocklist.netset   # dist/blocklist.netset
```

About a minute from fetched inputs. [`build.yml`](../.github/workflows/build.yml)
fetches, builds and releases daily, with secrets `IP2LOCATION_TOKEN` and
`PEERINGDB_API_KEY`. The build log names **silent feeds**: listed feeds that matched
nothing, a dead URL or a changed format. The fetch log lists every feed's size
(`size` lines) to spot a feed that came back thin.

| path                  | holds                          |
| --------------------- | ------------------------------ |
| `src/`                | the builder, ten files         |
| `data/feeds.json`     | feeds, one entry each          |
| `data/operators.json` | brands and satellite ASNs      |
| `data/regions.json`   | region code fixes              |
| `data/metros.json`    | US market labels               |
| `inputs/`             | fetched sources (ignored)      |
| `dist/`               | output (ignored)               |

## Selections

`term+term` builds only what the terms need; no argument builds everything.

```mermaid
flowchart LR
    T["place+metro"] --> F[fields] --> C[columns] --> R[rows kept] --> B[boundaries merged]
```

- **Rebuilt, not sliced:** a dropped field takes its column, strings and boundaries
  with it.
- **Answers never change** with the selection. The union of two selections is
  byte-identical to building both.
- **Derived booleans** keep only the values they ask about; `abuse.is_tor_exit_node`
  alone builds to tens of kilobytes.
- **`abuse.level`** builds small: one boundary per step, nothing below 0.40.
- **`network.operator.brand`** alone stores the brand itself, not the handle and
  company it is derived from.
- **`abuse.provider`** links a network only where a service record reaches it.
- **Naming:** the selection is written into the file and the filename.

## Blocklist

`blocklist.netset`: addresses feeds reported at 40 or above, plus addresses a current
list names as an anonymising service (`published` or `measured` evidence only). It
reads what was said about the address itself, not what its service is worth or what
its ASN scores. Published CDN and crawler ranges never make it: reports there are
shared-edge noise. Ranges are merged into the fewest aligned CIDRs, reserved space cut.

## Sources

![CC BY 4.0](https://img.shields.io/badge/CC%20BY%204.0-7%20sources-1868f2)
![CC BY-SA 4.0](https://img.shields.io/badge/CC%20BY--SA%204.0-IP2Location-1868f2)
![Public domain](https://img.shields.io/badge/public%20domain-Natural%20Earth-2ea043)
![EULA](https://img.shields.io/badge/EULA-GeoLite2-orange)

Fetched flat into `inputs/`; gzip inflated, zip reduced to its largest member.

| file                                                  | from                                                        | license          |
| ----------------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| `GeoLite2-City.mmdb`                                  | `github.com/P3TERX/GeoLite.mmdb`, latest release            | GeoLite2 EULA    |
| `IP2LOCATION-LITE-DB11.IPV6.BIN`                      | `ip2location.com/download?token=…&file=DB11LITEBINIPV6`     | CC BY-SA 4.0     |
| `dbip-city-lite.mmdb`                                 | `download.db-ip.com/free/`, this or last month              | CC BY 4.0        |
| `cities500.txt`, `allCountries.txt`                   | `download.geonames.org/export/dump/`, `/export/zip/`        | CC BY 4.0        |
| `admin1CodesASCII.txt`, `admin2Codes.txt`             | `download.geonames.org/export/dump/`                        | CC BY 4.0        |
| `ne_10m_admin_0_countries.*`, `ne_10m_admin_1_…dbf`   | `naciscdn.org/naturalearth/10m/cultural/`                   | public domain    |
| `iso_3166-2.json`                                     | `salsa.debian.org/iso-codes-team/iso-codes`                 | LGPL 2.1+        |
| `bview`                                               | `data.ris.ripe.net/rrc00/latest-bview.gz`, 4 GB             | RIPE NCC terms   |
| `vrps.csv`                                            | `console.rpki-client.org/vrps.csv`                          | public RPKI data |
| `nro-delegated-stats`                                 | `ftp.ripe.net/pub/stats/ripencc/nro-stats/latest/`          | open RIR stats   |
| `asn.txt`                                             | `ftp.ripe.net/ripe/asnames/`                                | RIPE NCC terms   |
| `as-org2info.txt`, `as-rel2.txt`                      | `publicdata.caida.org/datasets/`, newest                    | CAIDA AUP        |
| `peeringdb_net.json`, `_org.json`, `_netixlan.json`   | `peeringdb.com/api/`, with API key                          | CC BY 4.0        |
| `abuse-contacts.tsv`                                  | `github.com/tn3w/asn-abuse`, latest release                 | source repository |
| `ripe_inetnum`, `ripe_inet6num`, `ripe_organisation`  | `ftp.ripe.net/ripe/dbase/split/`                            | RIPE NCC terms   |
| `apnic_inetnum`, `apnic_inet6num`, `apnic_organisation` | `ftp.apnic.net/apnic/whois/`                              | APNIC terms      |
| `afrinic_db`                                          | `ftp.afrinic.net/dbase/afrinic.db.gz`                       | AFRINIC terms    |
| `lacnic_db`                                           | `ftp.lacnic.net/lacnic/dbase/lacnic.db.gz`, Latin-1         | LACNIC terms     |
| `geofeeds`                                            | every RFC 8805 feed the dumps above reference, plus LACNIC's | per operator     |
| feeds                                                 | [`data/feeds.json`](data/feeds.json)                        | per publisher    |

- **Registry dumps** are cut to the keys the builder reads while fetching (`grep -a`:
  dumps hold invalid UTF-8), plus `geofeed:` and geofeed `remarks:`, and read line by
  line.
- **Geofeeds** are fetched concurrently into one file, each row prefixed with its URL.
- **Hostname feeds** (`hosts` key) are resolved to addresses while fetching.
- **ARIN and LACNIC** publish no holder data, so their unannounced space has a registry
  and a block but no name.

### Feed coverage

| kind                          | feeds | examples                                               |
| ----------------------------- | ----: | ------------------------------------------------------ |
| abuse reports                 |    67 | AbuseIPDB, abuse.ch, blocklist.de, DShield, Project Honey Pot |
| VPN servers                   |    37 | provider APIs, [gluetun-servers](https://github.com/qdm12/gluetun-servers), resolved hostnames |
| public proxies                |    14 | scraped proxy lists, IP2Proxy                          |
| Tor, relays                   |     4 | Onionoo exits, iCloud Private Relay, Cloudflare WARP   |
| cloud, hosting                |    21 | AWS, GCP, Azure, Oracle, IBM, geofeeds of hosters      |
| crawlers                      |    17 | Google, Bing, Apple, OpenAI, Perplexity, CCBot, Kagi   |
| CDN, content, SaaS            |    19 | Cloudflare, Fastly, Gcore, Imperva, Atlassian, Stripe  |
| exchanges                     |     1 | PeeringDB IXP peering LANs                             |
| ASN tags, DROP                |    19 | bgp.tools, Spamhaus DROP and ASN-DROP, risk-db         |
| satellite, SASE               |     2 | Starlink geofeed, Zscaler                              |
| dedicated parsers, flags      |     9 | IP2Proxy PX11, IPsum, APNIC users, MCC-MNC, anycast    |

### Feed keys

Each entry in [`data/feeds.json`](data/feeds.json) is a URL plus what its matches mean.

| key            | meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `regex`        | first group is an address, CIDR or (with `scope: "asn"`) an ASN      |
| `format`       | a dedicated parser instead: `ipsum`, `px11`, `asns`, `aspop`, …      |
| `hosts`        | resolve these hostnames while fetching, then match `regex`           |
| `provider`     | named operator of the service or range                               |
| `user`         | category the range is used as                                        |
| `service`, `evidence` | anonymising service and how it is known                       |
| `threat`       | what reporting feeds saw the address do                              |
| `risk`, `group`, `window` | reported risk, shared upstream, days a listing covers     |
| `network_risk` | ASN-wide risk for `scope: "asn"` or prefix feeds                     |
| `flags`        | `is_anycast`, `is_satellite`, `is_mobile`                            |
| `weak`         | `user` yields to any other claim                                     |
| `aged`         | halve service worth: never drops addresses or stopped updating       |
| `trusted`      | operator-published range: damp reports, ignore scraped services      |
| `suffix`       | widen each match to this prefix length                               |
| `geofeed`      | the input is RFC 8805: its rows place the ranges they name           |

## Pipeline

```mermaid
flowchart LR
    G[gazetteer] --> P[place] --> S[spine]
    G --> N[network] --> A[abuse] --> S
    S --> F[(plevin.plv)]
```

| stage     | does                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| gazetteer | cities, regions, districts, postal codes from GeoNames; country of a coordinate from Natural Earth; region ISO codes from `iso_3166-2.json`, then `data/regions.json`, never one ISO does not list |
| place     | operator geofeeds first, then MaxMind, IP2Location where MaxMind has only a country; IP2Location instead when it and DB-IP agree on another city within 25 km; DB-IP agreeing lifts confidence to 90; points interned at 1e-4°; nearest city in the same country within 500 km, else within 3000 km; accuracy is the largest of source radius, snap distance and a per-granularity floor |
| network   | origin ASN by majority of RIS peers; ROAs → `rpki`, `roas`; NRO → registry and year; CAIDA → company, tier; PeeringDB → website, category, peering, address; LACNIC `aut-num` → city where PeeringDB has none; IP2Proxy's most common range domain → website where PeeringDB has none; carriers need a name match, APNIC users and an eyeball network |
| abuse     | one record per span plus an ASN baseline, from feeds declared in `data/feeds.json` |
| spine     | one boundary set carrying place, network and abuse; ids ranked by use       |

### Geofeeds

- **Found** through `geofeed:` and `remarks: Geofeed …` on RIPE, APNIC and AFRINIC
  objects, plus LACNIC's consolidated feed and feeds marked `geofeed` (Cloudflare
  WARP, iCloud Private Relay, Starlink, hosters).
- **Vouched:** a row counts only inside the referencing object, or inside any object of
  the same `org`. Rows claiming someone else's space are dropped. Feeds marked
  `geofeed` are vouched by the operator publishing them.
- **Placed** at a GeoNames city: name within the row's ISO region first, then the
  country; alternate names count, so `Muenchen` and `Göteborg` match.
- **Nested** feeds: the narrowest row wins.
- **Exact:** rows narrower than /24 or /40 keep their own boundaries in builds with
  coordinates; every other source, and builds without coordinates, snap to /24 and
  /40. WARP and relay /32s land on their own city.
- Against the rows themselves, city agreement rises from 59% to 80% on v4 and from 44%
  to 78% on v6.

### Location votes

DB-IP City Lite is a third opinion, never a leading source. Against held-out geofeed
rows:

| DB-IP use                                  | city agreement | place build |
| ------------------------------------------ | -------------: | ----------: |
| none                                       |          61.0% |     5.06 MB |
| confidence only                            |          61.0% |     5.07 MB |
| outvote MaxMind, any distance              |          64.7% |     5.97 MB |
| outvote MaxMind within 25 km (**used**)    |          64.0% |     5.38 MB |
| outvote MaxMind beyond 100 km              |          61.3% |     5.50 MB |

Far disagreements are rare and cost boundaries; near ones are suburb-versus-city calls
two sources settle cheaply. Geofeed rows are never outvoted.

### Abuse scoring

- **Record:** strongest claim wins: best evidence, then most specific service, `weak`
  claims last. The narrowest range names the user type: a crawler inside AWS reads
  `search_engine_spider`, not `hosting`.
- **Risk:** max within a feed `group`, noisy-OR across groups.
- **Service floor:** risk never drops below what the service itself is worth:

  | service           | worth |
  | ----------------- | ----- |
  | Tor exit          | 0.85  |
  | public proxy      | 0.75  |
  | residential proxy | 0.70  |
  | VPN               | 0.50  |
  | private relay     | 0.15  |

  Times 0.85 when reported, 0.6 when inferred, halved again for `aged` feeds: lists that
  never drop an address or stopped updating.
- **Trusted ranges:** operator-published CDN and crawler ranges keep a quarter of their
  reported risk and ignore `reported` or `inferred` service claims. Scraped proxy lists
  and URL feeds name shared edges, not culprits.
- **Threat:** the category of the strongest reporting claim; IP2Proxy's own threat
  column counts at the lowest weight.
- **ASN baseline:** its own feeds, noisy-OR the square root of the risk-weighted share
  of its announced space that was reported. v4 is counted in addresses, v6 in /64s,
  and the worse family stands. Under 0.01 the ASN reads as unseen.
- **`last_seen_days`:** the tightest feed window that hit.

## Fields

```mermaid
flowchart LR
    A([address]) --> P[place] --> C[city] --> R[region]
    C --> D[district]
    C --> M[metro]
    A --> N[network] --> O[operator] --> C
    N --> K[carrier]
    N --> B[abuse]
```

| group     | stored                                                                        |
| --------- | ----------------------------------------------------------------------------- |
| `place`   | point: lat, lon, accuracy, granularity, confidence; city: name, ascii, id, population, type, postal, postal_partial, timezone, elevation, country; region: name, code, iso, type, id; district: name, code, id |
| `metro`   | code, label                                                                   |
| `network` | asn, handle, prefix, rir, rpki, roas; operator: company, website, category, tier, peering, scope, rir, since, street, city, state, postal, abuse_email, country; carrier: user_type, user_count, mcc, mnc |
| `abuse`   | name, service, evidence, threat, is_anycast, is_satellite, risk, level, network_risk, last_seen_days |

Derived by the readers: every `is_*` flag except `is_anycast` and `is_satellite`,
`operator.brand` (from handle and company) and `operator.domain` (stored only where
the website is missing).

| scale                   | unit                          |
| ----------------------- | ----------------------------- |
| `risk`, `network_risk`  | integer percent, 255 unseen   |
| `level`                 | 1–3, 0 unset                  |
| `lat`, `lon`            | degrees × 10,000, signed      |
| `accuracy`              | km                            |
| `confidence`            | 0–100                         |
| `elevation`             | metres, signed                |
| `mcc`, `mnc`            | ITU codes, 0 unknown          |
| `prefix`                | prefix length, 0 unannounced  |
| `postal_partial`        | prefix length of `postal`     |

Link 0 means absent; a value is empty as `""`, the empty vocabulary member or the
sentinel above.

| vocabulary  | members                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| evidence    | published, measured, reported, inferred                                       |
| threat      | botnet, malware, phishing, bruteforce, web_attack, spam, scanner              |
| service     | tor_exit_node, private_relay, anonymous_vpn, residential_proxy, public_proxy  |
| category    | residential, business, hosting, education, government, military, cdn, content, infrastructure, cellular, search_engine_spider, traveler, transit, exchange, non-profit |
| granularity | city, region, country                                                         |
| rpki        | unknown, valid, invalid                                                       |

## File format

```mermaid
flowchart LR
    M[magic] --> V[format 2] --> H[JSON header] --> S[sections]
    S --> A["spine.v4/v6 (bisected)"]
    S --> O["hosts.v4/v6"]
    S --> C["col.* / link.*"]
    S --> T[strings]
```

- **Header:** `PLEVIN\0`, format byte `2`, length, then JSON with fields, vocabularies,
  and the section table. Each section has offset, count, encoding, block and group
  size, and LZMA tuning.
- **Section body:** block count, key width, block offsets, first key per block, blocks.
- **Blocks:** each decodes alone. A block is what the codec packs; a group is what a
  lookup decodes.
- **Columns:** a width byte per block, then fixed-width values (`fixed` or `signed`).
  Rising columns are stored as `delta` steps where that packs smaller.
- **Strings:** one sorted pool, front-coded, restarting every 64.
- **Addresses:** varint gaps, network half only for v6.
- **Block sizes:** 16,384 values, 32,768 addresses (groups of 128), 4,096 strings.

### Codec

Every block is raw LZMA1 (preset 9, 1 MiB window, end marker, no `.lzma` header). Each
section picks its tuning `[lc, lp, pb]` by packing a sample five ways: `[3, 0, 0]` for
text and varints, `[0, 2, 2]` for 4-byte columns. The position-aware tuning is what
zstd cannot do:

| build   | zstd    | LZMA    |      |
| ------- | ------- | ------- | ---- |
| full    | 18.3 MB | 16.4 MB | −10% |
| place   | 6.0 MB  | 5.1 MB  | −15% |
| network | 7.6 MB  | 7.0 MB  | −8%  |
| abuse   | 4.1 MB  | 3.8 MB  | −7%  |
| country | 400 KB  | 376 KB  | −6%  |

LZMA decodes slower than zstd, so readers decode a block only as far as a lookup
reaches and resume later. Warm lookups match zstd; cold ones take about twice as long.

## License

Apache 2.0, see [LICENSE](../LICENSE). Output carries the licenses of the sources above.
