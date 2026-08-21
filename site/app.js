import { country as homeland } from "./plevin/extra.js";
import { ask, Plevin, records } from "./plevin/index.js";
import { SAMPLE } from "./sample.js";

const API = "https://plevin.tn3w.dev/api";
const SAMPLED = "1.1.1.1";

const DATABASE = "db/plevin.plv";
const OWN_ADDRESS = "https://api.ipify.org?format=json";
const STORE = "plevin";

const node = (id) => document.getElementById(id);

const make = (tag, className, text) => {
  const held = document.createElement(tag);
  if (className) held.className = className;
  if (text !== undefined) held.textContent = text;
  return held;
};

const drawn = (markup) => {
  const holder = make("div");
  holder.innerHTML = markup;
  return holder.firstElementChild;
};

const say = (message) => {
  node("state").textContent = message;
};

const bar = (fraction) => {
  node("progress").style.width = `${Math.round(fraction * 100)}%`;
};

const failed = (message) => {
  node("loading").classList.add("done");
  node("result").hidden = true;
  const note = node("failed");
  note.hidden = false;
  note.textContent = message;
};

const download = async () => {
  const cache = "caches" in window ? await caches.open(STORE) : null;
  const cached = cache && (await cache.match(DATABASE));
  if (cached) {
    say("reading the database out of the browser cache");
    bar(1);
    return new Uint8Array(await cached.arrayBuffer());
  }

  const response = await fetch(DATABASE);
  if (!response.ok) throw new Error(`${response.status} reading the database`);
  if (cache) await cache.put(DATABASE, response.clone());

  const total = Number(response.headers.get("content-length") ?? 0);
  const parts = [];
  let done = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done: over, value } = await reader.read();
    if (over) break;
    parts.push(value);
    done += value.length;
    if (total) bar(done / total);
    say(`downloading the database, ${(done / 1e6).toFixed(1)} MB`);
  }

  const bytes = new Uint8Array(done);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};

let opening = null;

const database = () => {
  if (!opening) {
    opening = (async () => {
      say("downloading the database");
      const db = new Plevin(await download());
      say("reading the address");
      node("built").textContent = `database built ${db.built}`;
      return db;
    })();
  }
  return opening;
};

const COPY_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true">
    <rect class="back" x="5.2" y="1.2" width="9.6" height="9.6" rx="2.2"/>
    <rect class="front" x="1.2" y="5.2" width="9.6" height="9.6" rx="2.2"/>
    <path class="tick" d="M3.6 8.3 L6.4 11 L12.2 4.8"/>
  </svg>`;

const copied = async (button, text) => {
  await navigator.clipboard.writeText(text);
  button.classList.add("done");
  setTimeout(() => button.classList.remove("done"), 1200);
};

const copier = (text, label) => {
  const button = make("button", "copy-chip");
  button.type = "button";
  button.title = `Copy ${label}`;
  button.setAttribute("aria-label", `Copy ${label}`);
  button.append(drawn(COPY_ICON));
  button.addEventListener("click", () => copied(button, text));
  return button;
};

const field = (label, value, mono, copy) => {
  const held = make("div", "field");
  const line = make("div", "line");
  line.append(make("b", mono ? "mono" : "", String(value)));
  if (copy) line.append(copier(String(value), copy));
  held.append(make("span", "", label), line);
  return held;
};

const fields = (pairs) => {
  const grid = make("div", "fields");
  for (const [label, value, mono, copy] of pairs) {
    if (value === null || value === undefined || value === "") continue;
    grid.append(field(label, value, mono, copy));
  }
  return grid;
};

const hint = (text) => {
  const held = make("button", "tip");
  held.type = "button";
  held.textContent = "?";
  held.setAttribute("aria-label", text);
  held.append(make("span", "bubble", text));
  return held;
};

const panel = (kind, title, note) => {
  const section = make("section", `panel ${kind}`);
  const head = make("header");
  head.append(make("span", "dot"), make("b", "", title));
  if (note) head.append(make("em", "", note));
  const body = make("div", "body");
  section.append(head, body);
  return [section, body];
};

const TILES = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
};

const TILE_OPTIONS = {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">' +
    'OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 20,
  subdomains: "abcd",
};

const THEME = window.matchMedia("(prefers-color-scheme: dark)");
const maps = new Set();

const tileUrl = () => TILES[THEME.matches ? "dark" : "light"];

const tileLayer = () => window.L.tileLayer(tileUrl(), TILE_OPTIONS);

const tuneMap = (map) => {
  map.scrollWheelZoom.disable();
  map.touchZoom.enable();
  map.doubleClickZoom.enable();
};

const switchTiles = (held) => {
  if (!held.root.isConnected) {
    held.map.remove();
    maps.delete(held);
    return;
  }

  const next = tileLayer().addTo(held.map);
  held.layer.remove();
  held.layer = next;
};

THEME.addEventListener("change", () => {
  for (const held of maps) switchTiles(held);
});

const openMap = (root, place) => {
  if (!root.isConnected || !window.L) return;

  const center = [place.lat, place.lon];
  const map = window.L.map(root, { zoomControl: false }).setView(
    center,
    4,
  );
  const layer = tileLayer().addTo(map);
  const radius = (place.accuracy ?? 12) * 1000;

  tuneMap(map);
  window.L.control.zoom({ position: "bottomright" }).addTo(map);
  window.L.circle(center, {
    color: "var(--place)",
    fillColor: "var(--place)",
    fillOpacity: 0.14,
    radius,
    weight: 2,
  }).addTo(map);
  window.L.marker(center).addTo(map);
  maps.add({ layer, map, root });

  requestAnimationFrame(() => map.flyTo(
    [place.lat, place.lon],
    11,
    { duration: 1.2 },
  ));
};

const locationMap = (place) => {
  const holder = make("div", "graphic map");
  const root = make("div", "leaflet-map");
  root.setAttribute("aria-label", `${place.lat}, ${place.lon} on a city map`);
  holder.append(root);

  const caption = make("div", "map-caption");
  const spot = `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
  const around = [place.confidence === null ? null : `${place.confidence}% sure`,
    place.accuracy === null ? null : `${place.accuracy} km radius`]
    .filter(Boolean).join(", ");
  caption.append(make("span", "", spot), make("span", "", around));
  holder.append(caption);

  requestAnimationFrame(() => openMap(root, place));
  return holder;
};

const spanBar = (found) => {
  const network = found.network;
  const bits = BigInt((found.version === 6 ? 128 : 32) - network.prefix);
  const total = 1n << bits;
  const offset = BigInt(found.number) % total;
  const at = total === 1n ? 50 : Number((offset * 1000n) / (total - 1n)) / 10;

  const holder = make("div", "graphic");
  const track = make("div", "span-bar");
  const pin = make("i");
  pin.style.left = `${at.toFixed(2)}%`;
  track.append(pin);

  const caption = make("div", "caption");
  caption.append(make("span", "", network.start), make("span", "", network.cidr),
    make("span", "", network.end));
  holder.append(track, caption);
  return holder;
};

const tone = (value) =>
  value >= 0.66 ? "var(--bad)" : value >= 0.33 ? "var(--warn)" : "var(--abuse)";

const gauge = (label, value, tip) => {
  const held = make("div", "gauge");
  const percent = Math.round(value * 100);
  held.append(drawn(`<svg viewBox="0 0 100 60" role="img" aria-label="${label} ${percent}%">
      <path class="rail" d="M8 52 A42 42 0 0 1 92 52" fill="none" stroke-width="8"
        pathLength="100" stroke-linecap="round"/>
      <path class="arc" d="M8 52 A42 42 0 0 1 92 52" fill="none" stroke-width="8"
        pathLength="100" stroke-dasharray="${percent} 100"/>
      <text class="value" x="50" y="50" text-anchor="middle">${percent}%</text>
    </svg>`));
  held.style.setProperty("--tone", tone(value));
  const caption = make("p", "", label);
  caption.append(hint(tip));
  held.append(caption);
  return held;
};

const flags = (names) => {
  const held = make("div", "flags");
  for (const name of names) held.append(make("span", "", name));
  return held;
};

const groups = (found) => {
  const held = make("div", "bits");
  const parts = found.version === 4
    ? found.compressed.split(".").map((part) =>
        [part, Number(part).toString(2).padStart(8, "0")])
    : found.expanded.split(":").map((part) =>
        [part, String(parseInt(part, 16))]);

  for (const [value, under] of parts) {
    const group = make("div", "group");
    group.append(make("b", "", value), make("span", "", under));
    held.append(group);
  }
  return held;
};

const named = (place) => {
  const city = place?.city ?? {};
  return [city.name, city.region?.name, place?.country?.name].filter(Boolean).join(", ");
};

const percent = (value) => (value === null ? null : `${Math.round(value * 100)}%`);

const SPECIAL = ["private", "loopback", "multicast", "reserved", "link_local",
  "unique_local", "documentation", "shared", "benchmark"];

const marks = (found, hostname) => {
  const held = [];
  if (found.abuse?.is_anonymous) held.push([found.abuse.service, "warn"]);
  if (found.network?.rpki === "valid") held.push(["rpki valid", "good"]);
  if (found.network?.rpki === "invalid") held.push(["rpki invalid", "warn"]);
  if (found.abuse?.is_hosting_provider) held.push(["hosting", "info"]);
  if (found.network?.carrier?.is_mobile) held.push(["mobile", "info"]);
  if (found.network?.carrier?.user_type) held.push([found.network.carrier.user_type, ""]);
  for (const name of SPECIAL)
    if (found[`is_${name}`]) held.push([name.replace("_", " "), "warn"]);
  if (found.tunnel) held.push([found.tunnel, "info"]);
  if (found.is_global) held.push(["global unicast", ""]);
  if (hostname) held.push([hostname, ""]);

  const into = node("marks");
  into.replaceChildren();
  const seen = new Set();
  for (const [label, kind] of held) {
    if (seen.has(label)) continue;
    seen.add(label);
    into.append(make("span", kind, label));
  }
};

const listed = (parts) => parts.filter(Boolean).join(", ") || null;

const country = (held) => {
  if (!held) return null;
  const codes = listed([held.code, held.iso3]);
  return `${held.official ?? held.name}${codes ? ` (${codes})` : ""}`;
};

const based = (code) => {
  const held = code ? homeland(code) : null;
  return held?.name ? `${held.flag} ${held.name}` : code;
};

const region = (city) =>
  city.region ? `${city.region.name}${city.region.iso ? ` (${city.region.iso})` : ""}` : null;

const clock = (time) =>
  time?.local
    ? `${time.local.replace("T", " ").slice(0, 16)} ${time.abbreviation} ${time.utc_offset}`
    : null;

const placePanel = (place) => {
  const [section, body] = panel("place", "Place", place.granularity ?? "");
  if (place.lat !== null && place.lon !== null) body.append(locationMap(place));

  const city = place.city ?? {};
  body.append(fields([
    ["Where", named(place)],
    ["Country", country(place.country)],
    ["Region", region(city)],
    ["District, metro", listed([city.district?.name, city.metro?.label])],
    ["Postal", city.postal ?? city.postal_partial, true],
    ["Local time", clock(place.time), true],
    ["Timezone", place.time?.timezone ?? city.timezone],
    ["City", listed([city.type,
      city.population ? `${city.population.toLocaleString("en-US")} people` : null,
      city.elevation == null ? null : `${city.elevation} m`])],
    ["Country facts", listed([place.country?.european_union ? "EU member" : null,
      place.country?.driving_side ? `drives ${place.country.driving_side}` : null])],
  ]));
  return section;
};

const networkPanel = (found) => {
  const network = found.network;
  const operator = network.operator ?? {};
  const [section, body] = panel("network", "Network",
    network.asn === null ? "" : `AS${network.asn}`);
  if (network.asn !== null)
    section.querySelector("header").append(copier(`AS${network.asn}`, "the ASN"));
  if (network.start && network.end) body.append(spanBar(found));

  body.append(fields([
    ["Operator", operator.brand ?? operator.company],
    ["Company", operator.company],
    ["Handle", network.handle, true],
    [network.asn === null ? "Allocation" : "Announcement", network.cidr, true],
    ["RPKI", network.rpki ? `${network.rpki}, ${network.roas} ROA` : null],
    ["Category", operator.category],
    ["Registry", (network.rir ?? operator.rir)?.toUpperCase()],
    ["Tier", operator.tier === null ? null : `tier ${operator.tier}`],
    ["Peering", operator.peering === null ? null : `${operator.peering} exchanges`],
    ["Since", operator.since],
    ["Scope", operator.scope],
    ["Website", operator.website, true],
    ["Abuse mailbox", operator.abuse_email, true, "the abuse mailbox"],
    ["User type", network.carrier?.user_type],
    ["Users", network.carrier?.user_count?.toLocaleString("en-US")],
    ["Mobile codes", network.carrier?.mcc
      ? `MCC ${network.carrier.mcc}, MNC ${network.carrier.mnc}` : null],
    ["Registered", [operator.street, operator.city?.name, operator.state,
      operator.postal, based(operator.country)].filter(Boolean).join(", ")],
  ]));
  return section;
};

const SPANS = 48;
const WIDE = 1n << 64n;

const plural = (count, one, many) =>
  `${count.toLocaleString("en-US")} ${Number(count) === 1 ? one : many}`;

/** A v6 prefix counts in /64 networks, which is the unit routing is talked in. */
const sized = (count) => {
  const held = BigInt(count);
  return held < WIDE
    ? plural(held, "address", "addresses")
    : plural(held >> 64n, "/64 network", "/64 networks");
};

const rangeChip = (one) => {
  const button = make("button", "range");
  button.type = "button";
  button.append(make("b", "", one.cidr), make("span", "", sized(one.addresses)));
  button.addEventListener("click", () => seek(one.start));
  return button;
};

const rangeBlock = (held, label) => {
  const holder = make("div", "range-block");
  const list = make("div", "ranges");
  list.append(...held.slice(0, SPANS).map(rangeChip));
  holder.append(make("span", "range-label", label), list);
  if (held.length <= SPANS) return holder;

  const more = make("button", "ghost",
    `show all ${held.length.toLocaleString("en-US")}`);
  more.type = "button";
  more.addEventListener("click", () => {
    list.append(...held.slice(SPANS).map(rangeChip));
    more.remove();
  });
  holder.append(more);
  return holder;
};

const routingPanel = (db, asn) => {
  const { ipv4, ipv6, ipv4_addresses, ipv6_addresses } = db.routes(asn);
  if (!ipv4.length && !ipv6.length) return null;

  const [section, body] = panel("routing", "Routes",
    plural(ipv4.length + ipv6.length, "prefix", "prefixes"));
  body.append(fields([
    ["IPv4 prefixes", ipv4.length ? ipv4.length.toLocaleString("en-US") : null],
    ["IPv4 space", ipv4.length ? sized(ipv4_addresses) : null],
    ["IPv6 prefixes", ipv6.length ? ipv6.length.toLocaleString("en-US") : null],
    ["IPv6 space", ipv6.length ? sized(ipv6_addresses) : null],
  ]));
  if (ipv4.length) body.append(rangeBlock(ipv4, "IPv4"));
  if (ipv6.length) body.append(rangeBlock(ipv6, "IPv6"));
  return section;
};

/** The flags alone already ride in the header, so a record of only flags says nothing. */
const told = (abuse) =>
  Boolean(abuse) && [abuse.provider, abuse.service, abuse.evidence, abuse.risk,
    abuse.network_risk, abuse.last_seen_days].some((value) => value !== null);

const ADDRESS_TIP = "How often this single address itself was reported by the abuse " +
  "feeds, and never under what the anonymity service it runs is worth on its own. " +
  "0% is never seen, 100% is seen in every recent feed.";

const NETWORK_TIP = "How much of the whole ASN this address sits in was reported. A " +
  "high address risk with a low network risk means one bad address on an otherwise " +
  "quiet network.";

const abusePanel = (abuse, address = true) => {
  const risk = abuse.risk ?? 0;
  const [section, body] = panel("abuse", "Abuse", abuse.evidence ?? "");
  section.style.setProperty("--kind", tone(Math.max(risk, abuse.network_risk ?? 0)));

  const gauges = make("div", "gauges");
  if (address) gauges.append(gauge("address risk", risk, ADDRESS_TIP));
  gauges.append(gauge("network risk", abuse.network_risk ?? 0, NETWORK_TIP));
  body.append(gauges);

  const held = make("div", "stack");
  const seen = Object.entries(abuse)
    .filter(([name, value]) => name.startsWith("is_") && value)
    .map(([name]) => name.slice(3).replace(/_/g, " "));
  if (seen.length) held.append(flags(seen));
  body.append(held);

  held.append(fields([
    ["Seen as", abuse.provider ?? abuse.service],
    ["Service", abuse.service],
    ["Evidence", abuse.evidence],
    ["Last seen", abuse.last_seen_days === null
      ? null
      : `${abuse.last_seen_days} day${abuse.last_seen_days === 1 ? "" : "s"} ago`],
  ]));
  return section;
};

const SHOWN = 4;

/** The address asked about first, since it is the one a reader came to check. */
const leading = (values, held) =>
  values.includes(held) ? [held, ...values.filter((one) => one !== held)] : values;

const some = (values) => {
  if (!values.length) return null;
  const rest = values.length - SHOWN;
  return rest > 0
    ? `${values.slice(0, SHOWN).join(", ")} (+${rest} more)`
    : values.join(", ");
};

const dnsPanel = (dns) => {
  const [section, body] = panel("dns", "DNS", dns.is_confirmed ? "confirmed" : "");
  body.append(fields([
    ["Hostname", dns.hostname, true],
    ["Also", some(dns.hostnames.slice(1)), true],
    ["Alias", dns.alias, true],
    ["IPv4", some(leading(dns.ipv4_addresses, dns.asked)), true],
    ["IPv6", some(leading(dns.ipv6_addresses, dns.asked)), true],
    ["Forward confirmed", dns.hostname ? (dns.is_confirmed ? "yes" : "no") : null],
    ["DNSSEC", dns.is_signed ? "validated" : "unsigned"],
    ["Zone", dns.zone, true],
    ["Zone server", dns.zone_primary, true],
    ["Zone contact", dns.zone_contact, true],
  ]));
  return section;
};

const addressPanel = (found) => {
  const [section, body] = panel("address", "Address", `IPv${found.version}`);
  body.append(groups(found));
  body.append(fields([
    ["Compressed", found.compressed, true],
    ["Expanded", found.expanded, true],
    ["Number", found.number.toString(), true],
    ["Scope", found.is_global ? "global unicast" : "not the public internet"],
    ["Tunnel", found.tunnel],
    ["Carries", found.embedded_ipv4, true],
    ["Reads as", found.decimal_ipv4, true],
    ["As mapped", found.as_ipv4_mapped, true],
    ["As 6to4", found.as_6to4, true],
    ["As NAT64", found.as_nat64, true],
    ["Reverse", found.arpa, true],
  ]));
  return section;
};

const escaped = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PIECE =
  /"(?:\\.|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;

const kindOf = (piece) => {
  if (piece.endsWith(":")) return "key";
  if (piece.startsWith("\"")) return "str";
  if (piece === "null") return "null";
  return piece === "true" || piece === "false" ? "bool" : "num";
};

const painted = (json) =>
  escaped(json).replace(PIECE, (piece) =>
    `<span class="${kindOf(piece)}">${piece}</span>`);

const written = (found) =>
  JSON.stringify(found, (_, value) =>
    typeof value === "bigint" ? value.toString() : value, 2);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

const resolved = async (name) => {
  for (const kind of ["A", "AAAA"]) {
    const found = records(await ask([name, kind, null]), kind);
    if (found.length) return found[0].data;
  }
  return "";
};

/** An address as typed, the one a hostname resolves to, or nothing to look up. */
const answered = async (db, asked) => {
  try {
    return [db.lookup(asked), ""];
  } catch {
    if (!HOSTNAME.test(asked)) return [null, ""];
    say(`resolving ${asked}`);
    const address = await resolved(asked);
    if (!address) return [null, ""];
    return [db.lookup(address), asked];
  }
};

const shown = () => {
  node("failed").hidden = true;
  node("loading").classList.add("done");
  node("result").hidden = false;
};

const kept = (found) => {
  const raw = written(found);
  node("json").innerHTML = painted(raw);
  node("copy").dataset.json = raw;
};

const render = (found) => {
  shown();

  node("ip").textContent = found.ip;
  node("ip-line").replaceChildren(node("ip"), copier(found.ip, "the address"));
  node("flag").textContent = found.place?.country?.flag ?? "";
  node("where").textContent = found.found
    ? named(found.place) || found.network?.operator?.brand || "no place stored here"
    : "the database carries nothing for this address";
  marks(found, "");
  kept(found);

  const cards = node("cards");
  cards.replaceChildren();
  if (found.place) cards.append(placePanel(found.place));
  if (found.network) cards.append(networkPanel(found));
  if (told(found.abuse)) cards.append(abusePanel(found.abuse));
  if (found.dns) cards.append(dnsPanel(found.dns));
  cards.append(addressPanel(found));
};

const renderSystem = (db, found, query) => {
  shown();

  const name = `AS${found.asn}`;
  node("ip").textContent = found.found ? name : query;
  node("ip-line").replaceChildren(node("ip"));
  if (found.found) node("ip-line").append(copier(name, "the ASN"));
  const operator = found.network?.operator;
  node("flag").textContent = operator?.country
    ? homeland(operator.country).flag ?? ""
    : "";
  node("where").textContent = found.found
    ? listed([operator?.brand ?? operator?.company, found.handle])
    : "the database carries nothing for this ASN";
  marks(found, "");
  kept(found);

  const cards = node("cards");
  cards.replaceChildren();
  if (found.network) cards.append(networkPanel(found));
  const routes = found.found ? routingPanel(db, found.asn) : null;
  if (routes) cards.append(routes);
  if (told(found.abuse)) cards.append(abusePanel(found.abuse, false));
};

let asked = "";

const HOME_TITLE = "plevin - IP lookup in your browser, no API";

const described = (text) =>
  document.querySelector("meta[name=description]").setAttribute("content", text);

const HOME_DESCRIPTION =
  document.querySelector("meta[name=description]").getAttribute("content");

const ASN = /^as\d+$/i;

const show = async (address) => {
  asked = address;
  document.title = `${address} - lookup - plevin`;
  described(`Location, network operator, ASN and abuse risk for ${address}.`);
  document.body.classList.add("answering");
  node("answer").hidden = false;
  node("failed").hidden = true;
  node("result").hidden = true;
  node("loading").classList.remove("done");
  say(opening ? "reading the address" : "opening the database");
  for (const input of document.querySelectorAll("[data-address]")) input.value = address;

  let db;
  try {
    db = await database();
  } catch (error) {
    opening = null;
    return failed(error.message);
  }
  if (asked !== address) return;

  if (ASN.test(address)) return renderSystem(db, db.system(address), address);

  const [found, name] = await answered(db, address);
  if (asked !== address) return;
  if (found === null) {
    const [best] = db.search(address, 1);
    if (!best) return failed(`${address} reads as no address, ASN or network name`);
    return seek(`AS${best.asn}`);
  }

  render(found);
  say("asking dns");
  const withNames = await db.resolve(found.ip, { dns: true });
  if (asked !== address) return;

  render(withNames);
  const held = name || withNames.dns?.hostname || "";
  if (held) marks(withNames, held);
};

const home = () => {
  asked = "";
  document.title = HOME_TITLE;
  described(HOME_DESCRIPTION);
  document.body.classList.remove("answering");
  node("answer").hidden = true;
};

const route = () => {
  const hash = decodeURIComponent(location.hash.slice(1));
  const anchor = hash && document.getElementById(hash);
  if (!hash || (anchor && node("home").contains(anchor))) return home();
  show(hash);
};

const seek = (address) => {
  const held = address.trim();
  if (!held) return;
  const next = `#${encodeURIComponent(held)}`;
  if (location.hash === next) return show(held);
  location.hash = next;
};

const SUGGESTED = 5;
const TYPING = 150;

/** What the box under the bar offers: never an address, which answers on its own. */
const looked = (db, query) => {
  if (ASN.test(query)) return [];
  try {
    db.lookup(query);
    return [];
  } catch {
    return db.search(query, SUGGESTED);
  }
};

const suggestion = (one) => {
  const operator = one.network?.operator ?? {};
  const button = make("button");
  button.type = "button";
  button.append(make("b", "", `AS${one.asn}`), make("span", "", one.handle ?? ""),
    make("em", "", listed([operator.brand ?? operator.company, operator.country])));
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    seek(`AS${one.asn}`);
  });
  return button;
};

const suggesting = async (input, box) => {
  const query = input.value.trim();
  if (query.length < 2) return;
  const db = await database();
  if (input.value.trim() !== query) return;
  const found = looked(db, query);
  box.replaceChildren(...found.map(suggestion));
  box.hidden = !found.length;
};

for (const form of document.querySelectorAll("[data-ask]")) {
  const input = form.querySelector("[data-address]");
  const box = make("div", "hints");
  box.hidden = true;
  form.append(box);

  let typed = 0;
  input.addEventListener("input", () => {
    box.hidden = true;
    clearTimeout(typed);
    typed = setTimeout(() => suggesting(input, box), TYPING);
  });
  input.addEventListener("blur", () => setTimeout(() => { box.hidden = true; }, TYPING));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    box.hidden = true;
    seek(input.value);
  });
}

for (const sample of document.querySelectorAll("[data-ip]")) {
  sample.addEventListener("click", () => seek(sample.dataset.ip));
}

for (const button of document.querySelectorAll("[data-mine]")) {
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    const held = button.textContent;
    button.textContent = "asking...";
    try {
      const { ip } = await (await fetch(OWN_ADDRESS)).json();
      seek(ip);
    } catch {
      failed("the service that tells you your own address did not answer");
    }
    button.textContent = held;
  });
}

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[data-tab]"))
      other.setAttribute("aria-selected", String(other === tab));
    for (const shown of document.querySelectorAll("[data-panel]"))
      shown.hidden = shown.dataset.panel !== tab.dataset.tab;
  });
}

node("open-raw").addEventListener("click", () => node("raw").showModal());
node("close-raw").addEventListener("click", () => node("raw").close());

node("copy").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  await navigator.clipboard.writeText(node("copy").dataset.json ?? "");
  button.textContent = "copied";
  setTimeout(() => { button.textContent = "Copy"; }, 1200);
});

fetch("db/index.json")
  .then((response) => response.json())
  .then(({ tag }) => {
    for (const held of document.querySelectorAll("[data-tag]")) held.textContent = tag;
  })
  .catch(() => {});

const command = (address) => `curl ${API}/<span class="s">${escaped(address)}</span>`;

const rendered = (address, body) => {
  node("try-curl").innerHTML = command(address);
  node("try-json").innerHTML = painted(body);
};

const tried = async (event) => {
  event.preventDefault();
  const address = node("try-ip").value.trim();
  if (!address) return;
  if (address === SAMPLED) return rendered(address, written(SAMPLE));

  node("try-json").textContent = "…";
  try {
    const response = await fetch(`${API}/${encodeURIComponent(address)}`);
    rendered(address, written(await response.json()));
  } catch (error) {
    rendered(address, written({ error: `${error}` }));
  }
};

node("try").addEventListener("submit", tried);
node("try-ip").addEventListener("input", () => {
  node("try-curl").innerHTML = command(node("try-ip").value.trim());
});
rendered(SAMPLED, written(SAMPLE));

window.addEventListener("hashchange", route);
route();
