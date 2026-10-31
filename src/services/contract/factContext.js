// src/services/contract/factContext.js
//
// F7: satu sumber kebenaran untuk fakta yang boleh muncul di kode.
// Menggantikan dua blok terpisah: fact guard di ai.js (generate) dan
// chatController.js (revision).
//
// Fakta = nilai yang boleh ditulis model karena muncul di salah satu sumber:
//   1. prompt asli user
//   2. brief answers (kalau ada) + slot placeholders
//   3. reference context (teks dari URL referensi)
//   4. contract.facts (struktur fakta dari planner)
//   5. revision prompt (kalau ini revisi)
//   6. user messages di chat (kalau revisi)
//
// Nilai yang muncul di salah satu sumber dianggap valid.
// Yang tidak muncul di sumber mana pun = karangan model.

import { buildAllowlist } from "./factGuard.js";

/**
 * @param {object} opts
 * @param {string} [opts.prompt]          - prompt asli user (generate) / revision prompt
 * @param {object} [opts.brief]           - snapshot brief (answers + slots)
 * @param {string} [opts.referenceContext] - hasil scraping URL referensi
 * @param {object} [opts.contract]        - contract dari applyContractToPlan (generate only)
 * @param {string} [opts.revisionPrompt]  - prompt revisi (kalau ini revisi)
 * @param {Array<{role:string,content:string}>} [opts.userMessages] - pesan user di chat
 * @returns {{ sources: string[], allow: object, charCount: number }}
 */
export function buildFactContext({
  prompt = "",
  brief = null,
  referenceContext = "",
  contract = null,
  revisionPrompt = "",
  userMessages = [],
} = {}) {
  const sources = [];

  if (typeof prompt === "string" && prompt.trim()) {
    sources.push(prompt);
  }
  if (typeof referenceContext === "string" && referenceContext.trim()) {
    sources.push(referenceContext);
  }
  if (typeof revisionPrompt === "string" && revisionPrompt.trim()) {
    sources.push(revisionPrompt);
  }

  // Brief answers + placeholders (kalau ada). Placeholder penting: kalau
  // model nulis "Alamat belum diisi" (placeholder dari brief), itu bukan
  // karangan — itu placeholder resmi, harus lolos.
  if (brief) {
    const answers = brief.answers ?? {};
    const slots = Array.isArray(brief.slots) ? brief.slots : [];
    for (const slot of slots) {
      const v = answers[slot.key]?.value;
      if (typeof v === "string" && v.trim()) sources.push(v);
      if (typeof slot.placeholder === "string" && slot.placeholder.trim()) {
        sources.push(slot.placeholder);
      }
    }
  }

  // Contract facts (structured: businessName, city, foundedYear, dst).
  if (contract?.facts && typeof contract.facts === "object") {
    for (const v of Object.values(contract.facts)) {
      if (typeof v === "string" && v.trim()) sources.push(v);
    }
  }

  // User messages di chat (untuk konteks revisi — fakta yang udah disebut
  // user di pesan sebelumnya sah kalau dipake lagi di revisi ini).
  for (const m of userMessages) {
    if (
      m?.role === "user" &&
      typeof m.content === "string" &&
      m.content.trim()
    ) {
      sources.push(m.content);
    }
  }

  const allow = buildAllowlist(sources);
  const charCount = sources.join("\n").length;

  return { sources, allow, charCount };
}

/**
 * Diagnostic (buat log). Nggak pernah throw.
 */
export function describeFactContext(ctx) {
  if (!ctx) return "no fact context";
  const a = ctx.allow ?? {};
  return (
    `sources=${ctx.sources.length} chars=${ctx.charCount} ` +
    `phones=${a.phones?.size ?? 0} emails=${a.emails?.size ?? 0} ` +
    `numbers=${a.numbers?.size ?? 0} handles=${a.handles?.size ?? 0} ` +
    `years=${a.years?.size ?? 0}`
  );
}
