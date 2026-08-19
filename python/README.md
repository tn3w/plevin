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
[![Fields](https://img.shields.io/badge/fields-99-6f42c1)](#every-field)
[![Boundaries](https://img.shields.io/badge/boundaries-3.0M-6f42c1)](#data)
[![Warm](https://img.shields.io/badge/warm%20lookups-2M%2Fs-2ea043)](#speed)

</div>

```bash
pip install "plevin[db,full]"
```

```python
import plevin

found = plevin.lookup("1.1.1.1")  # str, int, packed bytes or ipaddress object
```

Always a `Result`, never `None`; `ValueError` for anything that is not an address, and
an integer reads as v6 only above `0xFFFFFFFF`, so `lookup(1)` is `0.0.0.1`.

```python
>>> found.place.city.name, found.place.city.region.name, found.place.country.name
('Brisbane', 'Queensland', 'Australia')

>>> found.network.asn, found.network.operator.brand, found.network.cidr
(13335, 'Cloudflare', '1.1.1.0/24')

>>> exit_node = plevin.lookup("185.220.101.1")
>>> exit_node.abuse.service, exit_node.abuse.risk, exit_node.abuse.is_tor_exit_node
('tor_exit_node', 0.98, True)
```

The database is a separate wheel, found without being given a path. Install one, or
several and the richest wins.

|                                 |         |                                          |
| ------------------------------- | ------- | ---------------------------------------- |
| `pip install "plevin[db]"`      | 19.3 MB | every field                              |
| `pip install "plevin[place]"`   | 6.6 MB  | city, region, postal, coordinates, metro |
| `pip install "plevin[network]"` | 10.3 MB | ASN, operator, routing, abuse            |
| `pip install "plevin[country]"` | 423 KB  | the country code                         |

`PLEVIN_DB=/path/to/plevin.plv` or `plevin.use("plevin.plv")` reads a file of your own
instead; `plevin.Plevin(path)` opens one without touching the module's.

## Every field

<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-dark.png">
<img src="https://raw.githubusercontent.com/tn3w/plevin/master/.github/fields-light.png" width="840" alt="address to place, network and abuse">
</picture>

`found.place` is where the address is, `found.network` who announces it, `found.abuse`
what has been seen from it. Any of the three is `None` where the build carries none of
it, and every leaf is `None` rather than `""` or `0` where a source says nothing.

```python
Place(
    lat=-27.4675,
    lon=153.0281,
    accuracy=200,
    confidence=36,
    granularity='city',
    city=City(
        id=2174003,
        name='Brisbane',
        ascii='Brisbane',
        country='AU',
        population=2780063,
        elevation=27,
        postal='4000',
        postal_partial=None,
        timezone='Australia/Brisbane',
        type='regional capital',
        capital='region',
        region=Region(id=2152274, code='04', iso='AU-QLD', name='Queensland',
                      type='State'),
        district=District(id=7839562, code='31000', name='Brisbane'),
        metro=None,
    ),
    country=Country(
        code='AU',
        name='Australia',
        official=None,
        common=None,
        iso3='AUS',
        numeric='036',
        flag='🇦🇺',
        european_union=False,
        driving_side='left',
    ),
    time=Time(
        timezone='Australia/Brisbane',
        abbreviation='AEST',
        local='2026-08-13T19:20:00+10:00',
        utc_offset='+10:00',
        is_dst=False,
        dst_start=None,
        dst_end=None,
    ),
)
```

`country` and `time` are derived, not stored: `country` from the two-letter code
through [pycountry](https://pypi.org/project/pycountry), `time` from the zone name
through `zoneinfo`, both only with the `full` extra. Without it the code, the flag, the
EU and driving-side answers and the zone name still come through. `capital` says which
capital the city is, `region.iso` is ISO 3166-2 and `region.code` the GeoNames admin1
number, `postal_partial` is the leading part of `postal` a source could only narrow
that far.

```python
Network(
    asn=13335,
    handle='CLOUDFLARENET',
    prefix=24,
    cidr='1.1.1.0/24',
    start='1.1.1.0',
    end='1.1.1.255',
    rir='apnic',
    rpki='valid',
    roas=1,
    operator=Operator(
        company='Cloudflare, Inc.',
        brand='Cloudflare',
        domain='cloudflare.com',
        website='https://www.cloudflare.com',
        category='content',
        tier=2,
        peering=356,
        scope='Global',
        rir='arin',
        since=2010,
        street='101 Townsend St',
        state='CA',
        postal='94107-1934',
        country='US',
        abuse_email='abuse@cloudflare.com',
        city=City(name='San Francisco', ...),  # a full City, as above
    ),
    carrier=Carrier(user_type='hosting', user_count=19, mcc=None, mnc=None,
                    is_mobile=False),
)
```

`cidr` is the announcement the address falls in, masked out of the address itself, so
`1.1.1.1` and `1.0.0.1` reach one operator through two prefixes. `rir` is the registry
that holds the address, which is the registry of the address and not of the ASN, so a
block APNIC gave out can be announced by an operator ARIN registered. `rpki` is `valid`,
`invalid` or `unknown` and `roas` how many ROAs agree.

Where nothing is announced, the registries still answer. `asn`, `rpki` and `roas` fall
silent, `cidr` becomes the block a registry gave out rather than one a router carries,
and `handle` and `operator` name whoever holds it.

```python
>>> found = plevin.lookup("36.50.238.1")
>>> found.network.asn, found.network.cidr, found.network.rir
(None, '36.50.238.0/23', 'apnic')

>>> found.network.handle, found.network.operator.company
('GMTECH-BD', 'GM Tech')
```

RIPE, APNIC and AFRINIC publish the holder of every block they gave out; ARIN and
LACNIC publish none, so an unannounced address in either region answers `rir` and
`cidr` but no name. Roughly a seventh of routable IPv4 is announced by no one.
 `brand` drops the legal form and
the words every network carries, so `GOOGLE` and `Google LLC` both read `Google`;
`domain` is the host of `website`, else of `abuse_email`. `tier` is 1 transit-free, 2
has customers, 3 edge; `peering` the exchange count; `category` one of `residential`,
`business`, `hosting`, `education`, `government`, `military`, `cdn`, `content`,
`infrastructure`, `cellular`, `search_engine_spider`, `traveler`, `transit`, `exchange`
or `non-profit`.

```python
>>> plevin.lookup("185.220.101.1").abuse
Abuse(
    name='Tor',
    service='tor_exit_node',
    evidence='measured',
    risk=0.98,
    network_risk=0.82,
    last_seen_days=1,
    is_anycast=False,
    is_satellite=False,
    is_hosting_provider=True,
    is_proxy=False,
    is_public_proxy=False,
    is_residential_proxy=False,
    is_anonymous_vpn=False,
    is_tor_exit_node=True,
    is_private_relay=False,
    is_anonymous=True,
)
```

`risk` is 0 to 1 for the address, `network_risk` the same for the whole ASN, `None`
where nothing has ever been seen, so which is not a risk of zero. It is a total, not a
verdict any one source hands down: what the service the address runs is worth on its
own, and what every feed that named it scored it, combined so each agreeing source
raises the total and none of them replaces the rest. Feeds sharing an upstream count
once, and the scale stops at 0.99, since enough feeds agreeing still is not proof. A
Tor exit no feed has reported still reads high on the service alone; the same exit on
four blocklists reads higher. `evidence` is
`published`, `measured`, `reported` or `inferred`, strongest first; `service` is
`tor_exit_node`, `private_relay`, `anonymous_vpn`, `residential_proxy` or
`public_proxy`, most specific first. A public proxy on a residential or cellular line
reads as `residential_proxy` with `evidence='inferred'`. The ten booleans are read off
`service` and the carrier's type, never stored.

## What an address says on its own

Answered without the database, so they hold for every address:

```python
>>> found = plevin.lookup("2606:4700::1111")
>>> found.number, found.compressed
(50543257672059871404715951523469725969, '2606:4700::1111')

>>> found.expanded
'2606:4700:0000:0000:0000:0000:0000:1111'

>>> found.arpa
'1.1.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.7.4.6.0.6.2.ip6.arpa'
```

`is_global` and `is_bogon`, then `is_private`, `is_loopback`, `is_multicast`,
`is_reserved`, `is_link_local`, `is_unique_local`, `is_documentation`, `is_shared`
(100.64/10) and `is_benchmark` (198.18/15), bisected out of the IANA special-purpose
registries.

```python
>>> plevin.lookup("::ffff:8.8.8.8").tunnel, plevin.lookup("::ffff:8.8.8.8").embedded_ipv4
('ipv4-mapped', '8.8.8.8')

>>> plevin.lookup("2002:808:808::1").is_6to4
True
```

`tunnel` is `ipv4-mapped`, `6to4`, `teredo`, `nat64` or `None`, with `embedded_ipv4`
the address it carries; `is_ipv4_mapped`, `is_6to4` and `is_teredo` beside it.

```python
>>> plevin.lookup("2001:67c:e60:c0c:192:42:116:55").decimal_ipv4
'192.42.116.55'
```

`decimal_ipv4` is a guess and never a tunnel: the last four hextets where an operator
wrote a v4 address into them as decimal. It is `None` wherever a real tunnel answers.

```python
>>> found = plevin.lookup("8.8.8.8")
>>> found.as_ipv4_mapped, found.as_6to4, found.as_nat64
('::ffff:8.8.8.8', '2002:808:808::', '64:ff9b::808:808')
```

`as_ipv4_mapped`, `as_6to4` and `as_nat64` write a v4 address the other way about, as
the v6 addresses that carry it; all three are `None` for a v6 address, where
`embedded_ipv4` already says what it carries.

## What DNS says, where you ask for it

Off unless `dns=True` says otherwise, since it is the one part of a lookup that leaves
the machine:

```python
>>> plevin.lookup("8.8.8.8", dns=True).dns
Dns(
    asked='8.8.8.8',
    hostname='dns.google',
    hostnames=('dns.google',),
    ipv4='8.8.4.4',
    ipv6='2001:4860:4860::8888',
    ipv4_addresses=('8.8.4.4', '8.8.8.8'),
    ipv6_addresses=('2001:4860:4860::8888', '2001:4860:4860::8844'),
    alias=None,
    zone='8.8.8.in-addr.arpa',
    zone_primary='ns1.google.com',
    zone_contact='dns-admin@google.com',
    is_confirmed=True,
    is_signed=True,
)
```

`hostname` is the first PTR name and `hostnames` all of them, `ipv4` and `ipv6` that
name resolved forward with `ipv4_addresses` and `ipv6_addresses` all of those, so each
address names its other half; `is_confirmed` says the name leads back to the address,
which is forward-confirmed reverse DNS; `zone`, `zone_primary` and `zone_contact` come
from the reverse zone's SOA, naming who runs the range; `is_signed` is the DNSSEC
verdict and `alias` a CNAME in the way; `asked` is the address actually asked about,
which for a tunnel is the v4 it carries. Four questions go out in two rounds, PTR and
SOA on the reverse name together and then A and AAAA of the hostname, written onto the
wire and sent to every server at once, so the system's own from `/etc/resolv.conf` or the
Windows registry and 1.1.1.1, 8.8.8.8 and 9.9.9.9, so first real answer winning, TCP
where one comes back truncated, and kept for an hour, so a log with a thousand lines
from one address asks once.

## One ASN, and the networks a name belongs to

```python
>>> found = plevin.system("AS13335")        # 'AS13335', 'as13335' or 13335
>>> found.handle, found.network.operator.brand, found.abuse.network_risk
('CLOUDFLARENET', 'Cloudflare', 0.14)

>>> [(one.asn, one.handle) for one in plevin.search("hetzner")]
[(24940, 'HETZNER-AS'), (212317, 'HETZNER-CLOUD3-AS'), (213230, 'HETZNER-CLOUD2-AS'),
 (215859, 'HETZNER-CLOUD4-AS')]
```

`system()` answers a `System`, so the `asn`, the `handle`, the same `network` with its
operator and carrier, and the ASN's own `abuse` record, without anything only an address
fixes: no prefix, no CIDR, no RPKI, no place. Falsy where the file carries no such ASN.
It bisects the network table, so no spine is read and nothing about the address lookup
changes.

`search(text, limit=20)` matches the text against every handle and every company in the
file and answers the same `System`, widest network first: a match at the head of a word
beats one inside it, and then the network that touches most of the internet wins, which
is its exchanges and its users. `search("13335")` is the ASN itself. The index is one
lowercase text built on the first search, 0.26 s, and kept from then on.

## What an ASN announces

```python
>>> routes = plevin.routes("AS13335")       # written however system() takes it
>>> len(routes.ipv4), len(routes.ipv6)
(1506, 915)

>>> routes.ipv4[0]                          # the widest first
Span(cidr='152.114.0.0/17', start='152.114.0.0', end='152.114.127.255', version=4,
     prefix=17, addresses=32768)

>>> routes.ipv4_addresses, routes.ipv6_addresses >> 64
(616704, 75037868032)
```

`routes()` answers a `Routes`: every prefix the ASN is announced as, split into `ipv4`
and `ipv6` and widest first, each one a `Span` with its `cidr`, `start`, `end`,
`version`, `prefix` and `addresses`. `ipv4_addresses` and `ipv6_addresses` count the
space once where a more specific sits inside its own cover, the second one large enough
that `>> 64` reads it as /64 networks. Falsy where the file carries no such ASN.

It reads the spine's network column whole, a block at a time, rather than a row at a
time: 83 ms for the first ASN asked about and 40 ms for every one after it, each answer
kept. Nothing an address lookup reads is touched.

## Good for

- Country routing, pricing and compliance without a third-party call
- Local time and flag before the user types anything
- Bulk log enrichment, at 2M lookups/s on repeats
- Abuse handling and RPKI triage in the same process, no whois or RDAP
- Air-gapped deployments, where no address leaves the process

## Data

|                   |                                     |
| ----------------- | ----------------------------------- |
| v4 boundaries     | 2,629,342, plus 3,902,469 host rows |
| v6 boundaries     | 396,430                             |
| cities            | 76,805 in 3,177 regions             |
| districts, metros | 19,941 and 210                      |
| ASNs, operators   | 86,237 and 147,621, registry holders included |
| timezones         | 394                                 |
| abuse records     | 2,556 over 156 feeds                |

Rebuilt daily from MaxMind GeoLite2, IP2Location LITE, GeoNames, Natural Earth, a
RIPE RIS RIB, RPKI ROAs, the NRO delegations, the RIPE, APNIC and AFRINIC whois
dumps, CAIDA, PeeringDB,
[asn-abuse](https://github.com/tn3w/asn-abuse) and the feeds in
[`builder/data/feeds.json`](https://github.com/tn3w/plevin/blob/master/builder/README.md#sources). `Plevin(path).built` dates your
copy, `.selection` names which fields it carries and `.fields` lists them.

Python 3.10+. No dependencies on 3.14, where `compression.zstd` is in the standard
library; `pyzstd` below it. `pycountry` and, on Windows, `tzdata` come with the `full`
extra.

## Speed

|                     |                                          |
| ------------------- | ---------------------------------------- |
| open                | 2 ms, mmapped and read-only              |
| first answer        | 12 ms                                    |
| repeats             | 2,060,000/s                              |
| uniformly random v4 | 16,000/s, every one a fresh block decode |
| one ASN             | 46,000/s, a bisect of the network table  |
| one ASN's prefixes  | 83 ms for the first, 40 ms after, then kept |
| search              | 1.2 ms, after 0.26 s building the index  |

Blocks decode on reach and stay decoded, so a real log lands between the two: the
boundary a lookup found, the rows it linked to and the answer itself are all kept.

## Your own file

```python
from plevin import Plevin

with_places = Plevin("dist/plevin.metro-place.plv")
with_places.lookup("1.1.1.1").place.city.name
```

Read-only and memory-mapped, so processes and threads share one file. For the stored
rows without any of the shaping above, so dictionaries, codes already read as words, so
`Plevin(path).file.row(value, wide)` is the reader underneath.

## Builder

The Rust builder, its sources, the file format and the selection language are in
[`builder/README.md`](https://github.com/tn3w/plevin/blob/master/builder/README.md).

```bash
cd builder && cargo build --release
./target/release/plevin-builder              # dist/plevin.plv, every field
./target/release/plevin-builder place+metro  # dist/plevin.metro-place.plv
```

## Mini file

[`plevin_mini.py`](https://github.com/tn3w/plevin/blob/master/plevin_mini.py) is the lookup with no package around it.
Drop it beside a `.plv` and it runs.

```bash
python plevin_mini.py plevin.plv 8.8.8.8
```

```python
>>> from plevin_mini import Plevin
>>> Plevin("plevin.plv").lookup("8.8.8.8")["network"]["asn"]
15169
```

Plain dictionaries of the stored rows, codes already read as words, and nothing
derived: no models, no country, no clock, no discovery. 3,600,000 lookups a second
warm. It is linted and type-checked with the package.

## Development

```bash
cd python
uv run pytest          # 168 tests, 100% branch coverage
uv run mypy
uv run basedpyright
uvx ruff check . ../plevin_mini.py --config pyproject.toml
uv build --wheel

cd ../builder && cargo fmt --check && cargo clippy
```

## License

Apache 2.0 for the readers and the builder, see
[LICENSE](https://github.com/tn3w/plevin/blob/master/LICENSE). The database carries
the licenses of the sources it was built from, listed in
[`builder/README.md`](https://github.com/tn3w/plevin/blob/master/builder/README.md#sources).

<!-- brand: Noto Sans 800, wordmark bar #1868f2 place, #6f42c1 network, #2ea043 abuse; #7d8894 address, ink #0b1220 light, #f0f6fc dark -->
