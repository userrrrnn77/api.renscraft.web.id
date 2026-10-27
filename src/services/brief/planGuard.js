// src/services/brief/planGuard.js
//
// Drop sections that have no data in the brief. Pure, no I/O.
//
// A section is dropped only when its exact component base name matches one of
// the guarded groups AND the brief has no filled slot whose key/label
// (matched whole-word) matches that group's keywords. /App.js and
// /styles.css are never dropped.
//
// References to dropped files are removed from every remaining file's imports,
// and /App.js gets "Render only the components listed in this plan." appended
// to its description.

import path from "node:path";

const GUARDED = [
  {
    names: new Set(["pricing", "plans", "pricingplans"]),
    keywords: ["harga", "price", "pricing", "paket", "tarif"],
  },
  {
    names: new Set(["testimonials", "testimonial", "reviews"]),
    keywords: ["testimoni", "ulasan", "review"],
  },
  {
    names: new Set(["stats", "statistics", "counters", "achievements"]),
    keywords: ["statistik", "angka", "pencapaian"],
  },
  {
    names: new Set(["team", "ourteam"]),
    keywords: ["tim", "team", "anggota"],
  },
];

const norm = (p) => (p.startsWith("/") ? p : `/${p}`);
const baseName = (p) =>
  path.posix
    .basename(norm(p))
    .replace(/\.[^.]+$/, "")
    .toLowerCase();

// A5.4: whole-word matching. Split a slot key + label into lowercase words on
// non-letter boundaries, then check each word against the keyword list. This
// stops "tim" matching "estimasi" and "review" matching "preview".
const wordSplit = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function slotMatchesKeywords(slot, keywords) {
  const words = new Set([...wordSplit(slot.key), ...wordSplit(slot.label)]);
  return keywords.some((kw) => words.has(kw));
}

function hasFilledSlot(brief, keywords) {
  if (!brief) return false;
  const answers = brief.answers ?? {};
  const slots = Array.isArray(brief.slots) ? brief.slots : [];

  for (const slot of slots) {
    const value = answers[slot.key]?.value;
    if (typeof value !== "string" || value.trim() === "") continue;
    if (slotMatchesKeywords(slot, keywords)) return true;
  }

  // Legacy briefs may not have slots[] but still have answers keyed by catalog keys.
  for (const [key, entry] of Object.entries(answers)) {
    const value = entry?.value;
    if (typeof value !== "string" || value.trim() === "") continue;
    const words = new Set(wordSplit(key));
    if (keywords.some((kw) => words.has(kw))) return true;
  }
  return false;
}

function shouldDrop(filePath, brief) {
  const base = baseName(filePath);
  const group = GUARDED.find((g) => g.names.has(base));
  if (!group) return false;
  return !hasFilledSlot(brief, group.keywords);
}

// Resolve a relative import from `fromPath` to a normalized absolute path.
function resolveImport(fromPath, spec) {
  if (!spec.startsWith(".")) return null;
  const dir = path.posix.dirname(norm(fromPath));
  const resolved = path.posix.normalize(path.posix.join(dir, spec));
  return resolved.startsWith("/") ? resolved : `/${resolved}`;
}

function importTargetsDropped(fromPath, spec, droppedSet) {
  const resolved = resolveImport(fromPath, spec);
  if (!resolved) return false;
  if (droppedSet.has(resolved)) return true;
  for (const ext of [".js", ".jsx", ".ts", ".tsx"]) {
    if (droppedSet.has(`${resolved}${ext}`)) return true;
  }
  return false;
}

export function pruneSectionsWithoutData(plan, brief) {
  if (!brief || !plan || !Array.isArray(plan.files)) {
    return { plan, dropped: [] };
  }

  const dropped = [];
  const kept = [];

  for (const file of plan.files) {
    const p = norm(file.path);
    if (p === "/App.js" || p === "/styles.css") {
      kept.push(file);
      continue;
    }
    if (shouldDrop(file.path, brief)) {
      dropped.push(p);
    } else {
      kept.push(file);
    }
  }

  if (dropped.length === 0) {
    return { plan, dropped: [] };
  }

  const droppedSet = new Set(dropped.map(norm));

  const files = kept.map((file) => {
    const p = norm(file.path);
    const imports = (file.imports ?? []).filter(
      (spec) => !importTargetsDropped(p, spec, droppedSet),
    );
    const next = { ...file, imports };
    if (p === "/App.js") {
      const desc = String(next.description ?? "").trim();
      const note = "Render only the components listed in this plan.";
      next.description = desc ? `${desc} ${note}` : note;
    }
    return next;
  });

  return { plan: { ...plan, files }, dropped };
}
