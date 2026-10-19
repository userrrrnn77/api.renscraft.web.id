// src/controllers/briefController.js

import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Brief } from "../models/Brief.js";
import { withUsageTracking } from "../services/usageTracker.js";
import { classifyPrompt } from "../services/brief/classifier.js";
import { briefConfig } from "../services/brief/briefConfig.js";
import { CATEGORY_IDS } from "../services/brief/slotCatalog.js";
import { normalizeAnswer } from "../services/brief/slotValidate.js";
import {
  buildState,
  pickQuestions,
  slotDefsOf,
} from "../services/brief/briefFlow.js";
import { fail } from "../utils/apiError.js";

const MAX_PROMPT_LENGTH = 4000;
const MAX_ANSWER_KEYS = 12;
const NOT_FOUND = "Brief tidak ditemukan atau sudah kedaluwarsa";

const isValidId = (id) => mongoose.isObjectIdOrHexString(id);

async function findOpenBrief(req) {
  const { id } = req.params;
  if (!isValidId(id)) return null;
  return Brief.findOne({ _id: id, owner: req.user.userId, status: "open" });
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

  let result;
  try {
    result = await withUsageTracking("brief", () => classifyPrompt(prompt), {});
  } catch (err) {
    console.warn(
      `[Brief] classifier failed, mode=fallback-brief: ${err?.message ?? err}`,
    );
    // Fallback: bikin brief minimal tapi tetap nanya ke user
    result = {
      category: "lainnya",
      confidence: 0.3,
      slots: [
        {
          key: "brand_name",
          label: "Nama brand / judul",
          question: "Nama website atau brand-nya apa?",
          kind: "text",
          group: "fact",
          placeholder: "Nama Brand",
          options: [],
          origin: "catalog",
          mapsTo: "businessName",
        },
        {
          key: "vibe",
          label: "Gaya tampilan",
          question: "Mau nuansanya gimana?",
          kind: "choice",
          group: "style",
          placeholder: "",
          options: [
            "Modern minimalis",
            "Vintage / hangat",
            "Playful & berwarna",
            "Elegan / mewah",
            "Gelap & techy",
          ],
          origin: "catalog",
          mapsTo: null,
        },
      ],
      answers: {},
    };
  }

  const brief = await Brief.create({
    owner,
    prompt,
    category: result.category,
    confidence: result.confidence,
    answers: result.answers,
    slots: result.slots,
    questionKeys: pickQuestions({
      category: result.category,
      answers: result.answers,
      slots: result.slots,
    }),
  });

  return res.json(buildState(brief.toObject()));
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
      brief.category = body.category;
      if (body.category !== "lainnya") brief.extra = [];

      const keep = new Set(slotDefsOf(brief.toObject()).map((d) => d.key));
      const kept = {};
      for (const [k, v] of Object.entries(brief.answers ?? {})) {
        if (keep.has(k)) kept[k] = v;
      }
      brief.answers = kept;
      brief.markModified("answers");
      brief.questionKeys = pickQuestions(brief.toObject());
    }
  }

  const errors = {};

  if (incoming) {
    const defs = slotDefsOf(brief.toObject());
    const next = { ...(brief.answers ?? {}) };

    for (const [key, val] of Object.entries(incoming)) {
      const def = defs.find((d) => d.key === key);
      if (!def) {
        // error per-slot tetap string bebas; client bisa pilih mau translate
        // atau nggak. Kalau nanti butuh translate, tinggal ubah ke objek
        // { code, params } di sini + di slotValidate.js.
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
