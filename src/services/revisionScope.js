// src/services/revisionScope.js
//
// C2: decide which files a revision request may touch. Pure, no I/O.
//
// Mode "files" when the prompt names specific files/sections (base name as a
// word, or a synonym). Mode "all" for global intents ("seluruh", "tema",
// "theme", ...) or when nothing matches.
//
// The chatController uses this to build a scoped `relevantFiles`, to append
// "Only files shown in full are in scope. Do not edit the others." to the
// prompt, and to drop out-of-scope update/delete operations after the model
// answers.

const GLOBAL_INTENTS = [
  "seluruh",
  "semua",
  "all pages",
  "tema",
  "theme",
  "dark mode",
  "font",
  "warna utama",
  "redesign",
];

const SYNONYM_GROUPS = [
  ["hero", "home", "beranda", "banner"],
  ["about", "tentang"],
  ["contact", "kontak", "hubungi", "lokasi"],
  ["menu", "produk", "products"],
  ["services", "layanan"],
  ["gallery", "galeri", "portfolio", "projects"],
  ["testimonials", "testimoni"],
  ["pricing", "harga", "paket"],
  ["header", "navbar", "navigasi"],
  ["footer"],
];

const APP_SECTION_HINTS = /\b(tambah\w*|hapus\w*|urutan|add|remove|reorder)\b/i;
const STYLE_HINTS = /\b(animasi|animation|css|keyframe|font)\b/i;

const wordsOf = (prompt) =>
  String(prompt)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const baseNameOf = (p) => {
  const base = String(p).split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "");
};

const camelWords = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export function resolveScope(prompt, paths) {
  const list = Array.from(paths || []);
  const words = new Set(wordsOf(prompt));
  const lower = String(prompt).toLowerCase();

  const globalRe = new RegExp(
    `\\b(?:${GLOBAL_INTENTS.map((i) => i.replace(/\s+/g, "\\s+")).join("|")})\\b`,
    "i",
  );
  if (globalRe.test(prompt)) {
    const intent = GLOBAL_INTENTS.find((i) =>
      new RegExp(`\\b${i.replace(/\s+/g, "\\s+")}\\b`, "i").test(prompt),
    );
    return { mode: "all", files: new Set(list), reason: `global:${intent}` };
  }
  
  const matches = new Set();

  for (const p of list) {
    const base = baseNameOf(p);
    if (camelWords(base).some((w) => words.has(w))) {
      matches.add(p);
      continue;
    }
    const baseLower = base.toLowerCase();
    const group = SYNONYM_GROUPS.find((g) => g.includes(baseLower));
    if (group && group.some((w) => words.has(w))) {
      matches.add(p);
    }
  }

  if (matches.size === 0) {
    return { mode: "all", files: new Set(list), reason: "no-match" };
  }

  if (APP_SECTION_HINTS.test(prompt) && list.includes("/App.js")) {
    matches.add("/App.js");
  }
  if (STYLE_HINTS.test(prompt) && list.includes("/styles.css")) {
    matches.add("/styles.css");
  }

  return { mode: "files", files: matches, reason: "matched" };
}
