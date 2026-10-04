export const FIELDS = [
  {
    "id": "abuse.evidence",
    "group": "abuse",
    "part": "Standing",
    "about": "How it is known: published, measured, reported or inferred.",
    "example": {
      "ip": "185.220.101.1",
      "value": "measured"
    }
  },
  {
    "id": "abuse.is_anonymous",
    "group": "abuse",
    "part": "Flags",
    "about": "Tor, VPN, proxy or relay.",
    "example": {
      "ip": "185.220.101.1",
      "value": true
    }
  },
  {
    "id": "abuse.is_anonymous_vpn",
    "group": "abuse",
    "part": "Flags",
    "about": "A commercial VPN exit.",
    "example": {
      "ip": "2.56.189.91",
      "value": true
    }
  },
  {
    "id": "abuse.is_anycast",
    "group": "abuse",
    "part": "Flags",
    "about": "Announced from many places at once.",
    "example": {
      "ip": "1.1.1.1",
      "value": true
    }
  },
  {
    "id": "abuse.is_crawler",
    "group": "abuse",
    "part": "Flags",
    "about": "A search engine crawler.",
    "example": {
      "ip": "66.249.66.1",
      "value": true
    }
  },
  {
    "id": "abuse.is_hosting_provider",
    "group": "abuse",
    "part": "Flags",
    "about": "Hosting, cloud or CDN space.",
    "example": {
      "ip": "1.1.1.1",
      "value": true
    }
  },
  {
    "id": "abuse.is_malicious",
    "group": "abuse",
    "part": "Flags",
    "about": "Listed at any risk level.",
    "example": {
      "ip": "185.220.101.1",
      "value": true
    }
  },
  {
    "id": "abuse.is_private_relay",
    "group": "abuse",
    "part": "Flags",
    "about": "An iCloud Private Relay egress.",
    "example": {
      "ip": "8.29.109.64",
      "value": true
    }
  },
  {
    "id": "abuse.is_proxy",
    "group": "abuse",
    "part": "Flags",
    "about": "A public or residential proxy.",
    "example": {
      "ip": "1.1.189.58",
      "value": true
    }
  },
  {
    "id": "abuse.is_public_proxy",
    "group": "abuse",
    "part": "Flags",
    "about": "An open public proxy.",
    "example": {
      "ip": "1.15.43.2",
      "value": true
    }
  },
  {
    "id": "abuse.is_residential_proxy",
    "group": "abuse",
    "part": "Flags",
    "about": "A proxy on a home connection.",
    "example": {
      "ip": "1.1.189.58",
      "value": true
    }
  },
  {
    "id": "abuse.is_satellite",
    "group": "abuse",
    "part": "Flags",
    "about": "A satellite network such as Starlink.",
    "example": {
      "ip": "14.1.78.165",
      "value": true
    }
  },
  {
    "id": "abuse.is_tor_exit_node",
    "group": "abuse",
    "part": "Flags",
    "about": "A Tor exit relay.",
    "example": {
      "ip": "185.220.101.1",
      "value": true
    }
  },
  {
    "id": "abuse.last_seen_days",
    "group": "abuse",
    "part": "Standing",
    "about": "Days since it was last reported.",
    "example": {
      "ip": "185.220.101.1",
      "value": 1
    }
  },
  {
    "id": "abuse.level",
    "group": "abuse",
    "part": "Standing",
    "about": "Risk bucket: low, medium or high.",
    "example": {
      "ip": "185.220.101.1",
      "value": "high"
    }
  },
  {
    "id": "abuse.network_risk",
    "group": "abuse",
    "part": "Standing",
    "about": "Risk of the whole network, 0 to 1.",
    "example": {
      "ip": "1.1.1.1",
      "value": 0.18
    }
  },
  {
    "id": "abuse.provider",
    "group": "abuse",
    "part": "Standing",
    "about": "The service or company behind it: Tor, NordVPN, Cloudflare.",
    "example": {
      "ip": "185.220.101.1",
      "value": "Tor"
    }
  },
  {
    "id": "abuse.risk",
    "group": "abuse",
    "part": "Standing",
    "about": "Risk of this address, 0 to 1.",
    "example": {
      "ip": "185.220.101.1",
      "value": 0.99
    }
  },
  {
    "id": "abuse.service",
    "group": "abuse",
    "part": "Standing",
    "about": "Anonymity service: tor_exit_node, anonymous_vpn, public_proxy and more.",
    "example": {
      "ip": "185.220.101.1",
      "value": "tor_exit_node"
    }
  },
  {
    "id": "abuse.threat",
    "group": "abuse",
    "part": "Standing",
    "about": "Kind of threat reported: botnet, scanner, spam and more.",
    "example": {
      "ip": "185.220.101.1",
      "value": "spam"
    }
  },
  {
    "id": "metro.code",
    "group": "place",
    "part": "Metro",
    "about": "US market code (DMA) of the place.",
    "example": {
      "ip": "8.8.8.8",
      "value": 807
    }
  },
  {
    "id": "metro.label",
    "group": "place",
    "part": "Metro",
    "about": "US market name.",
    "example": {
      "ip": "8.8.8.8",
      "value": "San Jose, CA"
    }
  },
  {
    "id": "network.asn",
    "group": "network",
    "part": "Network",
    "about": "Autonomous system number announcing the address.",
    "example": {
      "ip": "1.1.1.1",
      "value": 13335
    }
  },
  {
    "id": "network.carrier.is_mobile",
    "group": "network",
    "part": "Carrier",
    "about": "The network is a mobile carrier.",
    "example": {
      "ip": "1.34.218.65",
      "value": true
    }
  },
  {
    "id": "network.carrier.mcc",
    "group": "network",
    "part": "Carrier",
    "about": "Mobile country code.",
    "example": {
      "ip": "1.34.218.65",
      "value": 466
    }
  },
  {
    "id": "network.carrier.mnc",
    "group": "network",
    "part": "Carrier",
    "about": "Mobile network code.",
    "example": {
      "ip": "1.34.218.65",
      "value": 92
    }
  },
  {
    "id": "network.carrier.user_count",
    "group": "network",
    "part": "Carrier",
    "about": "Estimated users on the network.",
    "example": {
      "ip": "1.1.1.1",
      "value": 18
    }
  },
  {
    "id": "network.carrier.user_type",
    "group": "network",
    "part": "Carrier",
    "about": "What the range is used for: its own feed, else the operator's category.",
    "example": {
      "ip": "1.1.1.1",
      "value": "hosting"
    }
  },
  {
    "id": "network.cidr",
    "group": "network",
    "part": "Network",
    "about": "Announced block with its first and last address, from the prefix.",
    "needs": [
      "network.prefix"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "1.1.1.0/24"
    }
  },
  {
    "id": "network.country",
    "group": "network",
    "part": "Country",
    "about": "Country the block is registered in.",
    "example": {
      "ip": "1.1.1.1",
      "value": "AU"
    }
  },
  {
    "id": "network.handle",
    "group": "network",
    "part": "Network",
    "about": "Registry name of the network.",
    "example": {
      "ip": "1.1.1.1",
      "value": "CLOUDFLARENET"
    }
  },
  {
    "id": "network.operator.abuse_email",
    "group": "network",
    "part": "Operator",
    "about": "Mailbox to report abuse to.",
    "example": {
      "ip": "1.1.1.1",
      "value": "abuse@cloudflare.com"
    }
  },
  {
    "id": "network.operator.brand",
    "group": "network",
    "part": "Operator",
    "about": "The name it goes by.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Cloudflare"
    }
  },
  {
    "id": "network.operator.category",
    "group": "network",
    "part": "Operator",
    "about": "Kind of network: hosting, residential, business, cdn, education.",
    "example": {
      "ip": "1.1.1.1",
      "value": "cdn"
    }
  },
  {
    "id": "network.operator.city",
    "group": "network",
    "part": "Operator",
    "about": "City of the registered address, by GeoNames id and name.",
    "example": {
      "ip": "1.1.1.1",
      "value": {
        "id": 5391959,
        "name": "San Francisco",
        "ascii": null,
        "population": null,
        "elevation": null,
        "postal": null,
        "postal_partial": null,
        "timezone": null,
        "type": null,
        "capital": null,
        "region": null,
        "district": null,
        "metro": null
      }
    }
  },
  {
    "id": "network.operator.company",
    "group": "network",
    "part": "Operator",
    "about": "Legal name of the company behind the network.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Cloudflare, Inc."
    }
  },
  {
    "id": "network.operator.cone",
    "group": "network",
    "part": "Operator",
    "about": "Networks in its customer cone, itself included, from CAIDA AS Rank.",
    "example": {
      "ip": "1.1.1.1",
      "value": 1022
    }
  },
  {
    "id": "network.operator.country",
    "group": "network",
    "part": "Operator",
    "about": "Country of the registered address.",
    "example": {
      "ip": "1.1.1.1",
      "value": "US"
    }
  },
  {
    "id": "network.operator.domain",
    "group": "network",
    "part": "Operator",
    "about": "Its registered domain, from the website or the abuse mailbox.",
    "example": {
      "ip": "1.1.1.1",
      "value": "cloudflare.com"
    }
  },
  {
    "id": "network.operator.peering",
    "group": "network",
    "part": "Operator",
    "about": "How widely it peers, from PeeringDB.",
    "example": {
      "ip": "1.1.1.1",
      "value": 354
    }
  },
  {
    "id": "network.operator.postal",
    "group": "network",
    "part": "Operator",
    "about": "Postal code of the registered address.",
    "example": {
      "ip": "1.1.1.1",
      "value": "94107-1934"
    }
  },
  {
    "id": "network.operator.rir",
    "group": "network",
    "part": "Operator",
    "about": "Registry the company is registered with.",
    "example": {
      "ip": "1.1.1.1",
      "value": "arin"
    }
  },
  {
    "id": "network.operator.scope",
    "group": "network",
    "part": "Operator",
    "about": "Geographic reach it declares.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Global"
    }
  },
  {
    "id": "network.operator.since",
    "group": "network",
    "part": "Operator",
    "about": "Year the company first registered.",
    "example": {
      "ip": "1.1.1.1",
      "value": 2010
    }
  },
  {
    "id": "network.operator.state",
    "group": "network",
    "part": "Operator",
    "about": "State of the registered address.",
    "example": {
      "ip": "1.1.1.1",
      "value": "CA"
    }
  },
  {
    "id": "network.operator.street",
    "group": "network",
    "part": "Operator",
    "about": "Street of the registered address.",
    "example": {
      "ip": "1.1.1.1",
      "value": "101 Townsend St"
    }
  },
  {
    "id": "network.operator.tier",
    "group": "network",
    "part": "Operator",
    "about": "Place in the routing hierarchy, 1 at the top.",
    "example": {
      "ip": "1.1.1.1",
      "value": 2
    }
  },
  {
    "id": "network.operator.website",
    "group": "network",
    "part": "Operator",
    "about": "Its website; stored as host and path, read as https.",
    "example": {
      "ip": "1.1.1.1",
      "value": "https://cloudflare.com"
    }
  },
  {
    "id": "network.prefix",
    "group": "network",
    "part": "Network",
    "about": "Length of the announced prefix.",
    "example": {
      "ip": "1.1.1.1",
      "value": 24
    }
  },
  {
    "id": "network.rir",
    "group": "network",
    "part": "Network",
    "about": "Regional internet registry that holds the block.",
    "example": {
      "ip": "1.1.1.1",
      "value": "apnic"
    }
  },
  {
    "id": "network.roas",
    "group": "network",
    "part": "Network",
    "about": "Route origin authorisations covering the block.",
    "example": {
      "ip": "1.1.1.1",
      "value": 1
    }
  },
  {
    "id": "network.rpki",
    "group": "network",
    "part": "Network",
    "about": "Whether route origin validation says valid, invalid or unknown.",
    "example": {
      "ip": "1.1.1.1",
      "value": "valid"
    }
  },
  {
    "id": "network.since",
    "group": "network",
    "part": "Network",
    "about": "Year the block was first registered.",
    "example": {
      "ip": "1.1.1.1",
      "value": 2011
    }
  },
  {
    "id": "place.city.ascii",
    "group": "place",
    "part": "City",
    "about": "City name in plain ASCII, where it differs from the name.",
    "example": {
      "ip": "1.52.40.231",
      "value": "Nguyen Du"
    }
  },
  {
    "id": "place.city.capital",
    "group": "place",
    "part": "City",
    "about": "Whether the city is a capital, and of what.",
    "needs": [
      "place.city.type"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "region"
    }
  },
  {
    "id": "place.city.elevation",
    "group": "place",
    "part": "City",
    "about": "Metres above sea level.",
    "example": {
      "ip": "1.1.1.1",
      "value": 27
    }
  },
  {
    "id": "place.city.id",
    "group": "place",
    "part": "City",
    "about": "GeoNames id of the city.",
    "example": {
      "ip": "1.1.1.1",
      "value": 2174003
    }
  },
  {
    "id": "place.city.name",
    "group": "place",
    "part": "City",
    "about": "City name.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Brisbane"
    }
  },
  {
    "id": "place.city.population",
    "group": "place",
    "part": "City",
    "about": "People living in the city.",
    "example": {
      "ip": "1.1.1.1",
      "value": 2780063
    }
  },
  {
    "id": "place.city.postal",
    "group": "place",
    "part": "City",
    "about": "Postal code of the city.",
    "example": {
      "ip": "1.1.1.1",
      "value": "4000"
    }
  },
  {
    "id": "place.city.postal_partial",
    "group": "place",
    "part": "City",
    "about": "The part of the postal code the database is sure of.",
    "example": {
      "ip": "8.8.8.8",
      "value": "940"
    }
  },
  {
    "id": "place.city.timezone",
    "group": "place",
    "part": "City",
    "about": "IANA timezone name.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Australia/Brisbane"
    }
  },
  {
    "id": "place.city.type",
    "group": "place",
    "part": "City",
    "about": "What kind of place: regional capital, national capital and so on.",
    "example": {
      "ip": "1.1.1.1",
      "value": "regional capital"
    }
  },
  {
    "id": "place.country.calling_code",
    "group": "place",
    "part": "Country",
    "about": "International dialling prefix, from the country code.",
    "needs": [
      "place.country.code"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "+61"
    }
  },
  {
    "id": "place.country.code",
    "group": "place",
    "part": "Country",
    "about": "ISO 3166-1 alpha-2 code.",
    "example": {
      "ip": "1.1.1.1",
      "value": "AU"
    }
  },
  {
    "id": "place.country.common",
    "group": "place",
    "part": "Country",
    "about": "Everyday name, where it differs.",
    "example": {
      "ip": "1.34.218.65",
      "value": "Taiwan"
    }
  },
  {
    "id": "place.country.continent",
    "group": "place",
    "part": "Country",
    "about": "Continent code: AF, AN, AS, EU, NA, OC or SA.",
    "needs": [
      "place.country.code"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "OC"
    }
  },
  {
    "id": "place.country.continent",
    "group": "place",
    "part": "Country",
    "about": "Continent code: AF, AN, AS, EU, NA, OC or SA.",
    "needs": [
      "place.country.code"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "OC"
    }
  },
  {
    "id": "place.country.currency",
    "group": "place",
    "part": "Country",
    "about": "Currency code, from the country code.",
    "needs": [
      "place.country.code"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "AUD"
    }
  },
  {
    "id": "place.country.driving_side",
    "group": "place",
    "part": "Country",
    "about": "Side of the road traffic keeps to.",
    "example": {
      "ip": "1.1.1.1",
      "value": "left"
    }
  },
  {
    "id": "place.country.european_union",
    "group": "place",
    "part": "Country",
    "about": "Member of the European Union.",
    "example": {
      "ip": "185.220.101.1",
      "value": true
    }
  },
  {
    "id": "place.country.flag",
    "group": "place",
    "part": "Country",
    "about": "Flag emoji.",
    "example": {
      "ip": "1.1.1.1",
      "value": "🇦🇺"
    }
  },
  {
    "id": "place.country.iso3",
    "group": "place",
    "part": "Country",
    "about": "ISO 3166-1 alpha-3 code.",
    "example": {
      "ip": "1.1.1.1",
      "value": "AUS"
    }
  },
  {
    "id": "place.country.languages",
    "group": "place",
    "part": "Country",
    "about": "Languages spoken, from the country code.",
    "needs": [
      "place.country.code"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "en"
    }
  },
  {
    "id": "place.country.name",
    "group": "place",
    "part": "Country",
    "about": "Country name.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Australia"
    }
  },
  {
    "id": "place.country.numeric",
    "group": "place",
    "part": "Country",
    "about": "ISO 3166-1 numeric code.",
    "example": {
      "ip": "1.1.1.1",
      "value": "036"
    }
  },
  {
    "id": "place.country.official",
    "group": "place",
    "part": "Country",
    "about": "Official long name, where it differs.",
    "example": {
      "ip": "8.8.8.8",
      "value": "United States of America"
    }
  },
  {
    "id": "place.district.code",
    "group": "place",
    "part": "District",
    "about": "District code.",
    "example": {
      "ip": "1.1.1.1",
      "value": "31000"
    }
  },
  {
    "id": "place.district.id",
    "group": "place",
    "part": "District",
    "about": "GeoNames id of the district.",
    "example": {
      "ip": "1.1.1.1",
      "value": 7839562
    }
  },
  {
    "id": "place.district.name",
    "group": "place",
    "part": "District",
    "about": "District or county name.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Brisbane"
    }
  },
  {
    "id": "place.point.accuracy",
    "group": "place",
    "part": "Point",
    "about": "Radius of the area the address sits in, in kilometres.",
    "example": {
      "ip": "1.1.1.1",
      "value": 200
    }
  },
  {
    "id": "place.point.confidence",
    "group": "place",
    "part": "Point",
    "about": "How sure the database is of the place, 0 to 100.",
    "example": {
      "ip": "1.1.1.1",
      "value": 42
    }
  },
  {
    "id": "place.point.granularity",
    "group": "place",
    "part": "Point",
    "about": "Whether the place is known to the city, region or country.",
    "example": {
      "ip": "1.1.1.1",
      "value": "city"
    }
  },
  {
    "id": "place.point.lat",
    "group": "place",
    "part": "Point",
    "about": "Latitude of the place, in degrees.",
    "example": {
      "ip": "1.1.1.1",
      "value": -27.4675
    }
  },
  {
    "id": "place.point.lon",
    "group": "place",
    "part": "Point",
    "about": "Longitude of the place, in degrees.",
    "example": {
      "ip": "1.1.1.1",
      "value": 153.0281
    }
  },
  {
    "id": "place.region.code",
    "group": "place",
    "part": "Region",
    "about": "Region code within its country.",
    "example": {
      "ip": "1.1.1.1",
      "value": "04"
    }
  },
  {
    "id": "place.region.id",
    "group": "place",
    "part": "Region",
    "about": "GeoNames id of the state or region.",
    "example": {
      "ip": "1.1.1.1",
      "value": 2152274
    }
  },
  {
    "id": "place.region.iso",
    "group": "place",
    "part": "Region",
    "about": "ISO 3166-2 code, like AU-QLD.",
    "example": {
      "ip": "1.1.1.1",
      "value": "AU-QLD"
    }
  },
  {
    "id": "place.region.name",
    "group": "place",
    "part": "Region",
    "about": "State or region name.",
    "example": {
      "ip": "1.1.1.1",
      "value": "Queensland"
    }
  },
  {
    "id": "place.region.type",
    "group": "place",
    "part": "Region",
    "about": "State, province, county and so on.",
    "example": {
      "ip": "1.1.1.1",
      "value": "State"
    }
  },
  {
    "id": "place.time",
    "group": "place",
    "part": "Time",
    "about": "Local time, UTC offset, abbreviation and daylight saving, from the timezone.",
    "needs": [
      "place.city.timezone"
    ],
    "example": {
      "ip": "1.1.1.1",
      "value": "+10:00"
    }
  }
];

export const PRESETS = [
  {
    "id": "country",
    "title": "Country code",
    "about": "Two letters per address. The smallest file that still geolocates.",
    "terms": [
      "place.country.code"
    ],
    "ip": "8.8.8.8"
  },
  {
    "id": "flag",
    "title": "Country, flag and currency",
    "about": "Name, flag emoji, currency and calling code for a checkout or a signup form.",
    "terms": [
      "place.country.code",
      "place.country.name",
      "place.country.flag",
      "place.country.currency"
    ],
    "ip": "1.1.1.1"
  },
  {
    "id": "tor",
    "title": "Only Tor exit nodes",
    "about": "One flag, and only the rows it needs: about the size of an image.",
    "terms": [
      "abuse.is_tor_exit_node"
    ],
    "ip": "185.220.101.1"
  },
  {
    "id": "vpn",
    "title": "Only commercial VPNs",
    "about": "True for the exits of known VPN providers, nothing else kept.",
    "terms": [
      "abuse.is_anonymous_vpn"
    ],
    "ip": "2.56.189.91"
  },
  {
    "id": "proxy",
    "title": "Only proxies",
    "about": "Public and residential proxies, with the two flags that split them.",
    "terms": [
      "abuse.is_proxy"
    ],
    "ip": "1.1.189.58"
  },
  {
    "id": "anonymous",
    "title": "Anonymisers of any kind",
    "about": "Tor, VPN, proxy or relay, and which service it is.",
    "terms": [
      "abuse.is_anonymous",
      "abuse.service",
      "abuse.provider"
    ],
    "ip": "185.220.101.1"
  },
  {
    "id": "crawler",
    "title": "Search engine crawlers",
    "about": "Tell Googlebot and friends from everyone else.",
    "terms": [
      "abuse.is_crawler"
    ],
    "ip": "66.249.66.1"
  },
  {
    "id": "hosting",
    "title": "Hosting and cloud",
    "about": "Data centre, cloud and CDN space, the usual bot filter.",
    "terms": [
      "abuse.is_hosting_provider"
    ],
    "ip": "34.117.59.81"
  },
  {
    "id": "mobile",
    "title": "Mobile carriers",
    "about": "Is this a phone network, and which one.",
    "terms": [
      "network.carrier.is_mobile",
      "network.carrier.mcc",
      "network.carrier.mnc"
    ],
    "ip": "1.34.218.65"
  },
  {
    "id": "fraud",
    "title": "Fraud check",
    "about": "Risk, level, anonymiser flags and hosting, plus the country for a geo rule.",
    "terms": [
      "abuse.risk",
      "abuse.level",
      "abuse.is_anonymous",
      "abuse.is_hosting_provider",
      "place.country.code"
    ],
    "ip": "185.220.101.1"
  },
  {
    "id": "asn",
    "title": "ASN and operator",
    "about": "Who announces the address: number, handle, brand and domain.",
    "terms": [
      "network.asn",
      "network.handle",
      "network.operator.brand",
      "network.operator.domain"
    ],
    "ip": "1.1.1.1"
  },
  {
    "id": "routing",
    "title": "Routing and RPKI",
    "about": "The announced block, registry, registration year and RPKI state.",
    "terms": [
      "network.prefix",
      "network.rir",
      "network.country",
      "network.since",
      "network.rpki",
      "network.roas"
    ],
    "ip": "1.1.1.1"
  },
  {
    "id": "coordinates",
    "title": "Coordinates",
    "about": "Latitude, longitude and the radius they are good for.",
    "terms": [
      "place.point.lat",
      "place.point.lon",
      "place.point.accuracy"
    ],
    "ip": "1.1.1.1"
  },
  {
    "id": "city",
    "title": "City and region",
    "about": "City, region and country names for a display, without any coordinates.",
    "terms": [
      "place.city.name",
      "place.region.name",
      "place.country.code"
    ],
    "ip": "1.1.1.1"
  },
  {
    "id": "time",
    "title": "Local time",
    "about": "Timezone, local time and offset for any address.",
    "terms": [
      "place.city.timezone",
      "place.time"
    ],
    "ip": "1.1.1.1"
  },
  {
    "id": "full",
    "title": "Everything",
    "about": "Every field: the file you started from.",
    "terms": [
      "full"
    ],
    "ip": "1.1.1.1"
  }
];
