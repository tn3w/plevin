/** What a build carries: fields asked for, the columns they need, rows narrowed. */

export type Kind = "number" | "signed" | "degrees" | "text" | "link";
export type Column = { id: string; kind: Kind; table: string; name: string };
export type Books = Record<string, string[]>;
type Narrow = Map<string, number[] | null>;
type Chosen = [field: string, needs: string[]][];

const KINDS: [string, Kind][] = [
  ["region.name", "text"],
  ["region.code", "text"],
  ["region.iso", "text"],
  ["region.type", "text"],
  ["region.id", "number"],
  ["region.country", "text"],
  ["district.name", "text"],
  ["district.code", "text"],
  ["district.id", "number"],
  ["metro.code", "number"],
  ["metro.label", "text"],
  ["city.name", "text"],
  ["city.ascii", "text"],
  ["city.id", "number"],
  ["city.population", "number"],
  ["city.type", "number"],
  ["city.postal", "text"],
  ["city.postal_partial", "number"],
  ["city.timezone", "number"],
  ["city.elevation", "signed"],
  ["city.country", "text"],
  ["city.metro", "link"],
  ["city.region", "link"],
  ["city.district", "link"],
  ["place.lat", "degrees"],
  ["place.lon", "degrees"],
  ["place.accuracy", "number"],
  ["place.granularity", "number"],
  ["place.confidence", "number"],
  ["place.city", "link"],
  ["operator.company", "text"],
  ["operator.website", "text"],
  ["operator.category", "number"],
  ["operator.tier", "number"],
  ["operator.peering", "number"],
  ["operator.scope", "text"],
  ["operator.rir", "text"],
  ["operator.since", "number"],
  ["operator.street", "text"],
  ["operator.state", "text"],
  ["operator.postal", "text"],
  ["operator.abuse_email", "text"],
  ["operator.country", "text"],
  ["operator.city", "link"],
  ["carrier.user_count", "number"],
  ["carrier.mcc", "number"],
  ["carrier.mnc", "number"],
  ["abuse.name", "text"],
  ["abuse.user_type", "number"],
  ["abuse.service", "number"],
  ["abuse.evidence", "number"],
  ["abuse.threat", "number"],
  ["abuse.is_anycast", "number"],
  ["abuse.is_satellite", "number"],
  ["abuse.risk", "number"],
  ["abuse.level", "number"],
  ["abuse.last_seen_days", "number"],
  ["network.asn", "number"],
  ["network.handle", "text"],
  ["network.brand", "text"],
  ["network.operator", "link"],
  ["network.carrier", "link"],
  ["network.abuse", "link"],
];

export const COLUMNS: Column[] = KINDS.map(([id, kind]) => {
  const [table, name] = id.split(".");
  return { id, kind, table, name };
});

export const section = ({ id, kind }: Column): string =>
  `${kind === "link" ? "link" : "col"}.${id}`;

export const TABLES = [
  "region",
  "district",
  "metro",
  "city",
  "place",
  "operator",
  "carrier",
  "abuse",
  "network",
];

export const ORDERED: Record<string, string[]> = {
  region: ["region.name"],
  district: ["district.name"],
  metro: ["metro.code"],
  city: ["city.country", "city.ascii", "city.name"],
  place: ["place.city", "place.lat", "place.lon"],
  operator: ["operator.country", "operator.company"],
  network: ["network.asn"],
};

export const CARRIED = [
  "place",
  "network",
  "abuse",
  "prefix",
  "rpki",
  "roas",
  "rir",
  "country",
  "since",
] as const;

export type Carried = (typeof CARRIED)[number];

const COUNTRY = ["place.city", "city.country"];
const SERVERS = ["hosting", "cdn", "content"];

const FIELDS: [string, string[]][] = [
  ["abuse.evidence", ["abuse.evidence"]],
  ["abuse.is_anonymous", ["abuse.service"]],
  ["abuse.is_anonymous_vpn", ["abuse.service"]],
  ["abuse.is_anycast", ["abuse.is_anycast"]],
  ["abuse.is_crawler", ["abuse.user_type"]],
  ["abuse.is_hosting_provider", ["abuse.user_type", "operator.category"]],
  ["abuse.is_malicious", ["abuse.level"]],
  ["abuse.is_private_relay", ["abuse.service"]],
  ["abuse.is_proxy", ["abuse.service"]],
  ["abuse.is_public_proxy", ["abuse.service"]],
  ["abuse.is_residential_proxy", ["abuse.service"]],
  ["abuse.is_satellite", ["network.abuse", "abuse.is_satellite"]],
  ["abuse.is_tor_exit_node", ["abuse.service"]],
  ["abuse.last_seen_days", ["abuse.last_seen_days"]],
  ["abuse.level", ["abuse.level"]],
  ["abuse.name", ["abuse.name"]],
  ["abuse.network_risk", ["network.abuse", "abuse.risk"]],
  ["abuse.provider", ["abuse.name", "abuse.service", "network.brand"]],
  ["abuse.risk", ["abuse.risk"]],
  ["abuse.service", ["abuse.service"]],
  ["abuse.threat", ["abuse.threat"]],
  ["metro.code", ["place.city", "city.metro", "metro.code"]],
  ["metro.label", ["place.city", "city.metro", "metro.label"]],
  ["network.asn", ["network.asn"]],
  ["network.carrier.is_mobile", ["abuse.user_type", "operator.category"]],
  ["network.carrier.mcc", ["network.carrier", "carrier.mcc"]],
  ["network.carrier.mnc", ["network.carrier", "carrier.mnc"]],
  ["network.carrier.user_count", ["network.carrier", "carrier.user_count"]],
  ["network.carrier.user_type", ["abuse.user_type", "operator.category"]],
  ["network.country", ["spine.country"]],
  ["network.handle", ["network.handle"]],
  ["network.operator.abuse_email", ["network.operator", "operator.abuse_email"]],
  ["network.operator.brand", ["network.brand"]],
  ["network.operator.category", ["network.operator", "operator.category"]],
  [
    "network.operator.city",
    ["network.operator", "operator.city", "city.name", "city.id"],
  ],
  ["network.operator.company", ["network.operator", "operator.company"]],
  ["network.operator.country", ["network.operator", "operator.country"]],
  [
    "network.operator.domain",
    ["network.operator", "operator.website", "operator.abuse_email"],
  ],
  ["network.operator.peering", ["network.operator", "operator.peering"]],
  ["network.operator.postal", ["network.operator", "operator.postal"]],
  ["network.operator.rir", ["network.operator", "operator.rir"]],
  ["network.operator.scope", ["network.operator", "operator.scope"]],
  ["network.operator.since", ["network.operator", "operator.since"]],
  ["network.operator.state", ["network.operator", "operator.state"]],
  ["network.operator.street", ["network.operator", "operator.street"]],
  ["network.operator.tier", ["network.operator", "operator.tier"]],
  ["network.operator.website", ["network.operator", "operator.website"]],
  ["network.prefix", ["spine.prefix"]],
  ["network.rir", ["spine.rir"]],
  ["network.roas", ["spine.roas"]],
  ["network.rpki", ["spine.rpki"]],
  ["network.since", ["spine.since"]],
  ["place.city.ascii", ["place.city", "city.ascii"]],
  ["place.city.elevation", ["place.city", "city.elevation"]],
  ["place.city.id", ["place.city", "city.id"]],
  ["place.city.name", ["place.city", "city.name"]],
  ["place.city.population", ["place.city", "city.population"]],
  ["place.city.postal", ["place.city", "city.postal"]],
  ["place.city.postal_partial", ["place.city", "city.postal", "city.postal_partial"]],
  ["place.city.timezone", ["place.city", "city.timezone"]],
  ["place.city.type", ["place.city", "city.type"]],
  ["place.country.code", COUNTRY],
  ["place.country.common", COUNTRY],
  ["place.country.driving_side", COUNTRY],
  ["place.country.european_union", COUNTRY],
  ["place.country.flag", COUNTRY],
  ["place.country.iso3", COUNTRY],
  ["place.country.name", COUNTRY],
  ["place.country.numeric", COUNTRY],
  ["place.country.official", COUNTRY],
  ["place.district.code", ["place.city", "city.district", "district.code"]],
  ["place.district.id", ["place.city", "city.district", "district.id"]],
  ["place.district.name", ["place.city", "city.district", "district.name"]],
  ["place.point.accuracy", ["place.accuracy"]],
  ["place.point.confidence", ["place.confidence"]],
  ["place.point.granularity", ["place.granularity"]],
  ["place.point.lat", ["place.lat"]],
  ["place.point.lon", ["place.lon"]],
  ["place.region.code", ["place.city", "city.region", "region.code"]],
  ["place.region.id", ["place.city", "city.region", "region.id"]],
  ["place.region.iso", ["place.city", "city.region", "region.iso"]],
  ["place.region.name", ["place.city", "city.region", "region.name"]],
  ["place.region.type", ["place.city", "city.region", "region.type"]],
];

const NARROW: [string, string, string[]][] = [
  ["abuse.is_tor_exit_node", "abuse.service", ["tor_exit_node"]],
  ["abuse.is_private_relay", "abuse.service", ["private_relay"]],
  ["abuse.is_anonymous_vpn", "abuse.service", ["anonymous_vpn"]],
  ["abuse.is_public_proxy", "abuse.service", ["public_proxy"]],
  ["abuse.is_residential_proxy", "abuse.service", ["residential_proxy"]],
  ["abuse.is_proxy", "abuse.service", ["public_proxy", "residential_proxy"]],
  ["abuse.is_crawler", "abuse.user_type", ["search_engine_spider"]],
  ["abuse.is_hosting_provider", "abuse.user_type", SERVERS],
  ["abuse.is_hosting_provider", "operator.category", SERVERS],
  ["network.carrier.is_mobile", "abuse.user_type", ["cellular"]],
  ["network.carrier.is_mobile", "operator.category", ["cellular"]],
];

const WORDS: Books = {
  categories: [
    "",
    "residential",
    "business",
    "hosting",
    "education",
    "government",
    "military",
    "cdn",
    "content",
    "infrastructure",
    "cellular",
    "search_engine_spider",
    "traveler",
    "transit",
    "exchange",
    "non-profit",
  ],
  services: [
    "",
    "public_proxy",
    "residential_proxy",
    "anonymous_vpn",
    "tor_exit_node",
    "private_relay",
  ],
};

const BOOKS: Record<string, string> = {
  "abuse.service": "services",
  "abuse.user_type": "categories",
  "operator.category": "categories",
};

export const FIELD_NAMES = FIELDS.map(([field]) => field);

export const FIELD_NEEDS: Record<string, string[]> = Object.fromEntries(FIELDS);

export const VOCABULARIES: [string, string[]][] = [
  ["categories", ["abuse.user_type", "operator.category"]],
  ["services", ["abuse.service"]],
  ["evidence", ["abuse.evidence"]],
  ["threats", ["abuse.threat"]],
  ["levels", ["abuse.level"]],
  ["granularity", ["place.granularity"]],
  ["rpki", ["spine.rpki"]],
  ["rirs", ["spine.rir"]],
  ["place_types", ["city.type"]],
  ["timezones", ["city.timezone"]],
  ["countries", ["spine.country"]],
];

export type Selection = {
  name: string;
  columns: Set<string>;
  narrow: Narrow;
  fields: string[];
  sparse: boolean;
  has: (id: string) => boolean;
  table: (table: string) => boolean;
};

const covers = (term: string, field: string): boolean =>
  field === term || field.startsWith(`${term}.`);

const valuesFor = (field: string, column: string, books: Books): number[] | null => {
  const held = NARROW.filter(([one, two]) => one === field && two === column);
  if (held.length === 0) return null;
  const book = books[BOOKS[column]] ?? WORDS[BOOKS[column]] ?? [];
  return held.flatMap(([, , values]) =>
    values.map((value) => Math.max(book.indexOf(value), 0)),
  );
};

const narrowing = (chosen: Chosen, books: Books): Narrow => {
  const narrow: Narrow = new Map();
  for (const [field, needs] of chosen) {
    for (const need of needs) {
      const more = valuesFor(field, need, books);
      if (!narrow.has(need)) {
        narrow.set(need, more);
        continue;
      }
      const kept = narrow.get(need);
      narrow.set(need, kept && more ? [...kept, ...more] : null);
    }
  }
  return narrow;
};

const isAnswered = (
  field: string,
  needs: string[],
  narrow: Narrow,
  books: Books,
): boolean =>
  needs.every((need) => {
    const kept = narrow.get(need);
    if (kept === undefined) return false;
    if (kept === null) return true;
    const mine = valuesFor(field, need, books);
    return mine?.every((one) => kept.includes(one)) ?? false;
  });

const select = (
  name: string,
  needed: Set<string>,
  chosen: Chosen,
  books: Books,
  available: Set<string>,
): Selection => {
  const columns = new Set(needed);
  if (
    [...columns].some((id) => id.startsWith("region.")) &&
    columns.has("city.country")
  ) {
    columns.add("region.country");
  }
  if (columns.has("abuse.risk") && available.has("abuse.level")) {
    columns.add("abuse.level");
  }
  const named = ["network.handle", "network.operator", "operator.company"];
  if (named.every((id) => columns.has(id))) columns.delete("network.brand");
  const narrow = narrowing(chosen, books);
  for (const id of columns) if (!narrow.has(id)) narrow.set(id, null);
  const picked = chosen.map(([field]) => field);
  const sparse =
    picked.includes("abuse.provider") && !picked.includes("network.operator.brand");
  const fields = FIELDS.filter(([field, needs]) =>
    isAnswered(field, needs, narrow, books),
  )
    .map(([field]) => field)
    .filter((field) => available.has(field))
    .filter((field) => !sparse || field !== "network.operator.brand");
  return {
    name,
    columns,
    narrow,
    fields,
    sparse,
    has: (id) => columns.has(id),
    table: (table) => COLUMNS.some((one) => one.table === table && columns.has(one.id)),
  };
};

const termsOf = (terms: string): string[] =>
  [...new Set(terms.split("+").filter(Boolean))].sort();

/** The file the builder names for these terms: `plevin.metro-place.plv`, or `plevin.plv`. */
export const fileName = (terms: string): string =>
  terms === "full"
    ? "plevin.plv"
    : `plevin.${termsOf(terms).join("+").replace(/[.+]/g, "-")}.plv`;

/** The terms as the builder reads them: `place+metro`, or `full` for all that exists. */
export const parse = (
  terms: string,
  available: Set<string> = new Set(FIELD_NAMES),
  books: Books = WORDS,
): Selection => {
  const parts = termsOf(terms);
  const full = terms === "full";
  const chosen = FIELDS.filter(([field]) => available.has(field)).filter(
    ([field]) => full || parts.some((term) => covers(term, field)),
  );
  const unknown = parts.filter(
    (term) => !full && !chosen.some(([field]) => covers(term, field)),
  );
  if (chosen.length === 0 || unknown.length > 0) {
    throw new Error(`the database holds no field for: ${unknown.join(", ") || terms}`);
  }
  const needed = new Set(chosen.flatMap(([, needs]) => needs));
  return select(full ? "full" : parts.join("+"), needed, chosen, books, available);
};
