// src/controllers/briefController.js

import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Brief } from "../models/Brief.js";
import { withUsageTracking } from "../services/usageTracker.js";
import { classifyPrompt } from "../services/brief/classifier.js";
import { briefConfig } from "../services/brief/briefConfig.js";
import {
  CATEGORY_IDS,
  categorySlots,
  EXTRA_KINDS,
} from "../services/brief/slotCatalog.js";
import { normalizeAnswer } from "../services/brief/slotValidate.js";
import {
  buildState,
  pickQuestions,
  slotDefsOf,
} from "../services/brief/briefFlow.js";
import { fail } from "../utils/apiError.js";
import { guessCategory } from "../services/brief/categoryGuess.js";

// ── R3: Safety net coverage check ──────────────────────────────────────────
// Composer LLM bisa bandel nambah x_* (nice-to-have) yang gak kejawab,
// padahal must-have udah ke-extract dari prompt. Coverage check memastikan
// prompt lengkap tetap auto-start walaupun composer kurang patuh.
function shouldSkipWizard(slots = [], answers = {}) {
  const facts = (slots ?? []).filter((s) => s.group === "fact");
  if (facts.length === 0) return true;

  const answered = facts.filter((s) => answers[s.key]?.value);
  // ≥ 60% fakta kejawab dari prompt → cukup, langsung generate
  if (answered.length / facts.length >= 0.6) return true;

  // Sisa pertanyaan SEMUA nice-to-have (x_* tanpa mapsTo) → skip juga
  const open = facts.filter((s) => !answers[s.key]?.value);
  return open.every((s) => s.key.startsWith("x_") && !s.mapsTo);
}

// Wrapper: coverage check dulu, baru pickQuestions kalau memang perlu wizard.
// Dipakai di semua call site (create awal, background success, background
// fallback, category change) supaya perilakunya konsisten.
function pickQuestionsSafe({ category, answers, slots }) {
  if (shouldSkipWizard(slots, answers)) return [];
  return pickQuestions({ category, answers, slots });
}

const MAX_PROMPT_LENGTH = 4000;
const MAX_ANSWER_KEYS = 12;
const MAX_EXTRA_SLOTS = 8;
const MAX_EXTRA_PER_REQUEST = 3;
const EXTRA_LABEL_MIN = 2;
const EXTRA_LABEL_MAX = 60;
const NOT_FOUND = "Brief tidak ditemukan atau sudah kedaluwarsa";

const isValidId = (id) => mongoose.isObjectIdOrHexString(id);

async function findOpenBrief(req) {
  const { id } = req.params;
  if (!isValidId(id)) return null;
  return Brief.findOne({
    _id: id,
    owner: req.user.userId,
    status: { $in: ["classifying", "open"] },
  });
}

// Slug key untuk slot custom (x_<label>). Unik dijamin pemanggil via usedKeys.
const slugKey = (label) => {
  const base = String(label)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return base ? `x_${base}` : "x_field";
};

// SlotDef bentuk lengkap dari catalog category. Dipakai saat fallback classifier
// dan saat category berubah — supaya origin & mapsTo konsisten di dua tempat.
const buildCatalogSlotDef = (s) => ({
  key: s.key,
  label: s.label,
  question: s.question,
  kind: s.kind,
  group: s.group ?? "fact",
  placeholder: s.placeholder ?? "",
  options: s.options ? [...s.options] : [],
  origin: "catalog",
  mapsTo:
    s.key === "brand_name"
      ? "businessName"
      : s.key === "whatsapp" || s.key === "rsvp"
        ? "phone"
        : s.key === "address"
          ? "address"
          : s.key === "email"
            ? "email"
            : s.key === "jam_buka"
              ? "openingHours"
              : null,
});

// Fallback kalau classifier gagal / belum selesai: tebak dari kata kunci dulu.
const fallbackResult = (prompt = "") => {
  const guess = guessCategory(prompt);
  // app_tool/dashboard tidak punya slot -> biar classifier yang memutuskan
  const category = guess && categorySlots(guess).length > 0 ? guess : "lainnya";
  return {
    category,
    confidence: 0.3,
    slots: categorySlots(category).map(buildCatalogSlotDef),
    answers: {},
  };
};

// Jalan di background: client sudah dibalas "classifying" dan polling.
async function classifyInBackground(briefId, prompt) {
  let result;
  try {
    result = await withUsageTracking("brief", () => classifyPrompt(prompt), {
      briefId: briefId.toString(),
    });
    console.log(`[Brief] classify done ${briefId} -> ${result.category}`);
  } catch (err) {
    console.warn(
      `[Brief] classifier failed for ${briefId}, fallback: ${err?.message ?? err}`,
    );
    result = fallbackResult();
  }

  try {
    await Brief.findByIdAndUpdate(briefId, {
      category: result.category,
      confidence: result.confidence,
      answers: result.answers,
      slots: result.slots,
      questionKeys: pickQuestionsSafe(result),
      status: "open",
    });
    console.log(`[Brief] saved ${briefId}`);
  } catch (err) {
    // Tetap "classifying": TTL index yang bersihin.
    console.error(
      `[Brief] update failed for ${briefId}: ${err?.message ?? err}`,
    );
  }
}

// POST /api/briefs
export const createBrief = asyncHandler(async (req, res) => {
  const prompt =
    typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    return fail(res, 400, "BRIEF_PROMPT_REQUIRED", {}, "Prompt wajib diisi");
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return fail(
      res,
      400,
      "BRIEF_PROMPT_TOO_LONG",
      { max: MAX_PROMPT_LENGTH },
      `Prompt maksimal ${MAX_PROMPT_LENGTH} karakter`,
    );
  }

  const owner = req.user.userId;
  console.log("[Brief] create start", { owner, len: prompt.length });

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await Brief.countDocuments({
    owner,
    createdAt: { $gte: since },
  });
  if (recent >= briefConfig().maxPerHour) {
    return fail(
      res,
      429,
      "BRIEF_TOO_MANY_ATTEMPTS",
      { max: briefConfig().maxPerHour },
      "Terlalu banyak percobaan. Coba lagi nanti.",
    );
  }

  // Brief awal (tanpa AI), status "classifying"
  const fallback = fallbackResult();
  const brief = await Brief.create({
    owner,
    prompt,
    category: fallback.category,
    confidence: fallback.confidence,
    answers: fallback.answers,
    slots: fallback.slots,
    questionKeys: pickQuestionsSafe(fallback),
    status: "classifying",
  });

  // Classifier jalan sekali, di background. Tidak di-await.
  void classifyInBackground(brief._id, prompt);

  return res.json({
    ...buildState(brief.toObject()),
    briefId: brief._id,
    status: "classifying",
  });
});

// GET /api/briefs/:id
export const getBrief = asyncHandler(async (req, res) => {
  const brief = await findOpenBrief(req);
  if (!brief) {
    return fail(res, 404, "BRIEF_NOT_FOUND", {}, NOT_FOUND);
  }
  return res.json(buildState(brief.toObject()));
});

// PATCH /api/briefs/:id
export const patchBrief = asyncHandler(async (req, res) => {
  const brief = await findOpenBrief(req);
  if (!brief) {
    return fail(res, 404, "BRIEF_NOT_FOUND", {}, NOT_FOUND);
  }

  const body = req.body ?? {};
  const incoming = body.answers;

  if (incoming !== undefined) {
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return fail(
        res,
        400,
        "BRIEF_ANSWERS_INVALID",
        {},
        "answers harus berupa objek",
      );
    }
    if (Object.keys(incoming).length > MAX_ANSWER_KEYS) {
      return fail(
        res,
        400,
        "BRIEF_TOO_MANY_ANSWERS",
        { max: MAX_ANSWER_KEYS },
        `answers maksimal ${MAX_ANSWER_KEYS} key`,
      );
    }
  }

  // ─── 1. Category change ────────────────────────────────────────────────
  //
  // Rebuild composer slots untuk kategori baru, PERTAHANKAN user slots.
  // Composer slots lama (origin "catalog" / "ai") di kategori lama sudah nggak
  // relevan, jadi dibuang. User slots menang kalau key-nya bentrok dengan
  // catalog baru (biar user bisa override label).
  if (body.category !== undefined) {
    if (typeof body.category !== "string" || !CATEGORY_IDS.has(body.category)) {
      return fail(
        res,
        400,
        "BRIEF_UNKNOWN_CATEGORY",
        {},
        "Kategori tidak dikenal",
      );
    }
    if (body.category !== brief.category) {
      const userSlots = (brief.slots ?? []).filter((s) => s.origin === "user");
      brief.category = body.category;

      const catalogDefs = categorySlots(body.category).map(buildCatalogSlotDef);
      const userKeys = new Set(userSlots.map((s) => s.key));
      brief.slots = [
        ...catalogDefs.filter((s) => !userKeys.has(s.key)),
        ...userSlots,
      ];

      const keep = new Set(slotDefsOf(brief.toObject()).map((d) => d.key));
      const kept = {};
      for (const [k, v] of Object.entries(brief.answers ?? {})) {
        if (keep.has(k)) kept[k] = v;
      }
      brief.answers = kept;
      brief.markModified("answers");
      brief.markModified("slots");
      brief.questionKeys = pickQuestionsSafe(brief.toObject());
    }
  }

  const errors = {};

  // ─── 2. Tambah slot custom (extraSlots) ────────────────────────────────
  //
  // Prinsip: KALAU ADA SATU SAJA item yang invalid, tidak ada yang di-assign
  // ke `brief`. Semua build di local variable dulu (`newDefs`, `nextAnswers`),
  // assign setelah semua valid.
  const extra = body.extraSlots;
  if (extra !== undefined) {
    if (!Array.isArray(extra) || extra.length === 0) {
      return fail(
        res,
        400,
        "BRIEF_EXTRA_SLOTS_INVALID",
        {},
        "extraSlots harus array tidak kosong",
      );
    }
    if (extra.length > MAX_EXTRA_PER_REQUEST) {
      return fail(
        res,
        400,
        "BRIEF_TOO_MANY_EXTRA_SLOTS",
        { max: MAX_EXTRA_PER_REQUEST },
        `Maks ${MAX_EXTRA_PER_REQUEST} slot per request`,
      );
    }

    const existingExtra = (brief.slots ?? []).filter(
      (s) => s.origin === "user",
    ).length;
    if (existingExtra + extra.length > MAX_EXTRA_SLOTS) {
      return fail(
        res,
        400,
        "BRIEF_TOO_MANY_EXTRA_SLOTS",
        { max: MAX_EXTRA_SLOTS },
        `Maks ${MAX_EXTRA_SLOTS} slot tambahan`,
      );
    }

    const usedKeys = new Set([
      ...(brief.slots ?? []).map((s) => s.key),
      ...Object.keys(brief.answers ?? {}),
    ]);
    const nextAnswers = { ...(brief.answers ?? {}) };
    const newDefs = [];

    for (const item of extra) {
      const label = String(item?.label ?? "").trim();
      const kind = item?.kind ?? "text";
      const rawValue = item?.value ?? "";

      if (label.length < EXTRA_LABEL_MIN || label.length > EXTRA_LABEL_MAX) {
        return fail(
          res,
          400,
          "BRIEF_EXTRA_SLOT_LABEL_INVALID",
          { min: EXTRA_LABEL_MIN, max: EXTRA_LABEL_MAX },
          "Label tidak valid",
        );
      }
      if (!EXTRA_KINDS.includes(kind)) {
        return fail(
          res,
          400,
          "BRIEF_EXTRA_SLOT_KIND_INVALID",
          {},
          "Kind tidak didukung",
        );
      }

      let key = slugKey(label);
      let n = 2;
      while (usedKeys.has(key)) key = `${slugKey(label).slice(0, 26)}_${n++}`;
      usedKeys.add(key);

      const slotDef = {
        key,
        label,
        question: label,
        kind,
        group: "fact",
        placeholder: `${label} belum diisi`,
        options: [],
        origin: "user",
        mapsTo: null,
      };

      const norm = normalizeAnswer(slotDef, String(rawValue));
      if (!norm.ok) {
        return fail(
          res,
          400,
          "BRIEF_EXTRA_SLOT_VALUE_INVALID",
          { label, detail: norm.error },
          `Nilai "${label}" tidak valid`,
        );
      }

      newDefs.push(slotDef);
      nextAnswers[key] = { value: norm.value, source: "user" };
    }

    // Assign sekali, setelah semua valid. Insert sebelum vibe kalau ada.
    const baseSlots = brief.slots ?? [];
    const vibeIdx = baseSlots.findIndex(
      (s) => s.key === "vibe" || s.group === "style",
    );
    brief.slots =
      vibeIdx === -1
        ? [...baseSlots, ...newDefs]
        : [
            ...baseSlots.slice(0, vibeIdx),
            ...newDefs,
            ...baseSlots.slice(vibeIdx),
          ];
    brief.answers = nextAnswers;
    brief.markModified("answers");
    brief.markModified("slots");
  }

  // ─── 3. Hapus slot custom (removeExtraSlots) ───────────────────────────
  const remove = body.removeExtraSlots;
  if (Array.isArray(remove) && remove.length > 0) {
    brief.slots = (brief.slots ?? []).filter(
      (s) => !(s.origin === "user" && remove.includes(s.key)),
    );
    const answers = { ...(brief.answers ?? {}) };
    for (const k of remove) delete answers[k];
    brief.answers = answers;
    brief.markModified("answers");
    brief.markModified("slots");
  }

  // ─── 4. Jawaban wizard (answers) ───────────────────────────────────────
  if (incoming) {
    const defs = slotDefsOf(brief.toObject());
    const next = { ...(brief.answers ?? {}) };

    for (const [key, val] of Object.entries(incoming)) {
      const def = defs.find((d) => d.key === key);
      if (!def) {
        errors[key] = "Slot tidak dikenal";
        continue;
      }
      if (val === null) {
        next[key] = { value: null, source: "skipped" };
        continue;
      }
      const norm = normalizeAnswer(def, val);
      if (!norm.ok) {
        errors[key] = norm.error;
        continue;
      }
      next[key] = { value: norm.value, source: "user" };
    }

    brief.answers = next;
    brief.markModified("answers");
  }

  await brief.save();
  return res.json({ ...buildState(brief.toObject()), errors });
});
