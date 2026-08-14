/** The answers the file does not store, read off the ones it does. */

const words = (text: string) => new Set(text.split(" "));

const FORMS = words(
  "inc incorporated llc ltd ltda limited gmbh mbh ag kgaa ohg ev eg sa sab saa" +
    " sau sal saog sac sas sarl srl spa nv bv cv asa aps oyj kft zrt nyrt doo" +
    " sro ooo zao pao pjsc jsc ojsc llp plc pte pteltd pty corp corporation" +
    " company holding holdings group uab sia tov oao pt sdn bhd coltd coltda" +
    " eireli ead ood eood sti ltdsti spzoo",
);
const TAILS = words(
  "de me epp co as ab ad dd bt lc lp se sl slu sp z oo zoo oy ao esp kg network" +
    " networks net telecom telecoms telecommunication telecommunications" +
    " telecomunicaciones comunicaciones communication communications hosting" +
    " solutions services service technologies technology tech systems system" +
    " data datacenter datacentre cloud internet online isp international global" +
    " enterprises enterprise backbone provider providers of and",
);
const LEAD = words(
  "the llc ltd gmbh sarl ooo zao pao ao oao jsc ojsc pjsc uab sia tov pt pp ps" +
    " ip spolka",
);
const TAIL = new Set([...FORMS, ...TAILS, ""]);
const TLDS = [".com", ".net", ".org", ".io"];

const TRADING = /^.*\b(?:trading as|d\/b\/a|dba)\b\s*/i;
const ALIAS = /\(.*?\)|,.*|\s+-\s+.*/g;
const BARE = /[^0-9a-z]/g;
const NUMBERED = /^AS\d+$/i;
const HANDLE_TAIL = /-(AS|AP|US|UK|DE|FR|IN|CN|JP|EU|NET|COM|ORG)$/;
const NETWORK_TAIL = /(NET|COM|TEL|WEB|LINE)$/;
const AUTHORITY = /[/?#]/;
const QUOTES = /^["']+|["']+$/g;

export const SERVERS = new Set(["hosting", "cdn", "content"]);
export const ACCESS = new Set(["residential", "cellular"]);
export const PROXIES = new Set(["public_proxy", "residential_proxy"]);

const CAPITALS: Record<string, string> = {
  "national capital": "country",
  "regional capital": "region",
  "district capital": "district",
};

const NAMES = 1 << 13;

const kept = <Held>(build: (key: string) => Held) => {
  const held = new Map<string, Held>();
  return (key: string): Held => {
    const found = held.get(key);
    if (found !== undefined) return found;
    if (held.size >= NAMES) held.clear();
    const built = build(key);
    held.set(key, built);
    return built;
  };
};

const LETTERS = /^\p{L}+$/u;

const split = (key: string): [string, string] => {
  const at = key.indexOf("\n");
  return [key.slice(0, at), key.slice(at + 1)];
};

const shouts = (word: string): boolean =>
  word.length > 4 &&
  LETTERS.test(word) &&
  word === word.toUpperCase() &&
  word !== word.toLowerCase();

const titled = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** Shouted words stop shouting, `GOOGLE` reading as `Google` and `IBM` as `IBM`. */
const cased = (text: string): string =>
  text
    .split(" ")
    .map((word) => (shouts(word) ? titled(word) : word))
    .join(" ");

/** Aliases, legal forms and the words every network shares, all stripped. */
const fromCompany = (company: string): string => {
  const held = company.replace(TRADING, "").replace(ALIAS, "");
  const tokens = held
    .split(/\s+/)
    .map((word) => word.replace(QUOTES, ""))
    .filter(Boolean);
  while (
    tokens.length > 1 &&
    TAIL.has(tokens[tokens.length - 1].toLowerCase().replace(BARE, ""))
  ) {
    tokens.pop();
  }
  while (tokens.length && LEAD.has(tokens[0].toLowerCase().replace(BARE, ""))) {
    tokens.shift();
  }
  const name = tokens.join(" ");
  const tld = TLDS.find((held) => name.toLowerCase().endsWith(held));
  return cased(tld ? name.slice(0, name.length - tld.length) : name);
};

/** The first word of a registry handle, its country and network tails gone. */
const fromHandle = (handle: string): string => {
  const first = handle.split(/\s+/)[0] ?? "";
  let head = first.replace(HANDLE_TAIL, "");
  if (NUMBERED.test(head)) return "";
  if (head.length > 4 && head === head.toUpperCase()) {
    head = head.replace(NETWORK_TAIL, "");
  }
  return cased(head);
};

const branded = kept((key: string): string => {
  const [handle, company] = split(key);
  const legal = fromCompany(company);
  const short = fromHandle(handle);
  if (!legal || !short) return legal || short;
  if (legal.toLowerCase() === short.toLowerCase()) {
    return short === short.toUpperCase() ? legal : short;
  }
  return legal.toLowerCase().startsWith(`${short.toLowerCase()} `) ? short : legal;
});

/** The name a network goes by: its handle where the company only spells it out. */
export const brand = (handle: string, company: string): string =>
  branded(`${handle}\n${company}`);

const domained = kept((key: string): string => {
  const [website, mailbox] = split(key);
  const authority = (website.split("//").pop() ?? "").split(AUTHORITY)[0];
  const host = (authority.split("@").pop() ?? "").split(":")[0];
  const box = (mailbox.split("@")[1] ?? "").toLowerCase();
  const site = (host || box).toLowerCase().replace(/^www\./, "");
  const top = site.split(".").pop() ?? "";
  if (top.length > 2 && box.split(".")[0] === top && site !== box) return box;
  return site;
});

/** The bare host the website names, else the one the abuse mailbox does. */
export const domain = (website: string, mailbox: string): string =>
  domained(`${website}\n${mailbox}`);

/** A public proxy on an access network is someone's home line, resold. */
export const service = (named: string, userType: string): [string, string] =>
  named === "public_proxy" && ACCESS.has(userType)
    ? ["residential_proxy", "inferred"]
    : [named, ""];

/** The city type already says which capital it is, so nothing stores it twice. */
export const capital = (cityType: string): string => CAPITALS[cityType] ?? "";
