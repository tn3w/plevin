/** What a country code and a timezone name imply, read with no data to install. */

import { COUNTRIES } from "./countries.ts";
import type { Country, Time } from "./models.ts";
import { ZONES } from "./zones.ts";

const EU_MEMBERS = new Set(
  (
    "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI" +
    " ES SE"
  ).split(" "),
);
const LEFT_DRIVING = new Set(
  (
    "AG AI AU BB BD BM BN BS BT BW CC CK CX CY DM FJ FK GB GD GG GY HK ID IE IM" +
    " IN JE JM JP KE KI KN KY LC LK LS MO MS MT MU MV MW MY MZ NA NF NP NR NU" +
    " NZ PG PK PN SB SC SG SH SR SZ TC TH TL TO TT TV TZ UG VC VG WS ZA ZM ZW"
  ).split(" "),
);

const DAY = 86400000;
const WEEK = 7 * DAY;
const WINDOW = 400 * DAY;
const MINUTE = 60000;

const NAMED = new Map<string, [string, string, string, string]>(
  COUNTRIES.map((row) => {
    const [name, official = "", common = ""] = row.slice(8).split("|");
    return [row.slice(0, 2), [name, official, common, row.slice(2, 5)]] as const;
  }),
);
const NUMBERS = new Map(COUNTRIES.map((row) => [row.slice(0, 2), row.slice(5, 8)]));

const text = (value: string): string | null => value || null;

/** Regional indicator symbols, which spell any ISO country code as a flag. */
export const flag = (code: string): string => {
  if (code.length !== 2 || !/^[a-zA-Z]{2}$/.test(code)) return "";
  return [...code.toUpperCase()]
    .map((letter) => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65))
    .join("");
};

const countries = new Map<string, Country | null>();

/** Everything a country code implies, held for every code ever asked about. */
export const country = (code: string): Country | null => {
  if (!code) return null;
  const found = countries.get(code);
  if (found !== undefined) return found;
  const named = NAMED.get(code);
  const built: Country = {
    code,
    name: named ? named[0] : null,
    official: named ? text(named[1]) : null,
    common: named ? text(named[2]) : null,
    iso3: named ? named[3] : null,
    numeric: NUMBERS.get(code) ?? null,
    flag: flag(code) || null,
    european_union: EU_MEMBERS.has(code),
    driving_side: LEFT_DRIVING.has(code) ? "left" : "right",
  };
  countries.set(code, built);
  return built;
};

const ABBREVIATIONS = new Map(
  ZONES.map((row) => {
    const [name, standard, summer = standard] = row.split("|");
    return [name, [standard, summer]] as const;
  }),
);

const FORMATS = new Map<string, Intl.DateTimeFormat | null>();

const format = (name: string): Intl.DateTimeFormat | null => {
  const found = FORMATS.get(name);
  if (found !== undefined) return found;
  let built: Intl.DateTimeFormat | null = null;
  try {
    built = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hour12: false,
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    built = null;
  }
  FORMATS.set(name, built);
  return built;
};

/** A zone read at an instant: the wall clock it shows, as if that clock were UTC. */
const wallAt = (held: Intl.DateTimeFormat, instant: number): number => {
  const parts: Record<string, string> = {};
  for (const part of held.formatToParts(instant)) parts[part.type] = part.value;
  const year = Number(parts.year) * (parts.era === "BC" ? -1 : 1);
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return Date.UTC(
    year,
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
};

const offsetAt = (held: Intl.DateTimeFormat, instant: number): number =>
  Math.round((wallAt(held, instant) - instant) / MINUTE);

/** The offset a wall clock reading falls under, ambiguous readings taking the first. */
const offsetOf = (held: Intl.DateTimeFormat, wall: number): number => {
  const before = offsetAt(held, wall - DAY);
  const after = offsetAt(held, wall + DAY);
  if (before === after) return before;
  const settled = [before, after].filter(
    (offset) => offsetAt(held, wall - offset * MINUTE) === offset,
  );
  return settled.length ? Math.max(...settled) : Math.min(before, after);
};

const utcOffset = (minutes: number): string => {
  const held = Math.abs(minutes);
  const hours = String(Math.floor(held / 60)).padStart(2, "0");
  return `${minutes < 0 ? "-" : "+"}${hours}:${String(held % 60).padStart(2, "0")}`;
};

const stamp = (held: Intl.DateTimeFormat, wall: number): string => {
  const clocked = new Date(wall).toISOString().slice(0, 19);
  return clocked + utcOffset(offsetOf(held, wall));
};

/** The change between two probes, to the minute the zone records it on. */
const change = (
  held: Intl.DateTimeFormat,
  low: number,
  high: number,
  before: number,
): number => {
  while (high - low > 1000) {
    const middle = low + Math.floor((high - low) / 2);
    if (offsetOf(held, middle) === before) low = middle;
    else high = middle;
  }
  return Math.floor((high + 30000) / MINUTE) * MINUTE;
};

/** Every offset change within 400 days either side of a day. */
const changes = (held: Intl.DateTimeFormat, noon: number): number[] => {
  const end = noon + WINDOW;
  const found: number[] = [];
  let probe = noon - WINDOW;
  let previous = offsetOf(held, probe);
  while (probe < end) {
    const following = probe + WEEK;
    const current = offsetOf(held, following);
    if (current !== previous) found.push(change(held, probe, following, previous));
    previous = current;
    probe = following;
  }
  return found;
};

type Daylight = [number, number | null, number | null];

const DAYLIGHTS = new Map<string, Daylight>();

/** The zone's standard offset, then the daylight period around that day. */
const daylight = (name: string, held: Intl.DateTimeFormat, wall: number): Daylight => {
  const noon = Math.floor(wall / DAY) * DAY + DAY / 2;
  const key = `${name}@${noon}`;
  const found = DAYLIGHTS.get(key);
  if (found !== undefined) return found;
  if (DAYLIGHTS.size > 2048) DAYLIGHTS.clear();

  const moments = changes(held, noon);
  const offsets = [
    offsetOf(held, noon - WINDOW),
    ...moments.map((moment) => offsetOf(held, moment)),
  ];
  const standard = Math.min(...offsets);
  const summer = Math.max(...offsets);
  let built: Daylight = [standard, null, null];
  for (let index = 0; standard !== summer && index + 1 < moments.length; index += 1) {
    const [start, end] = [moments[index], moments[index + 1]];
    if (offsetOf(held, start) === summer && end >= noon) {
      built = [standard, start, end];
      break;
    }
  }
  DAYLIGHTS.set(key, built);
  return built;
};

/** What the zone calls itself: its listed abbreviation, else its bare offset. */
const abbreviation = (name: string, offset: number, daylight: boolean): string => {
  const named = ABBREVIATIONS.get(name);
  if (named) return daylight ? named[1] : named[0];
  const held = Math.abs(offset);
  const hours = String(Math.floor(held / 60)).padStart(2, "0");
  const minutes = held % 60;
  return (
    `${offset < 0 ? "-" : "+"}${hours}` +
    (minutes ? String(minutes).padStart(2, "0") : "")
  );
};

const read = (name: string, instant: number): Time => {
  const held = format(name);
  if (held === null) {
    return {
      timezone: name,
      abbreviation: null,
      local: null,
      utc_offset: null,
      is_dst: false,
      dst_start: null,
      dst_end: null,
    };
  }
  const wall = wallAt(held, instant);
  const offset = Math.round((wall - instant) / MINUTE);
  const [standard, start, end] = daylight(name, held, wall);
  return {
    timezone: name,
    abbreviation: abbreviation(name, offset, offset !== standard),
    local: new Date(wall).toISOString().slice(0, 19) + utcOffset(offset),
    utc_offset: utcOffset(offset),
    is_dst: offset !== standard,
    dst_start: start === null ? null : stamp(held, start),
    dst_end: end === null ? null : stamp(held, end),
  };
};

const SECONDS = new Map<string, Time>();

/** One zone read at one moment, defaulting to now. */
export const clock = (name: string, moment?: Date | null): Time | null => {
  if (!name) return null;
  if (moment) return read(name, moment.getTime());
  const second = Math.floor(Date.now() / 1000);
  const key = `${name}@${second}`;
  const found = SECONDS.get(key);
  if (found !== undefined) return found;
  if (SECONDS.size > 1024) SECONDS.clear();
  const built = read(name, second * 1000);
  SECONDS.set(key, built);
  return built;
};
