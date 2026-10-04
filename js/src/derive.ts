/** The answers the file does not store, read off the ones it does. */

const words = (text: string) => new Set(text.split(" "));

const FORMS = words(
  "inc incorporated llc ltd ltda limited gmbh mbh ag kgaa ohg ev eg sa sab saa" +
    " sau sal saog sac sas sarl srl spa nv bv cv asa aps oyj kft zrt nyrt doo" +
    " sro ooo zao pao pjsc jsc ojsc llp plc pte pteltd pty corp corporation" +
    " company holding holdings group uab sia tov oao pt sdn bhd coltd coltda" +
    " eireli ead ood eood sti ltdsti spzoo anonim sirketi tbk",
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
const LEGAL = new Set([...FORMS, ""]);
const TLDS = [".com", ".net", ".org", ".io"];

const TRADING = /^.*\b(?:trading as|d\/b\/a|dba)\b\s*/i;
const ALIAS = /\(.*?\)|,.*|\s+-\s+.*/g;
const BARE = /[^0-9a-z]/g;
const NUMBERED = /^AS\d+$/i;
const HANDLE_TAIL = /-(AS|AP|US|UK|DE|FR|IN|CN|JP|EU|NET|COM|ORG)$/;
const NETWORK_TAIL = /(NET|COM|TEL|WEB|LINE)$/;
const AUTHORITY = /[/?#]/;
const QUOTES = /^["']+|["']+$/g;

const SHARED = words(
  "gmail.com googlemail.com yahoo.com yahoo.co.jp yahoo.com.br yahoo.es hotmail.com" +
    " hotmail.es outlook.com live.com msn.com aol.com icloud.com proton.me" +
    " protonmail.com qq.com 163.com 126.com sina.com sohu.com foxmail.com yandex.ru" +
    " ya.ru mail.ru list.ru bk.ru inbox.ru rambler.ru gmx.de gmx.net web.de" +
    " t-online.de orange.fr free.fr libero.it wp.pl o2.pl interia.pl seznam.cz" +
    " abv.bg ukr.net i.ua naver.com hanmail.net daum.net rediffmail.com bol.com.br" +
    " uol.com.br terra.com.br ig.com.br facebook.com twitter.com x.com linkedin.com" +
    " instagram.com youtube.com",
);
const PUBLIC = words("gov mil edu gob gouv govt ac go sch");
const SECONDS = words(
  "ac co com ed edu go gob gov gouv govt gv ltd me mil ne net nom or org plc sch",
);

export const SERVERS = new Set(["hosting", "cdn", "content"]);
export const ACCESS = new Set(["residential", "cellular"]);
export const PROXIES = new Set(["public_proxy", "residential_proxy"]);
export const CRAWLER = "search_engine_spider";

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

const cased = (text: string): string =>
  text
    .split(" ")
    .map((word) => (shouts(word) ? titled(word) : word))
    .join(" ");

const trailing = (tokens: string[]): boolean => {
  const word = (tokens[tokens.length - 1] ?? "").toLowerCase().replace(BARE, "");
  return (tokens.length > 1 && LEGAL.has(word)) || (tokens.length > 2 && TAILS.has(word));
};

const fromCompany = (company: string): string => {
  const held = company.replace(TRADING, "").replace(ALIAS, "");
  const tokens = held
    .split(/\s+/)
    .map((word) => word.replace(QUOTES, ""))
    .filter(Boolean);
  while (trailing(tokens)) tokens.pop();
  while (tokens.length && LEAD.has(tokens[0].toLowerCase().replace(BARE, ""))) {
    tokens.shift();
  }
  const name = tokens.join(" ");
  const tld = TLDS.find((held) => name.toLowerCase().endsWith(held));
  return cased(tld ? name.slice(0, name.length - tld.length) : name);
};

const fromHandle = (handle: string): string => {
  const words = handle.split(/\s+/).filter(Boolean);
  const first = words.length === 1 ? words[0] : "";
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
  if (company.toLowerCase() === handle.toLowerCase()) return short || legal;
  if (!legal || !short) return legal || short;
  if (legal.toLowerCase() === short.toLowerCase()) {
    return short === short.toUpperCase() ? legal : short;
  }
  return legal.toLowerCase().startsWith(`${short.toLowerCase()} `) ? short : legal;
});

/** The name a network goes by: its handle where the company only spells it out. */
export const brand = (handle: string, company: string): string =>
  branded(`${handle}\n${company}`);

const squeezed = (text: string): string => text.toLowerCase().replace(BARE, "");

const GENERIC = new Set([
  ...FORMS,
  ...TAILS,
  ...words("telekom broadband wireless mobile"),
]);

const related = (site: string, names: string): boolean => {
  const labels = site.split(".");
  const key = squeezed(labels[0]);
  const joined = squeezed(names);
  if (
    (key.length > 2 && joined.includes(key)) ||
    (key.length === 2 && joined.startsWith(key))
  ) {
    return true;
  }
  const named = names
    .toLowerCase()
    .split(/[\s_,.&/()-]+/)
    .map(squeezed);
  if (named.some((word) => word.length > 3 && !GENERIC.has(word) && key.includes(word))) {
    return true;
  }
  return labels.slice(1).some((label) => PUBLIC.has(label));
};

const registrable = (host: string): string => {
  const labels = host.split(".");
  if (labels.length < 3) return host;
  const last = labels[labels.length - 1];
  const deep = last.length === 2 && SECONDS.has(labels[labels.length - 2]);
  return labels.slice(deep ? -3 : -2).join(".");
};

const domained = kept((key: string): string => {
  const [website, rest] = split(key);
  const [mailbox, names] = split(rest);
  const authority = (website.split("//").pop() ?? "").split(AUTHORITY)[0];
  const host = (authority.split("@").pop() ?? "").split(":")[0].toLowerCase();
  const mail = registrable((mailbox.split("@")[1] ?? "").toLowerCase());
  const box = SHARED.has(mail) ? "" : mail;
  const named = registrable(host.replace(/^www\./, ""));
  const site = SHARED.has(named) ? "" : named;
  if (!site) return box && related(box, names) ? box : "";
  const top = site.split(".").pop() ?? "";
  if (top.length > 2 && box.split(".")[0] === top && site !== box) return box;
  return site;
});

/** The registered domain the website names, else the one the abuse mailbox does. */
export const domain = (website: string, mailbox: string, names = ""): string =>
  domained(`${website}\n${mailbox}\n${names}`);

/** The site is stored as its host and path; every one of them answers over https. */
export const website = (host: string): string => (host ? `https://${host}` : "");

/** A public proxy on an access network is someone's home line, resold. */
export const service = (named: string, userType: string): [string, string] =>
  named === "public_proxy" && ACCESS.has(userType)
    ? ["residential_proxy", "inferred"]
    : [named, ""];

/** The city type already says which capital it is, so nothing stores it twice. */
export const capital = (cityType: string): string => CAPITALS[cityType] ?? "";
