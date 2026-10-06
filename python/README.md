<div align="center">
<a href="https://pypi.org/project/plevin">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/title-light.png" width="320" alt="plevin">
</picture>
</a>

**Location, network and abuse information for any IP address in one offline file.**<br>
No API, no rate limit, no lookup leaving the machine.

[![PyPI](https://img.shields.io/pypi/v/plevin?color=1868f2)](https://pypi.org/project/plevin)
[![Python](https://img.shields.io/badge/python-3.10%2B-1868f2)](https://pypi.org/project/plevin)
[![License](https://img.shields.io/badge/license-Apache--2.0-1868f2)](https://github.com/tn3w/plevin/blob/master/LICENSE)
[![Fields](https://img.shields.io/badge/fields-91-6f42c1)](#fields)
[![Warm](https://img.shields.io/badge/warm%20lookups-2M%2Fs-2ea043)](#speed)

</div>

## Quick start

```bash
pip install "plevin[db,full]"
```

```python
>>> import plevin
>>> found = plevin.lookup("1.1.1.1")   # str, int, bytes or ipaddress object

>>> found.place.city.name, found.place.city.region.name, found.place.country.name
('Brisbane', 'Queensland', 'Australia')

>>> found.network.asn, found.network.operator.brand, found.network.cidr
(13335, 'Cloudflare', '1.1.1.0/24')

>>> exit_node = plevin.lookup("185.220.101.1")
>>> exit_node.abuse.service, exit_node.abuse.risk, exit_node.abuse.is_tor_exit_node
('tor_exit_node', 0.99, True)
```

- `lookup` always answers a `Result` and raises `ValueError` for non-addresses;
  `found` is false where the file knows nothing of the address.
- Integers up to `0xFFFFFFFF` are v4, so `lookup(1)` is `0.0.0.1`.
- No dependencies. `full` adds `pycountry`, `babel` and `phonenumbers` (and `tzdata` on
  Windows) for country names, currency, calling code, languages and local time.

## Databases

The database ships as its own wheel and is found automatically. With several
installed, the richest wins.

| extra             | size    | carries                                  |
| ----------------- | ------- | ---------------------------------------- |
| `plevin[db]`      | 19.2 MB | every field                              |
| `plevin[place]`   | 6.3 MB  | city, region, postal, coordinates, metro |
| `plevin[network]` | 7.4 MB  | ASN, operator, routing, registry         |
| `plevin[abuse]`   | 4.2 MB  | abuse level, service and provider        |
| `plevin[country]` | 378 KB  | country code                             |

Your own file: `PLEVIN_DB=/path/to/plevin.plv`, `plevin.use(path)`, or
`plevin.Plevin(path)` for a separate instance. `.built`, `.selection` and `.fields`
describe it.

## Fields

<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-light.png" width="840" alt="address to place, network and abuse">
</picture>

`place`, `network` and `abuse` are `None` where the build carries none of them. A
missing leaf is `None`, never `""` or `0`.

### Place

```python
Place(
    lat=-27.4675, lon=153.0281, accuracy=200, confidence=36, granularity='city',
    city=City(
        id=2174003, name='Brisbane', ascii=None,
        population=2780063, elevation=27, postal='4000', postal_partial=None,
        timezone='Australia/Brisbane', type='regional capital', capital='region',
        region=Region(id=2152274, code='04', iso='AU-QLD', name='Queensland',
                      type='State'),
        district=District(id=7839562, code='31000', name='Brisbane'),
        metro=None,
    ),
    country=Country(
        code='AU', name='Australia', official=None, common=None, iso3='AUS',
        numeric='036', flag='🇦🇺', continent='OC', currency='AUD',
        currency_name='Australian Dollar',
        calling_code='+61', languages=('en',), european_union=False,
        driving_side='left',
    ),
    time=Time(
        abbreviation='AEST', local='2026-08-13T19:20:00+10:00', utc_offset='+10:00',
        is_dst=False, dst_start=None, dst_end=None,
    ),
)
```

| field            | meaning                                                         |
| ---------------- | --------------------------------------------------------------- |
| `accuracy`       | radius in km                                                    |
| `confidence`     | 0 to 100                                                        |
| `capital`        | which capital the city is, if any                               |
| `ascii`          | plain-ASCII spelling, only where it differs from `name`         |
| `region.iso`     | ISO 3166-2; `region.code` is the GeoNames admin1 code           |
| `postal_partial` | leading part of `postal`, where a source knows only that much   |
| `granularity`    | `city`; `region` or `country` leaves `city` only its `region`, `country` and `timezone` |
| `country`, `time`| derived; names, currency, calling code, languages and clock need the `full` extra |
| `continent`      | `AF`, `AN`, `AS`, `EU`, `NA`, `OC` or `SA`                      |
| `european_union` | member states and their outermost regions (Réunion, Guadeloupe, Åland, …) |
| `languages`      | official and de facto languages, one entry per language, most spoken first |
| `time`           | from `city.timezone`; `None` where the zone is unknown          |

### Network

```python
Network(
    asn=13335, handle='CLOUDFLARENET', prefix=24, cidr='1.1.1.0/24',
    start='1.1.1.0', end='1.1.1.255', rir='apnic', country='AU', since=2011,
    rpki='valid', roas=1,
    operator=Operator(
        company='Cloudflare, Inc.', brand='Cloudflare', domain='cloudflare.com',
        website='https://cloudflare.com', category='cdn', tier=2, peering=354,
        cone=1022, scope='Global', rir='arin', since=2010,
        street='101 Townsend St', state='CA', postal='94107-1934', country='US',
        abuse_email='abuse@cloudflare.com', city=City(id=5391959, name='San Francisco'),
    ),
    carrier=Carrier(user_type='cdn', user_count=18, mcc=None, mnc=None,
                    is_mobile=False),
)
```

| field      | meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `cidr`     | the announced prefix the address falls in                               |
| `rir`      | registry of the address, which may differ from the ASN's (`operator.rir`) |
| `country`  | country the registry lists for the block, not where it is used (`place.country`) |
| `since`    | year the registry lists for the block                                   |
| `rpki`     | `valid`, `invalid` or `unknown` (announced, no ROA); `roas` counts agreeing ROAs, or conflicting ones where `invalid` |
| `brand`    | company without legal form: `GOOGLE`, `Google LLC` → `Google`           |
| `domain`   | registered domain of `website`, else of `abuse_email` where the mailbox is the operator's own: its name matches, or a `gov`, `mil`, `edu` body; free mail and social sites never count |
| `website`  | stored as host and path, read as `https://`                             |
| `tier`     | 1 transit-free, 2 has customers, 3 edge                                 |
| `peering`  | internet exchange count                                                 |
| `cone`     | ASNs in its customer cone, itself included: 1 is a network with no customers (CAIDA AS Rank) |
| `city`     | the registered address's city: its GeoNames `id` and `name`, nothing else |
| `carrier.user_type` | what the range is used for: the feed that names the range, else the operator's `category` |
| `carrier.user_count` | estimated internet users behind the ASN (APNIC)                |
| `carrier.mcc`, `mnc` | mobile country and network code where a carrier's name matches; `mnc` only where one network code fits |
| `category` | `residential`, `business`, `hosting`, `education`, `government`, `military`, `cdn`, `content`, `infrastructure`, `cellular`, `search_engine_spider`, `traveler`, `transit`, `exchange`, `non-profit` |

Unannounced space (about a seventh of routable IPv4) still answers: `asn`, `rpki` and
`roas` are `None`, `cidr` is the registry block, `handle` and `operator` its holder.
ARIN and LACNIC publish no holders, so their unannounced space has no name. Reserved
space has no `network` at all.

```python
>>> found = plevin.lookup("36.50.238.1")
>>> found.network.asn, found.network.cidr, found.network.handle, found.network.country
(None, '36.50.238.0/23', 'GMTECH-BD', 'BD')
```

### Abuse

```python
Abuse(
    provider='Tor', service='tor_exit_node', evidence='measured',
    threat='spam', level='high', risk=0.99, network_risk=0.88, last_seen_days=1,
    is_malicious=True, is_anycast=False, is_satellite=False, is_crawler=False,
    is_hosting_provider=True, is_proxy=False, is_public_proxy=False,
    is_residential_proxy=False, is_anonymous_vpn=False, is_tor_exit_node=True,
    is_private_relay=False, is_anonymous=True,
)
```

| field          | meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `risk`         | 0 to 0.99 for the address; `None` means never seen, not zero             |
| `network_risk` | the same for the whole ASN                                               |
| `level`        | `low` ≥ 0.40, `medium` ≥ 0.60, `high` ≥ 0.80, else `None`                |
| `is_malicious` | a level is set                                                           |
| `service`      | `tor_exit_node`, `private_relay`, `anonymous_vpn`, `residential_proxy`, `public_proxy` |
| `evidence`     | `published`, `measured`, `reported`, `inferred` (strongest first)        |
| `threat`       | what the address was reported for: `botnet`, `malware`, `phishing`, `bruteforce`, `web_attack`, `spam`, `scanner` |
| `provider`     | who runs the service: the feed's name, else the network's brand          |
| `is_crawler`   | a published search engine or AI crawler range                            |
| booleans       | derived from `service` and the carrier type                              |
| baseline       | a service, `is_anycast` or `is_satellite` known for the whole ASN reaches every address in it; risk, level and threat stay per address |

`risk` combines what the service is worth on its own with every feed that reported
the address: each agreeing source raises it, feeds sharing an upstream count once. An
unreported Tor exit already reads high; one on four blocklists reads higher. A public
proxy on a residential or cellular line reads as `residential_proxy`, `inferred`.

### Address

No database needed:

```python
>>> found = plevin.lookup("2606:4700::1111")
>>> found.number, found.ip, found.expanded
(50543257672059871404715951523469725969, '2606:4700::1111',
 '2606:4700:0000:0000:0000:0000:0000:1111')

>>> plevin.lookup("::ffff:8.8.8.8").tunnel, plevin.lookup("::ffff:8.8.8.8").embedded_ipv4
('ipv4-mapped', '8.8.8.8')

>>> found = plevin.lookup("8.8.8.8")
>>> found.as_ipv4_mapped, found.as_6to4, found.as_nat64
('::ffff:8.8.8.8', '2002:808:808::', '64:ff9b::808:808')
```

| field                   | meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `ip`, `expanded`        | the shortest spelling; `expanded` only for v6 (`None` for v4) |
| `arpa`                  | reverse DNS name                                             |
| `is_global`             | plus `is_private`, `is_loopback`, `is_multicast`, `is_reserved`, `is_link_local`, `is_unique_local`, `is_documentation`, `is_shared`, `is_benchmark` (IANA registries); none set means global |
| `tunnel`                | `ipv4-mapped`, `6to4`, `teredo`, `nat64` or `None`; `embedded_ipv4` is the v4 inside |
| `decimal_ipv4`          | a guess: v4 written as decimal into the last four hextets    |
| `as_*`                  | v6 forms of a v4 address; `None` for v6                      |

### DNS

Off by default: the only part of a lookup that leaves the machine.

```python
>>> plevin.lookup("8.8.8.8", dns=True).dns
Dns(
    asked='8.8.8.8', hostnames=('dns.google',),
    ipv4_addresses=('8.8.4.4', '8.8.8.8'),
    ipv6_addresses=('2001:4860:4860::8888', '2001:4860:4860::8844'),
    alias=None, zone='8.8.8.in-addr.arpa', zone_primary='ns1.google.com',
    zone_contact='dns-admin@google.com', is_confirmed=True, is_signed=True,
)
```

- **Names:** `hostnames` are the PTRs, `ipv4_addresses`/`ipv6_addresses` what the
  first one resolves to forward.
- **Checks:** `is_confirmed` means forward-confirmed reverse DNS; `is_signed` means
  DNSSEC.
- **Zone:** `zone`, `zone_primary` and `zone_contact` come from the reverse zone's SOA.
- **Queries:** PTR and SOA, then A and AAAA, raced across the system resolver plus
  1.1.1.1, 8.8.8.8 and 9.9.9.9, with TCP on truncation.
- **Cache:** answers are kept for one hour.

## ASNs

```python
>>> found = plevin.system("AS13335")            # 'AS13335', 'as13335' or 13335
>>> found.handle, found.network.operator.brand, found.abuse.network_risk
('CLOUDFLARENET', 'Cloudflare', 0.14)

>>> [one.asn for one in plevin.search("hetzner")]
[24940, 212317, 213230, 215859]

>>> routes = plevin.routes("AS13335")
>>> len(routes.ipv4), len(routes.ipv6), routes.ipv4_addresses
(1411, 884, 592896)
```

| call                     | answers                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `system(asn)`            | `System`: handle, network, operator, carrier, ASN abuse; falsy if unknown |
| `search(text, limit=20)` | `System`s whose handle or company matches; word starts first, then reach |
| `routes(asn)`            | `Routes`: every announced prefix as a `Span`, widest first, plus space covered |

## Speed

Full file, one core:

| operation           | speed                                    |
| ------------------- | ---------------------------------------- |
| open                | 1 ms, memory-mapped                      |
| first lookup        | 30 ms                                    |
| repeats             | 2,060,000/s                              |
| random v4           | 9,000/s cold, 50,000/s warm              |
| `system`            | 160,000/s                                |
| `routes`            | 90–120 ms, then cached                   |
| `search`            | 2 ms, after 0.22 s building the index    |

Blocks decode lazily, only as far as a lookup reaches, and stay decoded. Files are
read-only and shared across processes and threads. `Plevin(path).file.row(value, wide)`
gives the raw rows without models.

## More

- [Mini file](https://github.com/tn3w/plevin/blob/master/plevin_mini.py): the lookup in
  one 280-line file, plain dictionaries.
- [JavaScript](https://github.com/tn3w/plevin/blob/master/js/README.md): the same
  reader for Node, Deno, Bun, Workers and browsers.
- [Builder](https://github.com/tn3w/plevin/blob/master/builder/README.md): sources,
  file format, custom selections.

## Development

```bash
cd python
uv run pytest          # 255 tests, 100% branch coverage
uv run mypy && uv run basedpyright
uvx ruff check . ../plevin_mini.py --config pyproject.toml
uv build --wheel
```

## License

Apache 2.0, see [LICENSE](https://github.com/tn3w/plevin/blob/master/LICENSE). The
database carries the licenses of its
[sources](https://github.com/tn3w/plevin/blob/master/builder/README.md#sources).

<!-- brand: Noto Sans 800, wordmark bar #1868f2 place, #6f42c1 network, #2ea043 abuse; #7d8894 address, ink #0b1220 light, #f0f6fc dark -->
