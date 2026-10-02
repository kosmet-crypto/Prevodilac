"use strict";

/* ------------------------------------------------------------------
 * Конфигурација
 * ------------------------------------------------------------------ */

// Бесплатан сервис за превод, без кључа (анонимно око 5000 знакова дневно).
const MT_URL = "https://api.mymemory.translated.net/get";
const MT_CHUNK = 450; // MyMemory прима највише 500 бајтова по захтеву
const MAX_INPUT = 1000;
const HISTORY_LIMIT = 50;

// Кодови језика које пробамо редом, ако сервис неки не прихвати.
const LANG_CODES = { sr: ["sr", "sr-Latn", "sr-RS"], no: ["nb", "no", "nb-NO"] };

const STORAGE = {
  theme: "prevodilac.theme",
  direction: "prevodilac.direction",
  script: "prevodilac.script",
  history: "prevodilac.history",
  langPair: "prevodilac.langPair",
};

const TOPIC_LABELS = {
  grammar: "граматика",
  word_order: "ред речи",
  register: "регистар",
};

/* ------------------------------------------------------------------
 * Помоћне функције
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const store = {
  get(k, fallback = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* приватни режим */ }
  },
  remove(k) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
  getJSON(k, fallback) {
    try { return JSON.parse(store.get(k)) ?? fallback; } catch { return fallback; }
  },
};

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// MyMemory понекад враћа HTML ентитете (&#39; итд.).
function decodeEntities(s) {
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}

/* ------------------------------------------------------------------
 * Ћирилица ⇄ латиница
 * ------------------------------------------------------------------ */

const CYR = "АБВГДЂЕЖЗИЈКЛЉМНЊОПРСТЋУФХЦЧЏШабвгдђежзијклљмнњопрстћуфхцчџш";
const LAT = ["A", "B", "V", "G", "D", "Đ", "E", "Ž", "Z", "I", "J", "K", "L", "Lj", "M", "N", "Nj", "O", "P", "R", "S", "T", "Ć", "U", "F", "H", "C", "Č", "Dž", "Š",
  "a", "b", "v", "g", "d", "đ", "e", "ž", "z", "i", "j", "k", "l", "lj", "m", "n", "nj", "o", "p", "r", "s", "t", "ć", "u", "f", "h", "c", "č", "dž", "š"];
const CYR2LAT = Object.fromEntries([...CYR].map((c, i) => [c, LAT[i]]));
const LAT2CYR = Object.fromEntries([...CYR].map((c, i) => [LAT[i], c]));
LAT2CYR.LJ = "Љ"; LAT2CYR.NJ = "Њ"; LAT2CYR["DŽ"] = "Џ";

function toLatin(s) {
  return [...s].map((c) => CYR2LAT[c] ?? c).join("");
}

function toCyrillic(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (LAT2CYR[two]) { out += LAT2CYR[two]; i++; continue; }
    out += LAT2CYR[s[i]] ?? s[i];
  }
  return out;
}

// За поређење са речником идиома: латиница, мала слова, без квачица.
function normalizeSerbian(s) {
  return toLatin(s).toLowerCase()
    .replace(/[čć]/g, "c").replace(/š/g, "s").replace(/ž/g, "z").replace(/đ/g, "dj")
    .replace(/\s+/g, " ");
}

/* ------------------------------------------------------------------
 * Стање
 * ------------------------------------------------------------------ */

const state = {
  direction: store.get(STORAGE.direction, "sr-no"), // "sr-no" | "no-sr"
  script: store.get(STORAGE.script, "cyrl"),
  busy: false,
  lastResult: null,
};

/* ------------------------------------------------------------------
 * Тема
 * ------------------------------------------------------------------ */

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
}

function effectiveDark() {
  const t = store.get(STORAGE.theme, "auto");
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/* ------------------------------------------------------------------
 * Смер и писмо
 * ------------------------------------------------------------------ */

function renderDirection() {
  const toNo = state.direction === "sr-no";
  $("srcLabel").textContent = toNo ? "Српски" : "Norsk (bokmål)";
  $("tgtLabel").textContent = toNo ? "Norsk (bokmål)" : "Српски";
  $("inputLabel").textContent = toNo
    ? "Текст на српском (ћирилица или латиница)"
    : "Текст на норвешком (bokmål)";
  $("input").placeholder = toNo
    ? "нпр. Пала ми је секира у мед — данас сам добио посао!"
    : "f.eks. Det regner trollkjerringer, men ingen ko på isen.";
  $("input").lang = toNo ? "sr" : "nb";
  $("scriptField").hidden = toNo;
  $("speakInputBtn").hidden = toNo || !ttsAvailable();
  document.querySelectorAll('input[name="script"]').forEach((r) => { r.checked = r.value === state.script; });
}

/* ------------------------------------------------------------------
 * Изговор (Web Speech API)
 * ------------------------------------------------------------------ */

let nbVoice = null;

function ttsAvailable() {
  return "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

function pickVoice() {
  if (!ttsAvailable()) return;
  const voices = speechSynthesis.getVoices();
  nbVoice =
    voices.find((v) => /^nb([-_]|$)/i.test(v.lang)) ||
    voices.find((v) => /^no([-_]|$)/i.test(v.lang)) ||
    voices.find((v) => /^nn([-_]|$)/i.test(v.lang)) ||
    null;
}

function speakNorwegian(text) {
  if (!ttsAvailable() || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "nb-NO";
  if (nbVoice) u.voice = nbVoice;
  u.rate = 0.9;
  speechSynthesis.speak(u);
  if (!nbVoice) toast("Норвешки глас није пронађен — прегледач користи подразумевани.");
}

/* ------------------------------------------------------------------
 * Машински превод (MyMemory)
 * ------------------------------------------------------------------ */

// Дели текст на делове до MT_CHUNK знакова, по реченицама.
function splitChunks(text) {
  const sentences = text.match(/[^.!?…\n]+[.!?…]*\s*|\n+/g) || [text];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > MT_CHUNK && cur) {
      chunks.push(cur);
      cur = "";
    }
    if (s.length > MT_CHUNK) {
      for (let i = 0; i < s.length; i += MT_CHUNK) chunks.push(s.slice(i, i + MT_CHUNK));
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.filter((c) => c.trim());
}

class LangCodeError extends Error {}

async function mtRequest(q, src, tgt) {
  const url = `${MT_URL}?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(src + "|" + tgt)}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Сервис за превод није доступан. Провери интернет везу.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* празан одговор */ }
  const status = Number(data && data.responseStatus) || res.status;
  const details = String((data && data.responseDetails) || "");
  const text = String((data && data.responseData && data.responseData.translatedText) || "");

  if (status === 429 || /MYMEMORY WARNING/i.test(text)) {
    throw new Error("Потрошен је бесплатан дневни лимит за превод (око 5000 знакова). Покушај сутра.");
  }
  if (/INVALID (SOURCE|TARGET) LANGUAGE|LANGUAGE PAIR/i.test(details) || /INVALID (SOURCE|TARGET) LANGUAGE/i.test(text)) {
    throw new LangCodeError(details || text);
  }
  if (status !== 200 || !text) {
    throw new Error(`Сервис за превод је вратио грешку (${status}). ${details}`.trim());
  }
  return { text: decodeEntities(text), matches: Array.isArray(data.matches) ? data.matches : [] };
}

// Проба кодове језика док сервис не прихвати пар, и памти који је прошао.
async function mtTranslate(q, from, to) {
  const saved = store.getJSON(STORAGE.langPair, {});
  const key = `${from}-${to}`;
  const pairs = [];
  if (saved[key]) pairs.push(saved[key]);
  for (const s of LANG_CODES[from]) {
    for (const t of LANG_CODES[to]) {
      if (!pairs.some((x) => x[0] === s && x[1] === t)) pairs.push([s, t]);
    }
  }
  let lastErr;
  for (const [s, t] of pairs) {
    try {
      const r = await mtRequest(q, s, t);
      saved[key] = [s, t];
      store.set(STORAGE.langPair, JSON.stringify(saved));
      return r;
    } catch (e) {
      if (!(e instanceof LangCodeError)) throw e;
      lastErr = e;
    }
  }
  throw new Error("Сервис за превод не подржава овај пар језика. " + (lastErr ? lastErr.message : ""));
}

async function translateText(text, direction) {
  const from = direction === "sr-no" ? "sr" : "no";
  const to = direction === "sr-no" ? "no" : "sr";
  const chunks = splitChunks(text);
  const parts = [];
  let alternatives = [];
  for (const c of chunks) {
    const r = await mtTranslate(c.trim(), from, to);
    parts.push(r.text);
    if (chunks.length === 1) {
      const seen = new Set([r.text.trim().toLowerCase()]);
      alternatives = r.matches
        .map((m) => decodeEntities(String(m.translation || "")).trim())
        .filter((t) => {
          const k = t.toLowerCase();
          if (!t || seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 3);
    }
  }
  return { natural: parts.join(" ").replace(/\s+\n/g, "\n").trim(), alternatives };
}

/* ------------------------------------------------------------------
 * Фразе и напомене (локално, без интернета)
 * ------------------------------------------------------------------ */

function findPhrases(text, direction) {
  const dir = direction === "sr-no" ? "sr" : "no";
  const norm = dir === "sr" ? normalizeSerbian(text) : text.toLowerCase().replace(/\s+/g, " ");
  return IDIOMS.filter((i) => i.dir === dir && i.re.test(norm));
}

const V2_RE = /(^|[.!?]\s+)(i dag|i går|i morgen|i kveld|nå|her|der|så|derfor|da|etterpå|kanskje|heldigvis|dessverre|ofte|alltid)\s+\p{L}+\s+(jeg|du|han|hun|vi|dere|de|det|den|man)\b/iu;

function buildNotes(input, output, direction) {
  const notes = [];
  const toNo = direction === "sr-no";
  const nor = toNo ? output : input;

  if (toNo && /(^|[^\p{L}])(Vi|Vas|Vama|Vaš\p{L}*|Ви|Вас|Вама|Ваш\p{L}*)(?![\p{L}])/u.test(input)) {
    notes.push({ topic: "register", text: "Норвежани се и формално обраћају са „du“. Облик „De“ (Ви) звучи старинско и користи се само у врло свечаним приликама." });
  }
  if (!toNo && /\bdu\b/i.test(input)) {
    notes.push({ topic: "register", text: "„Du“ се у норвешком користи и према непознатима и старијима. У српском би у таквим ситуацијама често ишло „Ви“." });
  }
  if (/\bdere\b/i.test(nor)) {
    notes.push({ topic: "grammar", text: "„Dere“ значи „ви“ кад се обраћаш већем броју људи. Једној особи се увек каже „du“." });
  }
  if (V2_RE.test(nor)) {
    notes.push({ topic: "word_order", text: "Ред речи V2: глагол је увек на другом месту у реченици. Ако реченица почне прилогом („I dag“, „Nå“, „Derfor“…), субјекат иде иза глагола: „I dag fikk jeg …“." });
  }
  if (/\bikke\b/i.test(nor)) {
    notes.push({ topic: "word_order", text: "„Ikke“ иде иза глагола у главној реченици („jeg liker ikke …“), а испред глагола у зависној („fordi jeg ikke liker …“)." });
  }
  return notes;
}

/* ------------------------------------------------------------------
 * Приказ резултата
 * ------------------------------------------------------------------ */

function renderResult(r, direction) {
  const toNo = direction === "sr-no";
  $("result").hidden = false;
  $("translationCard").hidden = !r.natural;
  $("naturalText").textContent = r.natural || "";
  $("naturalText").lang = toNo ? "nb" : "sr";
  document.querySelectorAll(".speak-btn").forEach((b) => { b.hidden = !toNo || !ttsAvailable(); });

  // Други преводи
  const alts = Array.isArray(r.alternatives) ? r.alternatives : [];
  $("altWrap").hidden = !alts.length;
  const altList = $("alternatives");
  altList.innerHTML = "";
  for (const a of alts) {
    const li = document.createElement("li");
    li.textContent = a;
    li.lang = toNo ? "nb" : "sr";
    altList.appendChild(li);
  }

  // Фразе
  const phrases = Array.isArray(r.phrases) ? r.phrases : [];
  const pWrap = $("phrases");
  pWrap.innerHTML = "";
  if (!phrases.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Нисам препознао ниједну фразу из речника идиома.";
    pWrap.appendChild(p);
  }
  const tgtName = toNo ? "норвешки" : "српски";
  for (const ph of phrases) {
    const box = document.createElement("div");
    box.className = "phrase";

    const h = document.createElement("h3");
    h.textContent = `„${ph.original}“`;
    if (ph.level) {
      const tag = document.createElement("span");
      tag.className = "tag level-tag";
      tag.textContent = ph.level;
      tag.title = "CEFR ниво израза";
      h.appendChild(tag);
    }
    box.appendChild(h);

    const dl = document.createElement("dl");
    const add = (term, value, cls) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (cls) dd.className = cls;
      dl.append(dt, dd);
    };
    add("Буквално:", ph.literal);
    if (ph.has) {
      add(`Еквивалент (${tgtName}):`, ph.equivalent, "eq");
    } else {
      add("Еквивалент:", `Нема правог еквивалента у ${toNo ? "норвешком" : "српском"}.`, "none");
      add("Најприродније:", ph.equivalent, "eq");
    }
    box.appendChild(dl);

    const p = document.createElement("p");
    p.textContent = ph.explanation;
    box.appendChild(p);
    pWrap.appendChild(box);
  }

  // Напомене
  const notes = Array.isArray(r.notes) ? r.notes : [];
  $("notesCard").hidden = !notes.length;
  const ul = $("notes");
  ul.innerHTML = "";
  for (const n of notes) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = TOPIC_LABELS[n.topic] || n.topic;
    li.append(tag, n.text);
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------------
 * Историја
 * ------------------------------------------------------------------ */

function loadHistory() {
  const h = store.getJSON(STORAGE.history, []);
  // Ставке из старије верзије (са Claude-ом) имају друкчији облик, прескачемо их.
  return Array.isArray(h) ? h.filter((e) => e && e.result && Array.isArray(e.result.phrases) && e.v === 2) : [];
}

function saveToHistory(entry) {
  const h = loadHistory();
  h.unshift({ ...entry, v: 2 });
  store.set(STORAGE.history, JSON.stringify(h.slice(0, HISTORY_LIMIT)));
}

function renderHistory() {
  const h = loadHistory();
  const list = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").hidden = h.length > 0;
  $("clearHistory").hidden = h.length === 0;
  h.forEach((e) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    const meta = document.createElement("span");
    meta.className = "meta";
    const dir = e.direction === "sr-no" ? "СР → NO" : "NO → СР";
    meta.textContent = `${dir} · ${new Date(e.time).toLocaleString("sr-RS")}`;
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = e.input.length > 140 ? e.input.slice(0, 140) + "…" : e.input;
    const tgt = document.createElement("span");
    tgt.className = "tgt";
    const nat = e.result.natural || "";
    tgt.textContent = nat.length > 140 ? nat.slice(0, 140) + "…" : nat;
    b.append(meta, src, tgt);
    b.addEventListener("click", () => {
      state.direction = e.direction;
      if (e.script) state.script = e.script;
      renderDirection();
      $("input").value = e.input;
      updateCount();
      state.lastResult = { result: e.result, direction: e.direction };
      renderResult(e.result, e.direction);
      setStatus("");
      $("historyDialog").close();
      $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    li.appendChild(b);
    list.appendChild(li);
  });
}

/* ------------------------------------------------------------------
 * Главни ток
 * ------------------------------------------------------------------ */

function updateCount() {
  $("charCount").textContent = `${$("input").value.length} / ${MAX_INPUT}`;
}

async function translate() {
  if (state.busy) return;
  const text = $("input").value.trim();
  if (!text) {
    setStatus("Унеси текст за превод.", "error");
    $("input").focus();
    return;
  }
  if (text.length > MAX_INPUT) {
    setStatus(`Текст је предугачак (највише ${MAX_INPUT} знакова).`, "error");
    return;
  }

  state.busy = true;
  $("translateBtn").disabled = true;
  $("translateBtn").textContent = "Преводим…";
  setStatus("Преводим…", "loading");

  const direction = state.direction;
  const script = state.script;
  const phrases = findPhrases(text, direction);
  try {
    const mt = await translateText(text, direction);
    let natural = mt.natural;
    let alternatives = mt.alternatives;
    if (direction === "no-sr") {
      const conv = script === "latn" ? toLatin : toCyrillic;
      natural = conv(natural);
      alternatives = alternatives.map(conv);
    }
    const result = {
      natural,
      alternatives,
      phrases: phrases.map(({ re, dir, ...rest }) => rest),
      notes: buildNotes(text, natural, direction),
    };
    state.lastResult = { result, direction };
    renderResult(result, direction);
    setStatus("");
    saveToHistory({ time: Date.now(), direction, script, input: text, result });
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    // Фразе и напомене раде и без интернета.
    if (phrases.length) {
      const result = { natural: "", alternatives: [], phrases: phrases.map(({ re, dir, ...rest }) => rest), notes: buildNotes(text, "", direction) };
      renderResult(result, direction);
    }
    setStatus(err.message || String(err), "error");
  } finally {
    state.busy = false;
    $("translateBtn").disabled = false;
    $("translateBtn").textContent = "Преведи";
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Копирано ✓");
}

function init() {
  applyTheme(store.get(STORAGE.theme, "auto"));
  renderDirection();
  updateCount();

  if (ttsAvailable()) {
    pickVoice();
    speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
  }

  $("swapBtn").addEventListener("click", () => {
    state.direction = state.direction === "sr-no" ? "no-sr" : "sr-no";
    store.set(STORAGE.direction, state.direction);
    // Ако постоји превод, пребаци га у поље за унос.
    if (state.lastResult && state.lastResult.result.natural) {
      $("input").value = state.lastResult.result.natural;
      updateCount();
      state.lastResult = null;
      $("result").hidden = true;
    }
    renderDirection();
  });

  document.querySelectorAll('input[name="script"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.script = r.value;
      store.set(STORAGE.script, r.value);
    })
  );

  $("input").addEventListener("input", updateCount);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      translate();
    }
  });
  $("translateBtn").addEventListener("click", translate);
  $("clearBtn").addEventListener("click", () => {
    $("input").value = "";
    updateCount();
    $("result").hidden = true;
    state.lastResult = null;
    setStatus("");
    $("input").focus();
  });
  $("speakInputBtn").addEventListener("click", () => speakNorwegian($("input").value.trim()));

  document.querySelectorAll(".copy-btn").forEach((b) =>
    b.addEventListener("click", () => copyText($(b.dataset.target).textContent))
  );
  document.querySelectorAll(".speak-btn").forEach((b) =>
    b.addEventListener("click", () => speakNorwegian($(b.dataset.target).textContent))
  );

  $("themeBtn").addEventListener("click", () => {
    const next = effectiveDark() ? "light" : "dark";
    store.set(STORAGE.theme, next);
    applyTheme(next);
  });

  $("historyBtn").addEventListener("click", () => {
    renderHistory();
    $("historyDialog").showModal();
  });
  $("closeHistory").addEventListener("click", () => $("historyDialog").close());
  $("clearHistory").addEventListener("click", () => {
    if (!confirm("Обрисати целу историју превода?")) return;
    store.remove(STORAGE.history);
    renderHistory();
  });

  // Брише API кључ ако је остао из претходне верзије апликације.
  store.remove("prevodilac.apiKey");
}

document.addEventListener("DOMContentLoaded", init);
