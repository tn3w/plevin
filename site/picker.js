import { download } from "./database.js";
import { FIELDS, PRESETS } from "./fields.js";
import { estimate } from "./plevin/estimate.js";
import { Plevin } from "./plevin/index.js";
import { FIELD_NEEDS, fileName, parse } from "./plevin/selection.js";

const node = (id) => document.getElementById(id);

const make = (tag, className, text) => {
  const held = document.createElement(tag);
  if (className) held.className = className;
  if (text !== undefined) held.textContent = text;
  return held;
};

const GROUPS = [
  ["place", "Where"],
  ["network", "Who"],
  ["abuse", "Risk"],
];
const STORED = FIELDS.filter((field) => !field.needs).map((field) => field.id);
const DERIVED = new Map(FIELDS.filter((field) => field.needs).map((f) => [f.id, f.needs]));

const state = {
  chosen: new Set(),
  available: new Set(STORED),
  stats: null,
  worker: null,
  opening: null,
  building: false,
  result: null,
};
const rows = new Map();

const bytesOf = (count) => {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)} MB`;
  if (count >= 1e3) return `${Math.round(count / 1e3)} KB`;
  return `${count} bytes`;
};

const shown = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 34 ? `${text.slice(0, 33)}…` : text;
};

const needed = () => {
  const held = new Set();
  for (const id of state.chosen) for (const need of DERIVED.get(id) ?? []) held.add(need);
  return held;
};

const storedChoice = () => {
  const held = needed();
  for (const id of state.chosen) if (!DERIVED.has(id)) held.add(id);
  return held;
};

const prefixes = (id) => {
  const parts = id.split(".");
  return parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join("."));
};

const compact = (held, all) => {
  if (held.size === all.length) return "full";
  const covered = new Set();
  const terms = [];
  const shortest = [...new Set(all.flatMap(prefixes))].sort((a, b) => a.length - b.length);
  for (const prefix of shortest) {
    const members = all.filter((id) => id.startsWith(`${prefix}.`));
    const whole = members.length > 1 && members.every((id) => held.has(id));
    if (!whole || members.every((id) => covered.has(id))) continue;
    terms.push(prefix);
    for (const id of members) covered.add(id);
  }
  for (const id of held) if (!covered.has(id)) terms.push(id);
  return terms.sort().join("+");
};

const termsOfIds = (held) => {
  const all = STORED.filter((id) => state.available.has(id));
  return held.size ? compact(held, all) : "";
};

const currentTerms = () => termsOfIds(storedChoice());

const idsOf = (preset) => (preset.terms[0] === "full" ? STORED : preset.terms);

const presetTerms = (preset) => {
  const held = new Set();
  for (const id of idsOf(preset)) {
    if (DERIVED.has(id)) for (const need of DERIVED.get(id)) held.add(need);
    else held.add(id);
  }
  return termsOfIds(held);
};

const included = (terms) => {
  if (!terms) return new Set();
  const held = new Set(parse(terms, state.available).fields);
  for (const [id, needs] of DERIVED) {
    if (needs.every((need) => held.has(need))) held.add(id);
  }
  return held;
};

const sizeOf = (terms) => (state.stats && terms ? estimate(state.stats, terms) : null);

const setStatus = (text) => {
  node("slim-status").textContent = text;
};

const setBar = (fraction) => {
  node("slim-bar").style.width = `${Math.round(fraction * 100)}%`;
};

const call = (type, payload, onProgress) =>
  new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const worker = state.worker;
    const listen = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") return onProgress?.(data);
      worker.removeEventListener("message", listen);
      if (data.type === "failed") reject(new Error(data.message));
      else resolve(data);
    };
    worker.addEventListener("message", listen);
    const transfer = payload.bytes ? [payload.bytes.buffer] : [];
    worker.postMessage({ type, id, ...payload }, transfer);
  });

const progressText = ({ label, done, total }) => {
  if (total) setBar(done / total);
  setStatus(total ? `${label} ${done}/${total}` : `${label}…`);
};

const open = () => {
  state.opening ??= (async () => {
    const bytes = await download("db/plevin.raw", (text, fraction) => {
      setStatus(text);
      setBar(fraction);
    });
    setBar(0);
    setStatus("starting the repacker");
    state.worker = new Worker("slim-worker.js", { type: "module" });
    const opened = await call("open", { bytes });
    node("slim-built").textContent = `database built ${opened.built}`;
  })();
  state.opening.catch(() => {
    state.opening = null;
  });
  return state.opening;
};

const changed = () => {
  state.result = null;
  refresh();
};

const toggle = (id) => {
  if (state.chosen.has(id)) state.chosen.delete(id);
  else state.chosen.add(id);
  changed();
};

const choose = (ids) => {
  state.chosen = new Set(ids);
  changed();
};

const reason = (id, free, held) => {
  if (state.chosen.has(id) || !free.has(id)) return "";
  if (held.has(id)) return "needed by a field you chose";
  const needs = DERIVED.get(id);
  if (needs) return `computed from ${needs.join(", ")}`;
  const mine = new Set(FIELD_NEEDS[id]);
  const from = [...storedChoice()].find((one) => FIELD_NEEDS[one]?.some((need) => mine.has(need)));
  const shared = from && FIELD_NEEDS[from].find((need) => mine.has(need));
  return from ? `same ${shared} data as ${from}` : "comes free with the data you chose";
};

const refresh = () => {
  const terms = currentTerms();
  const free = included(terms);
  const held = needed();
  for (const [id, row] of rows) {
    const missing = DERIVED.has(id)
      ? !DERIVED.get(id).every((need) => state.available.has(need))
      : !state.available.has(id);
    const explicit = state.chosen.has(id);
    const automatic = !explicit && free.has(id);
    row.box.checked = explicit || automatic;
    row.box.disabled = missing || (held.has(id) && !explicit);
    row.label.classList.toggle("free", automatic);
    row.label.classList.toggle("gone", missing);
    row.why.textContent = missing ? "not in this build" : reason(id, free, held);
  }
  render(terms, free);
};

const render = (terms, free) => {
  const explicit = storedChoice().size;
  node("slim-count").textContent = terms
    ? `${explicit} chosen, ${Math.max(free.size - explicit, 0)} more come free`
    : "Nothing chosen yet";
  node("slim-terms").textContent = terms || "-";
  const size = sizeOf(terms);
  const actual = state.result?.bytes.length;
  const label = size ? `about ${bytesOf(size)}` : "-";
  node("slim-size").textContent = actual ? bytesOf(actual) : label;
  node("slim-build").disabled = !terms || state.building;
  node("slim-cli").textContent = terms ? `npx plevinjs ${terms}` : "";
  node("slim-js").textContent = terms ? `slim(raw, "${terms}")` : "";
  for (const button of document.querySelectorAll(".preset")) {
    const preset = PRESETS.find((one) => one.id === button.dataset.id);
    button.classList.toggle("on", Boolean(terms) && presetTerms(preset) === terms);
  }
  node("slim-result").hidden = !state.result;
  if (state.building || state.result) return;
  setStatus(
    terms
      ? "Building downloads the 30 MB raw file once and keeps it in your browser."
      : "Pick a preset or some fields.",
  );
};

const save = (result) => {
  const blob = new Blob([result.bytes], { type: "application/octet-stream" });
  const link = make("a");
  link.href = URL.createObjectURL(blob);
  link.download = result.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
};

const kept = (_, value) => {
  if (typeof value === "bigint") return String(value);
  return value === null ? undefined : value;
};

const tryout = (ip) => {
  const { db } = state.result;
  node("slim-ip").value = ip;
  const { place, network, abuse } = db.lookup(ip);
  node("slim-json").textContent = JSON.stringify({ place, network, abuse }, kept, 2);
};

const drawIps = () => {
  const { example } = state.result;
  const chosen = FIELDS.filter((field) => state.chosen.has(field.id) && field.example);
  const ips = [...new Set([example, ...chosen.map((field) => field.example.ip)])];
  const buttons = ips.slice(0, 6).map((ip) => {
    const button = make("button", "ghost small", ip);
    button.type = "button";
    button.addEventListener("click", () => tryout(ip));
    return button;
  });
  node("slim-ips").replaceChildren(...buttons);
};

const build = async () => {
  const terms = currentTerms();
  if (!terms) return;
  state.building = true;
  render(terms, included(terms));
  try {
    await open();
    setStatus("rebuilding");
    const started = performance.now();
    const answer = await call("build", { terms }, progressText);
    const preset = PRESETS.find((one) => presetTerms(one) === terms);
    const example = preset?.ip ?? "1.1.1.1";
    const db = new Plevin(answer.bytes);
    db.lookup(example);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    state.result = { name: fileName(terms), bytes: answer.bytes, db, example };
    const guess = sizeOf(terms);
    const name = state.result.name;
    node("slim-download").textContent = `Download ${name} (${bytesOf(answer.bytes.length)})`;
    const said = guess ? ` The estimate said ${bytesOf(guess)}.` : "";
    setStatus(`Built in ${seconds} s and checked: it opens and answers.${said}`);
    drawIps();
    tryout(example);
  } catch (error) {
    setStatus(error.message);
  }
  state.building = false;
  setBar(0);
  render(terms, included(terms));
};

const presetCard = (preset) => {
  const button = make("button", "preset");
  button.type = "button";
  button.dataset.id = preset.id;
  button.append(make("b", "", preset.title), make("span", "", preset.about), make("i", ""));
  button.addEventListener("click", () => choose(idsOf(preset)));
  return button;
};

const example = (field) => {
  const held = make("span", "example");
  if (!field.example) return held;
  held.append(make("em", "", field.example.ip), make("span", "", shown(field.example.value)));
  return held;
};

const rowOf = (field) => {
  const label = make("label", "pick");
  const box = make("input");
  box.type = "checkbox";
  box.addEventListener("change", () => toggle(field.id));
  const body = make("span", "body");
  body.append(make("code", "", field.id), make("span", "about", field.about), example(field));
  const why = make("span", "why");
  label.append(box, body, why);
  rows.set(field.id, { label, box, why });
  return label;
};

const groupOf = ([id, title]) => {
  const card = make("div", "pickgroup");
  card.dataset.group = id;
  card.append(make("h3", "", title));
  const members = FIELDS.filter((field) => field.group === id);
  for (const part of [...new Set(members.map((field) => field.part))]) {
    const inside = members.filter((field) => field.part === part);
    const head = make("div", "partline");
    const all = make("button", "ghost small", "all");
    all.type = "button";
    all.addEventListener("click", () => {
      const ids = inside.map((field) => field.id);
      const every = ids.every((one) => state.chosen.has(one));
      for (const one of ids) every ? state.chosen.delete(one) : state.chosen.add(one);
      changed();
    });
    head.append(make("h4", "", part), all);
    card.append(head, ...inside.map(rowOf));
  }
  return card;
};

const loadStats = async () => {
  try {
    const response = await fetch("db/stats.json");
    if (!response.ok) return;
    state.stats = await response.json();
    state.available = new Set(state.stats.fields);
  } catch {
    state.stats = null;
  }
};

const labelPresets = () => {
  for (const button of document.querySelectorAll(".preset")) {
    const preset = PRESETS.find((one) => one.id === button.dataset.id);
    const size = sizeOf(presetTerms(preset));
    button.querySelector("i").textContent = size ? `about ${bytesOf(size)}` : "";
  }
};

const start = async () => {
  node("presets").replaceChildren(...PRESETS.map(presetCard));
  node("picker").replaceChildren(...GROUPS.map(groupOf));
  node("slim-build").addEventListener("click", build);
  node("slim-download").addEventListener("click", () => save(state.result));
  node("slim-try").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      tryout(node("slim-ip").value.trim());
    } catch (error) {
      node("slim-json").textContent = error.message;
    }
  });
  refresh();
  await loadStats();
  labelPresets();
  refresh();
};

start();
