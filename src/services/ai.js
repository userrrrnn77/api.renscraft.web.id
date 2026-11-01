// FILE: src/services/ai.js

import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import pMap from "p-map";
import {
  recordUsage,
  assertBudgetNow,
  getBudgetSummary,
} from "./usageTracker.js";
import { getGlobalSemaphore } from "./semaphore.js";
import {
  FilePlanSchema,
  RevisionResultSchema,
  ImageReconcileSchema,
} from "./aiSchemas.js";
import {
  buildFileCodeSystem,
  buildFilePlanSystem,
  buildReviseSystem,
} from "./prompts.js";
import { normalizeContent } from "./contentNormalizer.js";
import {
  findSyntaxError,
  validateAndFixCode,
  validateRevisionContent,
} from "./codeValidator.js";
import {
  applyAssetTokens,
  buildReferenceContext,
  createUrlShield,
  labelIsUseful,
} from "./webReference.js";
import { mirrorImages } from "./assetMirror.js";
import { fixUnresolvedImports } from "./importGuard.js";
import { fixOffTopicImages } from "./imageGuard.js";
import {
  applyContractToPlan,
  renderContractPrompt,
  parseExports,
} from "./contract/projectContract.js";
import { checkContract } from "./contract/contractChecker.js";
import { fixStylesheets } from "./contract/cssFix.js";
import { finalizeProject } from "./finalize.js";
import { runQualityGate } from "./qa/qualityGate.js";
import { buildBriefBlock, mergeBriefFacts } from "./brief/briefContext.js";
import { pruneSectionsWithoutData } from "./brief/planGuard.js";
import { buildAllowlist, findInventedFacts } from "./contract/factGuard.js";
import {
  wantsImages,
  ImageGroupsSchema,
  IMAGE_GROUPS_SYSTEM,
  buildImageGroupsPrompt,
  fetchItemPhotos,
  triggerDownloads,
} from "./stockImages.js";
import { buildFactContext } from "./contract/factContext.js";
import { injectDesignTokens } from "./contract/designTokens.js";
import { designFromBrief } from "./brief/vibePresets.js";

// Update juga AI_PRICE_IN_PER_M / AI_PRICE_OUT_PER_M biar tracker biaya akurat.
const MODEL = process.env.AI_MODEL || "deepseek-v4.1-flash";
const MAX_CONCURRENCY = parseInt(process.env.AI_MAX_CONCURRENCY || "6", 10);
// Without an explicit limit the provider falls back to a small default, which
// cuts files off mid-way (~4096 chars) and leaves unclosed brackets in the CSS.
const MAX_OUTPUT_TOKENS = parseInt(
  process.env.AI_MAX_OUTPUT_TOKENS || "16000",
  10,
);

// B1: retry feedback + trimmed retry context. Default on; set 0 to disable.
const RETRY_FEEDBACK = process.env.HARNESS_RETRY_FEEDBACK !== "0";

// B1 caps: each retry context file is truncated to 4000 chars, total 16000.
const RETRY_FILE_CHAR_CAP = 4000;
const RETRY_TOTAL_CHAR_CAP = 16000;

// C1: max files regenerated per generation when invented facts are found.
const FACT_GUARD_MAX_FILES = Math.max(
  0,
  parseInt(process.env.FACT_GUARD_MAX_FILES || "3", 10) || 3,
);

const provider = createOpenAI({
  baseURL: process.env.AI_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.AI_API_KEY,
});

export const model =
  process.env.AI_USE_CHAT_API === "1" ? provider.chat(MODEL) : provider(MODEL);

// C3: optional fast model, built exactly like `model` (same provider). Falls
// back to `model` when the env is unset, so behaviour is identical when the
// new env vars are not configured.
const FAST_MODEL = String(process.env.AI_MODEL_FAST ?? "").trim() || null;
export const FAST_MODEL_NAME = FAST_MODEL;
export const fastModel = FAST_MODEL
  ? process.env.AI_USE_CHAT_API === "1"
    ? provider.chat(FAST_MODEL)
    : provider(FAST_MODEL)
  : model;

// C3: plan only goes to the fast model when AI_FAST_FOR_PLAN=1.
const FAST_FOR_PLAN = process.env.AI_FAST_FOR_PLAN === "1";
const PLAN_MODEL = FAST_FOR_PLAN ? fastModel : model;
const PLAN_MODEL_NAME = FAST_FOR_PLAN ? FAST_MODEL_NAME : null;

// A1: one line per LLM call, never containing prompt text or brief values.
function logContext(label, info = {}) {
  const parts = [];
  if (Array.isArray(info.layers) && info.layers.length > 0) {
    parts.push(`layers=${info.layers.join(",")}`);
  }
  if (info.files) parts.push(`files=${info.files}`);
  if (info.history) parts.push(`history=${info.history}`);
  if (info.refs) parts.push(`refs=${info.refs}`);
  if (info.hasBrief) parts.push(`brief=1`);
  console.log(`[Context] ${label} ${parts.join(" ")}`);
}

// F4: bungkus SEMUA panggilan LLM dengan semaphore global + cek budget.
// Kalau assertBudgetNow throw (enforce mode), panggilan nggak pernah terjadi.
async function withSlot(label, fn) {
  const sem = getGlobalSemaphore();
  const release = await sem.acquire();
  try {
    assertBudgetNow(label);
    return await fn();
  } finally {
    release();
  }
}

// A2 / A5.1: precedence note, added only when a brief block exists.
const REVISION_PRECEDENCE_NOTE =
  "The revision request below is the newest instruction. If it gives new data (phone, address, price, name, hours) use it, it replaces the brief value. If it asks for a section whose data is not in the brief, create it with skeleton placeholder cards following the brief placeholder rules, never invented names, prices, ratings, quotes or numbers, and say in description that the content is a placeholder. Style is different: the existing files show the current look, so keep that look unless the revision request asks to change it. If it does (colors, mood, dark or light, a different style), follow the request; the brief's Arahan gaya then no longer applies to the parts you change.";

// Ambil JSON dari balasan model walaupun dia bungkus dengan ``` atau nambah teks.
function extractJson(raw) {
  let s = String(raw ?? "").trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // buang code fence kalau ada
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // ambil dari '{' pertama sampai '}' terakhir (handle kalau ada preamble)
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) {
    throw new Error("model did not return a JSON object");
  }
  return JSON.parse(s.slice(first, last + 1));
}

// generateObject + usage tracking. A reply that fails schema validation still
// cost tokens, and the SDK puts them on the error, so record those too.
// B3: also returns the raw reply text, so callers can log/inspect it.
// C3: `modelName` is the env var value used for per-model pricing (optional).
export async function generateObjectTracked(label, args) {
  const {
    model,
    modelName,
    schema,
    system,
    prompt,
    abortSignal,
    maxRetries = 2,
  } = args;

  const JSON_RULE =
    "\n\n---\nOUTPUT FORMAT (WAJIB):\n" +
    "Balas HANYA dengan satu objek JSON yang valid dan lengkap.\n" +
    "JANGAN tambahkan penjelasan, JANGAN bungkus dengan ```, " +
    "JANGAN tulis teks apa pun di luar JSON. " +
    'Semua string pakai kutip ganda (") dan escape yang benar.';

  const isRetryableUpstream = (err) => {
    const status = err?.statusCode ?? err?.response?.status;
    if (status >= 500 && status < 600) return true;
    if (err?.cause?.code === "ECONNRESET") return true;
    if (err?.cause?.code === "ETIMEDOUT") return true;
    if (
      typeof err?.message === "string" &&
      /fetch failed|Bad Gateway|Service Unavailable|socket hang up/i.test(
        err.message,
      )
    ) {
      return true;
    }
    return false;
  };

  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const finalPrompt = lastError
      ? `${prompt}\n\nPERCOBAAN SEBELUMNYA GAGAL: ${lastError}\nKembalikan HANYA JSON valid sesuai skema.`
      : prompt;

    try {
      const result = await withSlot(label, () =>
        generateText({
          model,
          system: system + JSON_RULE,
          prompt: finalPrompt,
          abortSignal,
        }),
      );

      recordUsage(label, result.usage, modelName ?? null);

      try {
        const object = schema.parse(extractJson(result.text));
        return { object, usage: result.usage, text: result.text };
      } catch (err) {
        lastError = (err?.message ?? String(err)).slice(0, 300);
        console.warn(
          `[AI] ${label} attempt ${attempt + 1} invalid JSON: ${lastError}`,
        );
        if (attempt >= maxRetries) throw err;
      }
    } catch (err) {
      const retryable = isRetryableUpstream(err);

      if (!retryable || attempt >= maxRetries) throw err;

      const delayMs = 3000 * Math.pow(2, attempt);
      console.warn(
        `[AI] ${label} attempt ${attempt + 1} upstream error (${err.statusCode || err.cause?.code || "network"}): ` +
          `${(err.message || String(err)).slice(0, 200)} — retrying in ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// A real file (component / stylesheet) is never this small. Tiny outputs mean
// the model returned a stub, so treat them as failures and let the retry run.
const MIN_CODE_LENGTH = 150;

// Pull the raw source code out of the model's reply.
function extractCode(raw) {
  let text = String(raw || "");

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");

  // Reasoning models sometimes leak their thinking into the answer
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // The model ignored the "raw code" instruction and answered with {"code": "..."}
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.code === "string") {
        return normalizeContent(obj.code);
      }
    } catch {
      // not JSON, treat it as code
    }
  }

  // Prose followed by a fenced block: keep only the block
  const fenceIdx = text.indexOf("```");
  if (fenceIdx !== -1 && fenceIdx < 500) {
    const fenced = text.match(/```[\w-]*\n([\s\S]*?)\n```/);
    if (fenced) return fenced[1];
  }

  return text;
}

// B1: resolve a relative import from a plan file, trying the usual extensions.
function resolveRelativeImport(fromPath, spec, allFiles) {
  if (!spec.startsWith(".")) return null;
  const dir = path.posix.dirname(
    fromPath.startsWith("/") ? fromPath : `/${fromPath}`,
  );
  let resolved = path.posix.normalize(path.posix.join(dir, spec));
  if (!resolved.startsWith("/")) resolved = `/${resolved}`;

  const planned = new Set(
    allFiles.map((f) => (f.path.startsWith("/") ? f.path : `/${f.path}`)),
  );
  if (planned.has(resolved)) return resolved;
  for (const ext of [".js", ".jsx", ".ts", ".tsx"]) {
    if (planned.has(`${resolved}${ext}`)) return `${resolved}${ext}`;
  }
  for (const ext of [".js", ".jsx"]) {
    if (planned.has(`${resolved}/index${ext}`))
      return `${resolved}/index${ext}`;
  }
  return null;
}

// B1: build the trimmed retry context. Server-owned files are always in.
// Files this file imports are truncated to RETRY_FILE_CHAR_CAP. Everything
// stops at RETRY_TOTAL_CHAR_CAP.
function contextFilesFor(file, plan, files, serverOwnedPaths) {
  const result = {};
  const planned = plan.files || [];

  for (const p of serverOwnedPaths) {
    if (files[p] !== undefined) result[p] = files[p];
  }
  for (const spec of file.imports ?? []) {
    const resolved = resolveRelativeImport(file.path, spec, planned);
    if (resolved && files[resolved] !== undefined && !result[resolved]) {
      result[resolved] = files[resolved];
    }
  }

  const out = {};
  let total = 0;
  for (const [p, code] of Object.entries(result)) {
    if (total >= RETRY_TOTAL_CHAR_CAP) break;
    const budget = Math.min(RETRY_FILE_CHAR_CAP, RETRY_TOTAL_CHAR_CAP - total);
    const str = String(code);
    const slice = str.length > budget ? str.slice(0, budget) : str;
    out[p] = slice;
    total += slice.length;
  }
  return out;
}

// Generate a single file's code.
async function generateSingleFile(
  file,
  allFiles,
  prompt,
  alreadyGeneratedFiles,
  assets = [],
  contract = null,
  hasBrief = false,
  dataSpec = null,
) {
  const system = buildFileCodeSystem(
    allFiles,
    alreadyGeneratedFiles,
    contract ? renderContractPrompt(contract, file.path) : "",
    { hasBrief },
  );

  const plannedList = allFiles.map((f) => f.path).join(", ");

  let dataSpecInstruction = "";
  if (dataSpec && dataSpec.collections && dataSpec.collections.length > 0) {
    const schemaRules = dataSpec.collections
      .map((c) => {
        const fieldKeys = c.fields.map((f) => f.key).join(", ");
        return `- Collection "${c.name}": Use EXACTLY these field keys: [${fieldKeys}]`;
      })
      .join("\n");

    dataSpecInstruction = `\n\nIMPORTANT DATABASE RULES:
When using \`db.collection(...).create(...)\` from '/lib/renscraft.js':
1. Use EXACT collection names.
2. Use EXACT field keys. Do NOT invent new keys. If the schema uses Indonesian (e.g., 'nama', 'pesan'), you MUST use that exact string in the payload object.
Schema:
${schemaRules}
`;
  }

  let userMsg = `Project: ${prompt}\n\nWrite the complete code for: ${file.path}\nPurpose: ${file.description}\n\nImport rule: the only local files that exist are: ${plannedList}. Never import any other local file. Style with Tailwind classes and the global /styles.css.${dataSpecInstruction}\n\nReturn ONLY the raw source code of this file.`;

  if (RETRY_FEEDBACK && file.lastError) {
    const last = String(file.lastError).slice(0, 300);
    userMsg += `\n\nPrevious attempt was rejected: ${last}. Fix exactly that and keep everything else.`;
    if (/cut off/i.test(last)) {
      userMsg +=
        " Write it more compactly: fewer decorative elements, no unused code.";
    }
  }

  logContext(`file ${file.path}`, {
    layers: ["concept", "brief", "contract", "refs"],
    files: `${Object.keys(alreadyGeneratedFiles).length}/${allFiles.length}`,
    refs: assets.length,
    hasBrief,
  });

  console.log(`[AI] Creating file: ${file.path}...`);
  const { text, finishReason, usage } = await withSlot(
    `file ${file.path}`,
    () =>
      generateText({
        model,
        system,
        prompt: userMsg,
        maxRetries: 2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }),
  );

  recordUsage(`file ${file.path}`, usage);

  if (finishReason === "length") {
    throw new Error(
      `Output for ${file.path} was cut off (hit ${MAX_OUTPUT_TOKENS} output tokens)`,
    );
  }

  let code = extractCode(text);
  code = applyAssetTokens(code, assets);

  if (!assets.length) {
    const img = fixOffTopicImages(code, { prompt, filePath: file.path });
    code = img.code;
    if (img.swapped.length) {
      console.log(
        `[ImageGuard] ${file.path}: ${img.swapped.length} off-topic photo(s) swapped\n  - ${img.swapped.join("\n  - ")}`,
      );
    }
  }

  if (code.trim().length === 0) {
    throw new Error("Generated code is empty");
  }

  if (finishReason && finishReason !== "stop") {
    console.warn(
      `[AI] ${file.path}: finishReason=${finishReason} (${code.length} chars), output may be cut off`,
    );
  }

  if (code.trim().length < MIN_CODE_LENGTH) {
    throw new Error(
      `Generated code for ${file.path} is too short (${code.trim().length} chars, finishReason=${finishReason})`,
    );
  }

  const validation = validateAndFixCode(code, file.path, {
    allPlannedFiles: allFiles,
  });
  code = validation.code;

  if (validation.warnings.length > 0) {
    console.log(
      `[Validator] Code adjustments for ${file.path}:\n  - ${validation.warnings.join("\n  - ")}`,
    );
  }

  if (/\.(jsx?|tsx?)$/i.test(file.path)) {
    const importCheck = fixUnresolvedImports(
      code,
      file.path,
      allFiles.map((f) => f.path),
    );
    code = importCheck.code;
    if (importCheck.warnings.length > 0) {
      console.log(
        `[ImportGuard] ${file.path}:\n  - ${importCheck.warnings.join("\n  - ")}`,
      );
    }
    if (importCheck.missing.length > 0) {
      throw new Error(
        `Generated code for ${file.path} imports files that are not in the project: ${importCheck.missing.join(", ")}`,
      );
    }
  }

  const syntaxError = findSyntaxError(code, file.path);
  if (syntaxError) {
    const pos = /\((\d+):(\d+)\)/.exec(syntaxError);
    if (pos) {
      const badLine = code.split("\n")[Number(pos[1]) - 1] ?? "";
      console.warn(
        `[AI] ${file.path} syntax error at ${pos[1]}:${pos[2]} -> ${badLine.trim().slice(0, 300)}`,
      );
    }
    throw new Error(
      `Generated code for ${file.path} has a syntax error: ${syntaxError.slice(0, 200)}`,
    );
  }
  console.log(`[AI] Created file: ${file.path} (${code.length} chars)`);
  return { path: file.path, code };
}

// ── Reconcile uploaded images by label ──────────────────────────────────────
async function reconcileUploadedImages(files, uploadedImages) {
  if (!Array.isArray(uploadedImages) || uploadedImages.length < 2) return files;

  // Kumpulkan upload yang labelnya berguna (bukan IMG_2024.jpg dst)
  const labeled = [];
  for (let i = 0; i < uploadedImages.length; i++) {
    const img = uploadedImages[i];
    const label = (img?.name || "").replace(/\.[^.]+$/, "").trim();
    if (!img?.url || !label || !labelIsUseful(label)) continue;
    labeled.push({
      token: `ref-img-${String(i + 1).padStart(2, "0")}`,
      label,
      url: img.url,
    });
  }
  // Perlu minimal 2 biar ada gunanya swap
  if (labeled.length < 2) return files;

  // Cari di mana tiap URL dipakai + ambil konteks JSX di sekitarnya
  const usages = [];
  for (const [path, code] of Object.entries(files)) {
    for (const entry of labeled) {
      const idx = code.indexOf(entry.url);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 400);
      const end = Math.min(code.length, idx + entry.url.length + 400);
      const context = code.slice(start, end).replace(/\s+/g, " ");
      usages.push({ path, token: entry.token, context });
    }
  }
  if (usages.length < 2) return files;

  // C3: image-reconcile is a "small call", use the fast model when configured.
  const { object } = await generateObjectTracked("image-reconcile", {
    model: fastModel,
    modelName: FAST_MODEL_NAME || undefined,
    schema: ImageReconcileSchema,
    system:
      "You verify whether user-uploaded images were placed on the right card " +
      "in a generated React project. You receive: (a) uploaded images with their " +
      "content labels, and (b) snippets of JSX where those images are used. " +
      "For each snippet, read the card title/heading near the image src, and " +
      "check whether the image's label MEANS THE SAME THING as that title. " +
      "Only output a swap when the label clearly does NOT match the title. " +
      "Never swap based on how a photo 'feels' — only based on the label text.",
    prompt:
      "## Uploaded images (label = what the photo actually shows)\n" +
      labeled.map((e) => `- ${e.token} = "${e.label}"`).join("\n") +
      "\n\n## Where each token is used in the generated code\n" +
      usages
        .map(
          (u, i) =>
            `#${i} path=${u.path} token=${u.token}\n  snippet: ${u.context}`,
        )
        .join("\n\n") +
      "\n\n## Task\n" +
      "For each usage: does the image's label match the card title/heading " +
      "visible in the snippet?\n" +
      "- If YES (or you cannot tell), skip it.\n" +
      "- If NO, output a swap: { path, from, to, reason }.\n" +
      "  - `from` = the token currently used (its label does NOT match its card)\n" +
      "  - `to` = the token whose label DOES match this card's title\n" +
      "  - Swap within the same file only.\n" +
      "\nExample: snippet #0 has `<h3>Nasi Goreng</h3>` but token=ref-img-01 " +
      'and uploaded list says `ref-img-01 = "nasi kuning"`. Meanwhile ' +
      '`ref-img-02 = "nasi goreng"` is used elsewhere. Output: ' +
      `{ "swaps": [{ "path": "/components/Menu.js", "from": "ref-img-01", ` +
      `"to": "ref-img-02", "reason": "nasi kuning photo on Nasi Goreng card" }] }\n` +
      "\nIf a card title has no matching label, DO NOT guess — skip it.\n" +
      "\nOutput JSON only: { swaps: [...] }. Empty array if everything is correct.",
    maxRetries: 1,
  });

  if (!object.swaps || object.swaps.length === 0) return files;

  const urlOf = new Map(labeled.map((e) => [e.token, e.url]));

  // Group swap per file
  const byPath = new Map();
  for (const swap of object.swaps) {
    if (!swap?.path || !swap.from || !swap.to) continue;
    if (!byPath.has(swap.path)) byPath.set(swap.path, []);
    byPath.get(swap.path).push(swap);
  }

  const patched = { ...files };
  for (const [path, swaps] of byPath) {
    if (typeof patched[path] !== "string") continue;
    let code = patched[path];

    // Pass 1: ganti semua fromUrl dengan placeholder unik (biar bisa swap siklus)
    const placeholders = [];
    for (let i = 0; i < swaps.length; i++) {
      const fromUrl = urlOf.get(swaps[i].from);
      if (!fromUrl || !code.includes(fromUrl)) {
        placeholders.push(null);
        continue;
      }
      const ph = `\u0001IMGSWAP${i}\u0001`;
      code = code.split(fromUrl).join(ph);
      placeholders.push(ph);
      console.log(
        `[ImageReconcile] ${path}: ${swaps[i].from} -> ${swaps[i].to} (${swaps[i].reason || "label mismatch"})`,
      );
    }

    // Pass 2: ganti placeholder dengan toUrl
    for (let i = 0; i < swaps.length; i++) {
      if (!placeholders[i]) continue;
      const toUrl = urlOf.get(swaps[i].to);
      if (!toUrl) continue;
      code = code.split(placeholders[i]).join(toUrl);
    }

    patched[path] = code;
  }

  return patched;
}

// ── Unsplash photo search ───────────────────────────────────────────────────
async function searchUnsplash(queries) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return [];

  const results = [];
  for (const q of (queries || []).slice(0, 5)) {
    try {
      const res = await fetch(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=2&orientation=landscape`,
        { headers: { Authorization: `Client-ID ${accessKey}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const photo of data.results || []) {
        const label = (photo.alt_description || photo.description || q).trim();
        results.push({
          url: photo.urls.regular,
          name: label,
          label,
          // Metadata buat compliance (attribution + trigger download)
          source: "unsplash",
          photographer: photo.user?.name || "Unknown",
          photographerUrl: `${photo.user?.links?.html}?utm_source=renscraft&utm_medium=referral`,
          photoUrl: `${photo.links?.html}?utm_source=renscraft&utm_medium=referral`,
          downloadLocation: photo.links?.download_location,
        });
      }
    } catch (err) {
      console.warn(`[Unsplash] query "${q}" failed: ${err.message}`);
    }
  }
  return results;
}

// ── PART 2/3: generateProject ──────────────────────────────────────────────

// Generate project files: plan first, then build files in order with fallback retries
// options.brief = snapshot dari Project.brief (undefined = jalur lama tanpa brief)
export async function generateProject(prompt, callbacks, options = {}) {
  // Phase 0: read any URLs the user mentioned (content + design tokens).
  const uploadedImages = options.uploadedImages || [];
  const uploadedAssets = uploadedImages
    .filter((img) => img?.url)
    .map((img) => ({
      url: img.url,
      name: img.name || "",
      label: (img.name || "").replace(/\.[^.]+$/, "").trim(),
    }));

  const briefBlock = options.brief ? buildBriefBlock(options.brief) : "";
  const hasBrief = Boolean(options.brief);

  const initialRefs = await buildReferenceContext(prompt, [], {
    mirror: mirrorImages,
    extraAssets: uploadedAssets,
  });

  const initialAiPrompt = [prompt, initialRefs.context, briefBlock]
    .filter(Boolean)
    .join("\n\n");

  if (initialRefs.context) {
    console.log(
      `[AI] Phase 0: reference context added (${initialRefs.context.length} chars, ${initialRefs.assets.length} images)`,
    );
  }

  if (initialRefs.failed.length > 0) {
    console.warn(
      `[AI] ${initialRefs.failed.length} reference URL(s) could not be read: ` +
        initialRefs.failed.map((f) => `${f.url} (${f.reason})`).join("; "),
    );
    if (callbacks?.onReferenceFailed) {
      await callbacks.onReferenceFailed(initialRefs.failed);
    }
  }

  // Phase 1: Plan.
  logContext("plan", {
    layers: ["concept", "brief", "refs"],
    refs: initialRefs.assets.length,
    hasBrief,
  });
  console.log(
    `[AI] Phase 1: Planning file structure for: "${prompt.slice(0, 80)}..."`,
  );
  const { object: rawPlan } = await generateObjectTracked("plan", {
    model: PLAN_MODEL,
    modelName: PLAN_MODEL_NAME || undefined,
    schema: FilePlanSchema,
    system: buildFilePlanSystem({ hasBrief }),
    prompt: `Plan a React website for: ${initialAiPrompt}`,
    maxRetries: 2,
  });

  // Phase 1.5: stock photos.
  let stockAssets = [];
  if (rawPlan.imageQueries?.length && process.env.UNSPLASH_ACCESS_KEY) {
    stockAssets = await searchUnsplash(rawPlan.imageQueries);
    if (stockAssets.length > 0) {
      console.log(
        `[Unsplash] fetched ${stockAssets.length} photo(s) for: ${rawPlan.imageQueries.join(", ")}`,
      );
    }
  }

  // Phase 1.6: rebuild context with stock assets.
  let referenceContext = initialRefs.context;
  let assets = initialRefs.assets;
  if (stockAssets.length > 0) {
    const rebuilt = await buildReferenceContext(prompt, [], {
      mirror: mirrorImages,
      extraAssets: [...uploadedAssets, ...stockAssets],
    });
    referenceContext = rebuilt.context;
    assets = rebuilt.assets;
    console.log(
      `[AI] Phase 1.6: context rebuilt with Unsplash (${assets.length} total images)`,
    );
  }

  const aiPrompt = [prompt, referenceContext, briefBlock]
    .filter(Boolean)
    .join("\n\n");

  if (!rawPlan.files.find((f) => f.path === "/App.js")) {
    rawPlan.files.unshift({
      path: "/App.js",
      description: "Main application entry point",
      exports: "default App",
      imports: ["./styles.css"],
    });
  }

  if (!rawPlan.files.find((f) => f.path === "/styles.css")) {
    rawPlan.files.push({
      path: "/styles.css",
      description:
        "Global CSS: Google Font import, keyframe animations, utility classes",
      exports: "none",
      imports: [],
    });
  }

  let planInput = rawPlan;
  if (options.brief && process.env.HARNESS_PLAN_GUARD !== "0") {
    const { plan: pruned, dropped } = pruneSectionsWithoutData(
      rawPlan,
      options.brief,
    );
    if (dropped.length > 0) {
      console.log(
        `[PlanGuard] dropped sections without data: ${dropped.join(", ")}`,
      );
    }
    planInput = pruned;
  }

  const { plan, contract } = applyContractToPlan(planInput, prompt);

  if (options.brief) {
    contract.facts = mergeBriefFacts(contract.facts, options.brief, prompt);
    if (process.env.PROMPT_V2 === "1") {
      const design = designFromBrief(options.brief, prompt);
      if (design) {
        contract.design = design;
      }
    }
  }

  if (callbacks?.onPlan) {
    await callbacks.onPlan(plan);
  }

  const files = {};
  const emitted = new Map();
  const normPath = (p) => (p.startsWith("/") ? p : "/" + p);
  const emitFile = async (path, code) => {
    emitted.set(normPath(path), code);
    if (callbacks?.onFileComplete) {
      await callbacks.onFileComplete(path, code);
    }
  };

  const serverOwnedPaths = contract.files
    .filter((fc) => fc.serverContent != null)
    .map((fc) => fc.path);

  for (const fc of contract.files) {
    if (fc.serverContent == null) continue;
    if (callbacks?.onFileStart) await callbacks.onFileStart(fc.path);
    files[fc.path] = fc.serverContent;
    await emitFile(fc.path, fc.serverContent);
  }

  let pendingFiles = plan.files
    .filter((f) => !Object.hasOwn(files, f.path))
    .map((f) => ({ ...f }));

  console.log(
    `[AI] Phase 2: Generating ${plan.files.length} files in parallel (concurrency=${MAX_CONCURRENCY}): ${plan.files.map((f) => f.path).join(", ")}`,
  );

  const FATAL_CODES = new Set(["BUDGET_EXCEEDED", "SEMAPHORE_TIMEOUT"]);
  let budgetExceeded = false;
  let semaphoreTimedOut = false;

  const maxRetryRounds = 2;
  for (let round = 0; round <= maxRetryRounds; round++) {
    if (pendingFiles.length === 0) break;
    if (round > 0) {
      console.log(
        `[AI] Retry round ${round}/${maxRetryRounds} for ${pendingFiles.length} failed files: ${pendingFiles.map((f) => f.path).join(", ")}`,
      );
    }

    const results = await pMap(
      pendingFiles,
      async (file) => {
        try {
          if (callbacks?.onFileStart) {
            await callbacks.onFileStart(file.path);
          }
          const alreadyGenerated =
            round === 0 || !RETRY_FEEDBACK
              ? files
              : contextFilesFor(file, plan, files, serverOwnedPaths);
          const singleResult = await generateSingleFile(
            file,
            plan.files,
            aiPrompt,
            alreadyGenerated,
            assets,
            contract,
            hasBrief,
            plan.dataSpec ?? null,
          );
          await emitFile(file.path, singleResult.code);
          return { success: true, file, result: singleResult };
        } catch (err) {
          file.lastError = String(err?.message ?? err).slice(0, 300);
          return { success: false, file, error: err };
        }
      },
      { concurrency: MAX_CONCURRENCY },
    );

    const failedFiles = [];
    for (const entry of results) {
      if (!entry || typeof entry !== "object") {
        console.warn(
          `[AI] pMap produced an invalid entry (round ${round}), skipping`,
        );
        continue;
      }
      if (entry.success) {
        const { path: p, code } = entry.result;
        files[p.startsWith("/") ? p : "/" + p] = code;
      } else {
        const code = entry.error?.code;
        if (FATAL_CODES.has(code)) {
          if (code === "BUDGET_EXCEEDED") budgetExceeded = true;
          if (code === "SEMAPHORE_TIMEOUT") semaphoreTimedOut = true;
        }
        console.warn(
          `[AI] File ${entry.file.path} failed in round ${round}: ${entry.error?.message || entry.error}`,
        );
        failedFiles.push(entry.file);
      }
    }
    pendingFiles = failedFiles;

    if (budgetExceeded || semaphoreTimedOut) {
      console.warn(
        `[AI] Fatal (${budgetExceeded ? "budget" : "semaphore"}) hit in round ${round}, stopping retry loop. ${pendingFiles.length} file(s) will become placeholders.`,
      );
      break;
    }
  }

  if (pendingFiles.length > 0) {
    const failedPaths = pendingFiles.map((f) => f.path).join(", ");
    console.error(
      `[AI] Failed to generate ${pendingFiles.length} files after all retry rounds: ${failedPaths}`,
    );

    if (pendingFiles.some((f) => f.path === "/App.js")) {
      throw new Error(
        `AI failed to generate /App.js after ${maxRetryRounds + 1} attempts. Failed files: ${failedPaths}`,
      );
    }

    for (const file of pendingFiles) {
      const key = file.path.startsWith("/") ? file.path : "/" + file.path;
      const ext = file.path.split(".").pop()?.toLowerCase();
      const purpose = String(file.description || "").replace(/\*\//g, "* /");

      if (ext === "css") {
        files[key] = `/* ${purpose} - generation failed, please retry */\n`;
      } else {
        // F8.3: placeholder mengikuti contract (named vs default export yang
        // diharapkan importer) supaya bundle tidak pecah.
        const exp = parseExports(file.exports, file.path);
        const baseName =
          file.path
            .split("/")
            .pop()
            ?.replace(/\.\w+$/, "") || "Placeholder";
        const fnName = exp.defaultExport || baseName || "Placeholder";
        const namedLines = (exp.namedExports || [])
          .filter((n) => n !== fnName)
          .map((n) => `export const ${n} = ${fnName};`)
          .join("\n");

        files[key] =
          "import React from 'react';\n\n" +
          `// This file could not be generated. Please retry.\n` +
          `// Purpose: ${purpose}\n\n` +
          `export default function ${fnName}() {\n` +
          "  return (\n" +
          "    <div className='p-8 text-center text-zinc-400'>\n" +
          "      <p>Component failed to generate. Please try again.</p>\n" +
          "    </div>\n" +
          "  );\n" +
          "}\n" +
          (namedLines ? `\n${namedLines}\n` : "");
      }
    }
  }

  if (!files["/App.js"]) {
    throw new Error("AI did not generate /App.js entry point");
  }

  let finalFiles = files;
  try {
    const check = checkContract(files, contract);
    finalFiles = check.files;
    const applied = check.issues.filter((i) => i.fixed);
    const open = check.issues.filter((i) => !i.fixed);
    if (applied.length > 0) {
      console.log(
        `[Contract] ${applied.length} fix(es) in ${Object.keys(check.fixed).length} file(s):\n  - ` +
          applied.map((i) => `${i.path}: ${i.message}`).join("\n  - "),
      );
    }
    if (open.length > 0) {
      console.warn(
        `[Contract] ${open.length} issue(s) left:\n  - ` +
          open.map((i) => `${i.path}: ${i.message}`).join("\n  - "),
      );
    }
  } catch (err) {
    console.error(
      "[Contract] checker failed, keeping files as generated:",
      err,
    );
  }

  try {
    const reconciled = await reconcileUploadedImages(
      finalFiles,
      uploadedImages,
    );
    if (reconciled !== finalFiles) {
      console.log("[ImageReconcile] applied swaps");
    }
    finalFiles = reconciled;
  } catch (err) {
    console.error("[ImageReconcile] failed, keeping files as-is:", err);
  }

  if (process.env.HARNESS_FACT_GUARD !== "0" && FACT_GUARD_MAX_FILES > 0) {
    try {
      // F7: satu sumber fakta, jalan untuk semua project (brief maupun tidak).
      // Project tanpa brief = sumber dari prompt + refs + contract.facts.
      const factCtx = buildFactContext({
        prompt,
        brief: options.brief ?? null,
        referenceContext,
        contract,
      });
      const allow = factCtx.allow;

      const blockingKinds = new Set([
        "phone",
        "email",
        "price",
        "stat",
        "rating",
        "year",
      ]);
      const scored = [];
      for (const [p, code] of Object.entries(finalFiles)) {
        if (!/\.(jsx?)$/i.test(p)) continue;
        if (serverOwnedPaths.includes(p)) continue;
        const facts = findInventedFacts(code, allow);
        const blocking = facts.filter((f) => blockingKinds.has(f.kind));
        if (blocking.length === 0) continue;
        scored.push({ path: p, code, blocking });
      }

      if (scored.length === 0) {
        console.log(`[FactGuard] generation: no invented facts`);
      } else {
        scored.sort((a, b) => b.blocking.length - a.blocking.length);
        const toFix = scored.slice(0, FACT_GUARD_MAX_FILES);
        console.log(
          `[FactGuard] generation: ${scored.length} file(s) with blocking facts, regenerating ${toFix.length}`,
        );

        for (const entry of toFix) {
          const before = entry.code;
          const beforeCount = entry.blocking.length;
          const fileSpec = plan.files.find((f) => f.path === entry.path) || {
            path: entry.path,
            description: "existing project file",
          };
          const values = entry.blocking.map((f) => f.value);
          const lastError = `Invented facts: ${JSON.stringify(values)}. Use only values that appear in the brief or the prompt; where data is missing use the placeholder text from the brief.`;
          const retryFile = { ...fileSpec, lastError };
          try {
            const regen = await generateSingleFile(
              retryFile,
              plan.files,
              aiPrompt,
              { ...finalFiles, [entry.path]: before },
              assets,
              contract,
              hasBrief,
              plan.dataSpec ?? null,
            );
            const afterFacts = findInventedFacts(regen.code, allow);
            const afterCount = afterFacts.filter((f) =>
              blockingKinds.has(f.kind),
            ).length;
            if (afterCount < beforeCount) {
              finalFiles[entry.path] = regen.code;
              console.log(
                `[FactGuard] ${entry.path}: fixed ${beforeCount} -> ${afterCount} blocking fact(s)`,
              );
            } else {
              console.log(
                `[FactGuard] ${entry.path}: regen did not improve (${beforeCount} -> ${afterCount}), kept old code`,
              );
            }
          } catch (err) {
            console.warn(
              `[FactGuard] ${entry.path}: regen failed (${err.message}), kept old code`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[FactGuard] generation check failed: ${err.message}`);
    }
  }

  try {
    const style = await fixStylesheets(finalFiles);
    finalFiles = style.files;
    finalFiles = injectDesignTokens(finalFiles, contract);
    const rewritten = Object.keys(style.fixed).length;
    const problems = style.notes.filter((n) =>
      /failed|crashed|does not parse/.test(n),
    );
    if (rewritten > 0) {
      console.log(
        `[Styles] ${rewritten} stylesheet(s) rewritten:\n  - ` +
          style.notes.filter((n) => !problems.includes(n)).join("\n  - "),
      );
    }
    if (problems.length > 0) {
      console.warn(
        `[Styles] ${problems.length} problem(s):\n  - ` +
          problems.join("\n  - "),
      );
    }
  } catch (err) {
    console.error(
      "[Styles] stylesheet pass failed, keeping files as generated:",
      err,
    );
  }

  // ── F3: finalize step ────────────────────────────────────────────────
  let finalizeIssues = [];
  if (process.env.HARNESS_FINAL_REVALIDATE !== "0") {
    try {
      const fin = await finalizeProject(finalFiles, contract);
      finalizeIssues = fin.issues;

      if (fin.blocking > 0) {
        console.warn(
          `[Finalize] ${fin.blocking} blocking issue(s):\n  - ` +
            fin.issues
              .filter((i) => i.severity === "blocking")
              .map((i) => `${i.path || "*"}: ${i.message}`)
              .join("\n  - "),
        );
      }
      const fixedCount = fin.issues.filter((i) => i.autoFixed).length;
      if (fixedCount > 0) {
        console.log(`[Finalize] ${fixedCount} fix(es) applied`);
      }
      finalFiles = fin.files;
    } catch (err) {
      console.error("[Finalize] crashed, keeping files as-is:", err);
    }
  }

  // ── F5: QA gate ──────────────────────────────────────────────────────
  // WAJIB di function scope: ketiga variabel ini dipakai di return statement.
  // ── F5: QA gate + diagnostic repair loop (F5.6) ──────────────────────
  let gateIssues = [];
  let gateStages = {};
  let gateMode = "off";

  if (process.env.HARNESS_QA_GATE !== "0") {
    const MAX_REPAIR = Math.max(
      0,
      parseInt(process.env.GEN_BUDGET_MAX_REPAIR_ROUNDS || "1", 10) || 1,
    );

    for (let round = 0; round <= MAX_REPAIR; round++) {
      let gate;
      try {
        gate = await runQualityGate(finalFiles, contract);
      } catch (err) {
        console.error("[QA] gate crashed, skipping:", err);
        break;
      }

      gateMode = gate.mode;
      gateStages = gate.stages;
      gateIssues = gate.reportable ? gate.issues : [];

      const fmt = (i) =>
        `${i.code}${i.path ? ` @ ${i.path}` : ""}: ${i.message}`;

      if (gate.mode === "shadow") {
        if (gate.loggable.length > 0) {
          console.log(
            `[QA] shadow: ${gate.loggable.length} blocking issue(s) (not applied):\n  - ` +
              gate.loggable.map(fmt).join("\n  - "),
          );
        } else if (gate.issues.length > 0) {
          console.log(
            `[QA] shadow: passed (${gate.issues.length} warning(s) ignored)`,
          );
        } else {
          console.log(`[QA] shadow: passed`);
        }
      } else if (gate.mode === "off") {
        break;
      } else if (gate.issues.length === 0) {
        console.log(`[QA] ${gate.mode}: passed (round ${round})`);
      } else {
        const blocking = gate.issues.filter((i) => i.severity === "blocking");
        console.log(
          `[QA] ${gate.mode}: ${gate.issues.length} issue(s), ${blocking.length} blocking (round ${round})\n  - ` +
            gate.issues.map(fmt).join("\n  - "),
        );
      }

      // Repair hanya di mode enforce
      if (gate.mode !== "enforce") break;
      if (round >= MAX_REPAIR) break;

      const blocking = gate.issues.filter((i) => i.severity === "blocking");
      if (blocking.length === 0) break;

      // Budget guard
      const budget = getBudgetSummary();
      if (budget?.exceeded) {
        console.warn(`[QA] budget exceeded, stopping repair`);
        break;
      }

      // Group blocking by path
      const byPath = new Map();
      for (const issue of blocking) {
        const p = issue.path;
        if (!p || p === "*") continue;
        if (!byPath.has(p)) byPath.set(p, []);
        byPath.get(p).push(issue);
      }

      if (byPath.size === 0) {
        console.warn(
          `[QA] ${blocking.length} blocking issue(s) without a specific path, cannot repair`,
        );
        break;
      }

      console.log(
        `[QA] repair round ${round + 1}/${MAX_REPAIR}: regenerating ${byPath.size} file(s): ${[...byPath.keys()].join(", ")}`,
      );

      for (const [path, issuesForFile] of byPath) {
        const fileSpec = plan.files.find((f) => f.path === path) || {
          path,
          description: "existing project file",
        };
        const lastError =
          "QA gate: " +
          issuesForFile
            .map((i) => `${i.code}: ${i.message}`)
            .join("; ")
            .slice(0, 280);
        const retryFile = { ...fileSpec, lastError };
        try {
          const regen = await generateSingleFile(
            retryFile,
            plan.files,
            aiPrompt,
            finalFiles,
            assets,
            contract,
            hasBrief,
            plan.dataSpec ?? null,
          );
          finalFiles[path] = regen.code;
          console.log(`[QA] repaired ${path} (${regen.code.length} chars)`);
        } catch (err) {
          console.warn(`[QA] regen failed for ${path}: ${err.message}`);
        }
      }

      // Setelah repair: re-finalize + re-stylesheet, lalu loop akan
      // menjalankan gate lagi.
      if (process.env.HARNESS_FINAL_REVALIDATE !== "0") {
        try {
          const fin = await finalizeProject(finalFiles, contract);
          finalFiles = fin.files;
          for (const i of fin.issues) finalizeIssues.push(i);
        } catch (err) {
          console.error("[Finalize] post-repair failed:", err);
        }
      }
      try {
        const style = await fixStylesheets(finalFiles);
        finalFiles = style.files;
        finalFiles = injectDesignTokens(finalFiles, contract);
      } catch (err) {
        console.warn("[Styles] post-repair failed:", err);
      }
    }
  }

  // Unsplash download
  if (stockAssets.length > 0) {
    const accessKey = process.env.UNSPLASH_ACCESS_KEY;
    for (const asset of stockAssets) {
      if (!asset.downloadLocation) continue;
      fetch(asset.downloadLocation, {
        headers: { Authorization: `Client-ID ${accessKey}` },
      }).catch(() => {});
    }
    console.log(
      `[Unsplash] triggered download for ${stockAssets.length} photo(s)`,
    );
  }

  const fixed = {};
  for (const [p, code] of Object.entries(finalFiles)) {
    const key = normPath(p);
    if (emitted.get(key) !== code) {
      fixed[key] = code;
    }
  }

  return {
    files: finalFiles,
    fixed,
    description: plan.projectDescription,
    dataSpec: plan.dataSpec ?? null,
    finalizeIssues,
    budgetExceeded,
    semaphoreTimedOut,
    budget: getBudgetSummary(),
    gateIssues,
    gateStages,
    gateMode,
    contract, // gini bre?
  };
}

// ── PART 3/3: reviseProject + rewriteFile ──────────────────────────────────

// Revision prompts that talk about images / links / sources re-read the URLs
// shared earlier in the project. Other revisions skip that, staying cheap.
const REFERENCE_HINT_RE =
  /\b(url|link|situs|web|halaman|sumber|source|referensi|reference|gambar|foto|image|asset|picture|photo|logo|banner)/i;

export async function reviseProject(
  prompt,
  manifest,
  relevantFiles,
  recentMessages,
  historyUrls = [],
  uploadedImages = [],
  extra = {},
) {
  const briefBlock = extra.brief ? buildBriefBlock(extra.brief) : "";
  const concept = String(extra.concept ?? "").slice(0, 600);
  const hasBrief = Boolean(extra.brief);
  const scope = extra.scope || null;
  const scopedFiles = scope?.mode === "files" ? scope.files : null;

  const uploadedAssets = (uploadedImages || [])
    .filter((img) => img?.url)
    .map((img) => ({
      url: img.url,
      name: img.name || "",
      label: (img.name || "").replace(/\.[^.]+$/, "").trim(),
    }));

  const useHistory = historyUrls.length > 0 && REFERENCE_HINT_RE.test(prompt);

  // Foto stok per-item: cuma kalau user minta gambar & Unsplash aktif.
  // 1 call LLM murah (kelompokkan item jadi query) + max 6 search Unsplash.

  let stockAssets = [];

  if (wantsImages(prompt) && process.env.UNSPLASH_ACCESS_KEY) {
    try {
      const { object: grouping } = await generateObjectTracked("plan", {
        model: PLAN_MODEL,
        modelName: PLAN_MODEL_NAME || undefined,
        schema: ImageGroupsSchema,
        system: IMAGE_GROUPS_SYSTEM,
        prompt: buildImageGroupsPrompt(prompt, relevantFiles),
        maxRetries: 1,
      });
      const { assets: photos, missing } = await fetchItemPhotos(
        grouping?.groups,
      );
      stockAssets = photos;
      console.log(
        `[Unsplash] revise: ${photos.length}/${photos.length + missing.length} item photo(s) matched`,
      );
      if (missing.length) {
        console.log(`[Unsplash] revise: no photo for: ${missing.join(", ")}`);
      }
    } catch (err) {
      console.warn(`[Unsplash] revise photo step failed: ${err.message}`);
    }
  }

  const {
    context: referenceContext,
    failed: failedReferences,
    assets,
  } = await buildReferenceContext(prompt, useHistory ? historyUrls : [], {
    mirror: mirrorImages,
    extraAssets: [...uploadedAssets, ...stockAssets],
  });

  if (referenceContext) {
    console.log(
      `[AI] Revise: reference context added (${referenceContext.length} chars, ${assets.length} images)`,
    );
  }

  if (failedReferences.length > 0) {
    console.warn(
      `[AI] ${failedReferences.length} reference URL(s) could not be read: ` +
        failedReferences.map((f) => `${f.url} (${f.reason})`).join("; "),
    );
  }

  // Long URLs inside file contents become short tokens
  const shield = createUrlShield(assets);

  const contextParts = [];

  contextParts.push("## Current Project Files (manifest)");
  contextParts.push("```");
  for (const f of manifest) {
    contextParts.push(`${f.path} (${f.hash}, ${f.size}B)`);
  }
  contextParts.push("```");

  if (Object.keys(relevantFiles).length > 0) {
    contextParts.push("\n## File Contents (for reference)");
    for (const [p, content] of Object.entries(relevantFiles)) {
      contextParts.push(
        `\n### ${p}\n\`\`\`\n${shield.shield(content)}\n\`\`\``,
      );
    }
  }

  if (recentMessages.length > 0) {
    contextParts.push("\n## Recent Conversation");
    for (const msg of recentMessages.slice(-3)) {
      contextParts.push(`${msg.role}: ${msg.content}`);
    }
  }

  if (referenceContext) {
    contextParts.push(`\n${referenceContext}`);
  }

  if (shield.used) {
    contextParts.push(
      "\n## Note about long URLs\n" +
        "Long URLs in the file contents above are replaced by short tokens: `ref-img-NN` " +
        "(images from the reference pages) and `old-url-NN` (other long URLs). Copy tokens " +
        "exactly inside `search`, `replace` and `content`; they are expanded to the real URLs " +
        'automatically. Prefer tiny single-line `search` strings such as src="old-url-03".' +
        "\n`unresolved-img-NN` marks an image that never got a real URL (it is broken on the page). " +
        "Do not treat it as a valid image: replace it with a ref-img-NN token from the available images " +
        "list ONLY if you are sure that photo belongs to that entry, otherwise set the image to null.",
    );
  }

  // A2: concept, brief block, and precedence note. A5.1: the precedence note
  // is only added when a brief block exists (legacy projects stay unchanged
  // except for the concept part).
  if (concept) {
    contextParts.push(
      `\n## Project concept (original request, quoted as data)\n${JSON.stringify(concept)}`,
    );
  }
  if (briefBlock) {
    contextParts.push(`\n${briefBlock}`);
    contextParts.push(`\n## Precedence note\n${REVISION_PRECEDENCE_NOTE}`);
  }

  // C2: when the controller narrowed the scope, the model is told explicitly
  // which files it may edit and which must stay untouched.
  if (scopedFiles) {
    const inScope = [...scopedFiles].join(", ");
    contextParts.push(
      `\n## Revision scope\nOnly files shown in full are in scope. Do not edit the others.\nIn scope: ${inScope}`,
    );
  }

  contextParts.push(`\n## Revision Request\n${prompt}`);

  logContext("revise", {
    layers: ["concept", "brief", "files", "history", "refs"],
    files: `${Object.keys(relevantFiles).length}/${manifest.length}`,
    history: recentMessages.length,
    refs: assets.length,
    hasBrief,
  });

  console.log("[AI] Revising project...");

  const parsed = await generateObjectTracked("revise", {
    model,
    schema: RevisionResultSchema,
    system: buildReviseSystem({ hasBrief }),
    prompt: contextParts.join("\n"),
    maxRetries: 2,
  });
  let rawParsed = parsed.object;

  // B3: empty-operations retry. Maximum one retry.
  if (
    rawParsed &&
    Array.isArray(rawParsed.operations) &&
    rawParsed.operations.length === 0
  ) {
    console.warn(
      `[AI] revise returned zero operations: ${rawParsed.description || "-"}\n  raw text: ${String(parsed.text ?? "").slice(0, 400)}`,
    );
    const retry = await generateObjectTracked("revise", {
      model,
      schema: RevisionResultSchema,
      system: buildReviseSystem({ hasBrief }),
      prompt:
        contextParts.join("\n") +
        "\n\nYour previous answer had zero operations. If the request can be done, return at least one valid operation. If it truly cannot, keep operations empty and explain why in description.",
      maxRetries: 1,
    });
    rawParsed = retry.object;
  }

  if (rawParsed && Array.isArray(rawParsed.operations)) {
    rawParsed.operations = rawParsed.operations.map((op) => {
      if (!op || typeof op !== "object") return op;

      let opStr = String(op.op || "")
        .trim()
        .toLowerCase();

      if (["create", "add", "new"].includes(opStr)) op.op = "create";
      else if (["update", "edit", "modify", "patch"].includes(opStr))
        op.op = "update";
      else if (["delete", "remove", "del", "rm"].includes(opStr))
        op.op = "delete";

      if (op.path && typeof op.path === "string" && !op.path.startsWith("/")) {
        op.path = "/" + op.path;
      }

      // tokens -> real URLs (search too, so it matches the real file content)
      if (op.content) op.content = shield.restore(normalizeContent(op.content));
      if (op.search) op.search = shield.restore(normalizeContent(op.search));
      if (op.replace) op.replace = shield.restore(normalizeContent(op.replace));

      if (op.op === "create" && op.content) {
        const validation = validateRevisionContent(
          op.content,
          op.path,
          "create",
        );
        op.content = validation.content;
        if (validation.warnings.length > 0) {
          console.log(
            `[Validator] Revision Create adjustments for ${op.path}:\n  - ${validation.warnings.join("\n  - ")}`,
          );
        }
      } else if (op.op === "update" && op.replace) {
        const validation = validateRevisionContent(
          op.replace,
          op.path,
          "update",
        );
        op.replace = validation.content;
        if (validation.warnings.length > 0) {
          console.log(
            `[Validator] Revision Update adjustments for ${op.path}:\n  - ${validation.warnings.join("\n  - ")}`,
          );
        }
      }
      return op;
    });

    // C2: drop update/delete ops on paths outside the scope. `create` stays
    // allowed (a new file has no scope yet).
    if (scopedFiles) {
      const kept = [];
      const dropped = [];
      for (const op of rawParsed.operations) {
        if (
          (op.op === "update" || op.op === "delete") &&
          !scopedFiles.has(op.path)
        ) {
          dropped.push(`${op.op} ${op.path}`);
          continue;
        }
        kept.push(op);
      }
      if (dropped.length > 0) {
        console.log(
          `[RevisionScope] dropped out-of-scope op(s): ${dropped.join(", ")}`,
        );
        const note = `Operasi di luar scope diabaikan: ${dropped.join(", ")}.`;
        rawParsed.description = rawParsed.description
          ? `${rawParsed.description} (${note})`
          : note;
      }
      rawParsed.operations = kept;
    }
  }

  // Unsplash API rule: trigger download buat foto yang dipakai di hasil revisi.
  if (
    stockAssets.length > 0 &&
    rawParsed &&
    Array.isArray(rawParsed.operations)
  ) {
    const newCode = rawParsed.operations
      .map((op) => `${op?.content || ""}\n${op?.replace || ""}`)
      .join("\n");
    triggerDownloads(stockAssets, newCode).catch((err) =>
      console.warn(`[Unsplash] download trigger failed: ${err.message}`),
    );
  }

  // The controller needs these when it has to fall back to rewriteFile().
  return { ...rawParsed, referenceContext, assets, briefBlock, stockAssets };
}

// ---------------------------------------------------------------------------
// Fallback for a failed revision.
// ---------------------------------------------------------------------------
const LAZY_PLACEHOLDER_RE =
  /(?:\/\/|\/\*|\{\/\*)\s*\.{2,3}\s*(?:rest|existing|remaining|unchanged|same|other|more|previous)/i;

export async function rewriteFile(
  {
    path: filePath,
    current,
    prompt,
    description,
    allPaths,
    assets = [],
    referenceContext = "",
    briefBlock = "",
    // true = `current` is a rejected draft of a NEW file, not an existing file
    draft = false,
  },
  deps = {},
) {
  const generate = deps.generate || generateText;
  const shield = createUrlShield(assets);
  const paths = allPaths.length ? allPaths : [filePath];
  const shownCurrent = shield.shield(current);
  const hasUnresolved = /unresolved-img-\d\d/.test(shownCurrent);

  const system = buildFileCodeSystem(
    paths.map((p) => ({ path: p, description: "existing project file" })),
    {},
    "",
    { hasBrief: Boolean(briefBlock) },
  );

  const baseMsg =
    `Revision request from the user:\n${prompt}\n\n` +
    `Summary of the intended change (an earlier attempt to apply it as a patch failed):\n${description || "(none)"}\n\n` +
    (draft
      ? `${filePath} is a NEW file. A draft of it was rejected (broken formatting or syntax). The draft:\n\`\`\`\n${shownCurrent}\n\`\`\`\n\n`
      : `Current content of ${filePath}:\n\`\`\`\n${shownCurrent}\n\`\`\`\n\n`) +
    (referenceContext ? `${referenceContext}\n\n` : "") +
    (briefBlock ? `${briefBlock}\n\n${REVISION_PRECEDENCE_NOTE}\n\n` : "") +
    (draft
      ? `Write ${filePath} as a complete, properly formatted multi-line file that fulfils the request. Keep the intent and content of the draft; fix its formatting and syntax.\n`
      : `Rewrite ${filePath} so it fulfils the request.\n`) +
    `- Keep everything the request does not touch exactly as it is: same data, texts, class names, imports.\n` +
    (referenceContext
      ? `- When the request is to add or complete content (data, quotes, names, dates), copy it word for word from the reference above, in the same order as the source. Never invent people, names, quotes, dates or numbers and never fill gaps with generic text: if something is not in the reference, leave it out. Image tokens (ref-img-NN) may only be used for entries whose photo you are sure about; otherwise use no image.\n`
      : "") +
    `- Add every import the new code needs (for example useState). Never declare the same variable twice.\n` +
    `- Write the COMPLETE file. Never abbreviate with comments such as "// ... rest of the file".\n` +
    `- The only local files that exist are: ${paths.join(", ")}. Never import any other local file.\n` +
    `- Long URLs appear as short tokens (old-url-NN, ref-img-NN). Keep those tokens exactly as written.\n` +
    (hasUnresolved
      ? `- unresolved-img-NN marks an image that never got a real URL (broken). Replace it with a ref-img-NN token only if you are sure that photo belongs to that entry, otherwise use null. Do not leave it as it is when the request is about images.\n`
      : "") +
    `\n` +
    `Return ONLY the raw source code of ${filePath}.`;

  logContext(`rewrite ${filePath}`, {
    layers: ["concept", "brief", "files", "refs"],
    files: `1/${paths.length}`,
    refs: assets.length,
    hasBrief: Boolean(briefBlock),
  });

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text, finishReason, usage } = await withSlot(
        `rewrite ${filePath}`,
        () =>
          generate({
            model,
            system,
            prompt: lastError ? `...` : baseMsg,
            maxRetries: 2,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          }),
      );

      recordUsage(`rewrite ${filePath}`, usage);

      if (finishReason === "length") {
        throw new Error(`output was cut off (hit ${MAX_OUTPUT_TOKENS} tokens)`);
      }

      let code = shield.restore(extractCode(text));

      // A token that is still literal after restore() does not exist in the asset
      // list. Saving it would put a broken image in the file, so make the model
      // fix it. Tokens that were already in the file are not this revision's fault.
      const strayTokens = [
        ...new Set(code.match(/ref-img-\d{2}/g) || []),
      ].filter((t) => !current.includes(t));
      if (strayTokens.length > 0) {
        const last = String(assets.length).padStart(2, "0");
        throw new Error(
          `it uses image token(s) ${strayTokens.join(", ")} that do not exist (${
            assets.length
              ? `only ref-img-01 to ref-img-${last} are available`
              : "no reference images are available"
          }). Use an existing token or null, never an invented one.`,
        );
      }

      if (code.trim().length < MIN_CODE_LENGTH) {
        throw new Error("the answer is too short to be a complete file");
      }
      // A rewrite that silently drops half of the file (lost data) is worse than no edit
      if (code.length < current.length * 0.5) {
        throw new Error(
          `the new file (${code.length} chars) is less than half of the old one (${current.length} chars), content was probably dropped`,
        );
      }
      if (
        LAZY_PLACEHOLDER_RE.test(code) &&
        !LAZY_PLACEHOLDER_RE.test(current)
      ) {
        throw new Error(
          'it contains a placeholder comment such as "// ... rest", write the full file',
        );
      }

      code = validateAndFixCode(code, filePath, {
        allPlannedFiles: paths.map((p) => ({ path: p })),
      }).code;

      if (/\.(jsx?|tsx?)$/i.test(filePath)) {
        const check = fixUnresolvedImports(code, filePath, paths);
        code = check.code;
        if (check.missing.length > 0) {
          throw new Error(
            `it imports files that do not exist: ${check.missing.join(", ")}`,
          );
        }
      }

      const syntaxError = findSyntaxError(code, filePath);
      if (syntaxError)
        throw new Error(`syntax error: ${syntaxError.slice(0, 200)}`);

      console.log(
        `[AI] Rewrote ${filePath} (${code.length} chars, attempt ${attempt})`,
      );
      return code;
    } catch (err) {
      lastError = err?.message || String(err);
      console.warn(
        `[AI] rewriteFile ${filePath} attempt ${attempt} rejected: ${lastError}`,
      );
    }
  }
  throw new Error(`Could not rewrite ${filePath}: ${lastError}`);
}
