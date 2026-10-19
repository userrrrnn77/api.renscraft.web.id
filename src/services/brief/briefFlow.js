// services/brief/briefFlow.js
//
// Layer 2: pemilihan pertanyaan + bentuk state untuk API. Tanpa LLM, tanpa I/O.
//
// Sumber slot untuk brief baru = brief.slots (hasil composer).
// Fallback untuk brief lama (sebelum migration) = categorySlots(category).
import {
  CATEGORIES,
  MAX_QUESTIONS,
  categorySlots,
  getCategory,
} from "./slotCatalog.js";

export const ALWAYS_ASK_STYLE = true;

// Brief.slots bisa kosong (brief lama / sebelum migration). Fallback ke katalog.
export const slotDefsOf = (brief) =>
  Array.isArray(brief.slots) && brief.slots.length > 0
    ? brief.slots
    : categorySlots(brief.category, brief.extra ?? []);

export function pickQuestions(brief) {
  const answers = brief.answers ?? {};
  const defs = slotDefsOf(brief);
  const open = defs.filter((d) => !Object.hasOwn(answers, d.key));

  if (open.length === 0) return [];

  // vibe selalu dapat jatah terakhir (biar selalu ditanya kalau kosong).
  const styleSlot = ALWAYS_ASK_STYLE
    ? open.find((d) => d.key === "vibe" || d.group === "style")
    : null;
  const facts = open.filter((d) => d !== styleSlot);

  const keys = facts
    .slice(0, styleSlot ? MAX_QUESTIONS - 1 : MAX_QUESTIONS)
    .map((d) => d.key);
  if (styleSlot) keys.push(styleSlot.key);
  return keys;
}

const categoryList = () => CATEGORIES.map((c) => ({ id: c.id, label: c.label }));

export function buildState(brief) {
  const cat = getCategory(brief.category);
  const answers = brief.answers ?? {};
  const questionKeys = Array.isArray(brief.questionKeys)
    ? [...brief.questionKeys]
    : [];
  const defs = slotDefsOf(brief);

  const slots = defs.map((d) => {
    const entry = answers[d.key] ?? null;
    return {
      key: d.key,
      label: d.label,
      question: d.question,
      kind: d.kind,
      group: d.group,
      options: d.options ?? null,
      placeholder: d.placeholder ?? "",
      value: entry?.value ?? null,
      source: entry?.source ?? null,
      skipped: entry?.source === "skipped",
    };
  });

  return {
    briefId: String(brief._id),
    mode: questionKeys.length > 0 ? "wizard" : "ready",
    autoStart: defs.length === 0,
    category: { id: cat.id, label: cat.label },
    sampleData: cat.sampleData === true,
    slots,
    questionKeys,
    categories: categoryList(),
  };
}

export function toSnapshot(brief) {
  const cat = getCategory(brief.category);
  return {
    category: cat.id,
    sampleData: cat.sampleData === true,
    answers: JSON.parse(JSON.stringify(brief.answers ?? {})),
    slots: (brief.slots ?? []).map((s) => ({
      key: s.key,
      label: s.label,
      question: s.question,
      kind: s.kind,
      group: s.group,
      placeholder: s.placeholder ?? "",
      options: s.options ?? [],
      origin: s.origin ?? "ai",
      mapsTo: s.mapsTo ?? null,
    })),
  };
}