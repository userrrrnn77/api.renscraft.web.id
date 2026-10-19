// src/services/ai.js

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import pMap from "p-map";
import { recordUsage } from "./usageTracker.js";
import {
  FilePlanSchema,
  RevisionResultSchema,
  ImageReconcileSchema,
} from "./aiSchemas.js";
import {
  buildFileCodeSystem,
  FILE_PLAN_SYSTEM,
  REVISE_SYSTEM,
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
} from "./contract/projectContract.js";
import { checkContract } from "./contract/contractChecker.js";
import { fixStylesheets } from "./contract/cssFix.js";
import { buildBriefBlock, mergeBriefFacts } from "./brief/briefContext.js";

// Update juga AI_PRICE_IN_PER_M / AI_PRICE_OUT_PER_M biar tracker biaya akurat.
const MODEL = process.env.AI_MODEL || "deepseek-v4.1-flash";
const MAX_CONCURRENCY = parseInt(process.env.AI_MAX_CONCURRENCY || "6", 10);
// Without an explicit limit the provider falls back to a small default, which
// cuts files off mid-way (~4096 chars) and leaves unclosed brackets in the CSS.
const MAX_OUTPUT_TOKENS = parseInt(
  process.env.AI_MAX_OUTPUT_TOKENS || "16000",
  10,
);

const provider = createOpenAI({
  baseURL: process.env.AI_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.AI_API_KEY,
});

export const model =
  process.env.AI_USE_CHAT_API === "1" ? provider.chat(MODEL) : provider(MODEL);

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
export async function generateObjectTracked(label, args) {
  const { model, schema, system, prompt, abortSignal, maxRetries = 2 } = args;

  const JSON_RULE =
    "\n\n---\nOUTPUT FORMAT (WAJIB):\n" +
    "Balas HANYA dengan satu objek JSON yang valid dan lengkap.\n" +
    "JANGAN tambahkan penjelasan, JANGAN bungkus dengan ```, " +
    "JANGAN tulis teks apa pun di luar JSON. " +
    'Semua string pakai kutip ganda (") dan escape yang benar.';

  // Kalau ini bukan percobaan terakhir dan error-nya 5xx/network, coba lagi
  // dengan delay yang lebih panjang. SDK-nya udah retry sendiri, tapi base
  // backoff-nya terlalu cepat buat provider yang lagi 502/503.
  const isRetryableUpstream = (err) => {
    const status = err?.statusCode ?? err?.response?.status;
    if (status >= 500 && status < 600) return true;
    // Network errors (DNS, socket, timeout)
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
      const result = await generateText({
        model,
        system: system + JSON_RULE,
        prompt: finalPrompt,
        abortSignal,
      });
      recordUsage(label, result.usage);

      try {
        const object = schema.parse(extractJson(result.text));
        return { object, usage: result.usage };
      } catch (err) {
        lastError = (err?.message ?? String(err)).slice(0, 300);
        console.warn(
          `[AI] ${label} attempt ${attempt + 1} invalid JSON: ${lastError}`,
        );
        if (attempt >= maxRetries) throw err;
      }
    } catch (err) {
      // Beda dari JSON parse error — ini error dari HTTP layer.
      // Coba lagi dengan delay lebih panjang kalau upstream 5xx.
      const retryable = isRetryableUpstream(err);

      if (!retryable || attempt >= maxRetries) throw err;

      const delayMs = 3000 * Math.pow(2, attempt); // 3s, 6s, 12s
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

// Generate a single file's code.
// The code is requested as PLAIN TEXT, not as a JSON object. Wrapping source
// code in a JSON string (generateObject) made the model drop every line break
// and most semicolons, which produced one-line files like
// `import React from 'react':// styles.css ...import './styles.css'import Header ...`
async function generateSingleFile(
  file,
  allFiles,
  prompt,
  alreadyGeneratedFiles,
  assets = [],
  contract = null,
) {
  const system = buildFileCodeSystem(
    allFiles,
    alreadyGeneratedFiles,
    contract ? renderContractPrompt(contract, file.path) : "",
  );

  const plannedList = allFiles.map((f) => f.path).join(", ");

  const userMsg = `Project: ${prompt}\n\nWrite the complete code for: ${file.path}\nPurpose: ${file.description}\n\nImport rule: the only local files that exist are: ${plannedList}. Never import any other local file (for example a per-component .css file). Style with Tailwind classes and the global /styles.css.\n\nReturn ONLY the raw source code of this file.`;

  console.log(`[AI] Creating file: ${file.path}...`);
  const { text, finishReason, usage } = await generateText({
    model,
    system,
    prompt: userMsg,
    maxRetries: 2,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  // Recorded before any validation: rejected / cut-off files still cost tokens
  recordUsage(`file ${file.path}`, usage);

  // A cut-off file is never valid code (unclosed brackets, missing exports...)
  if (finishReason === "length") {
    throw new Error(
      `Output for ${file.path} was cut off (hit ${MAX_OUTPUT_TOKENS} output tokens)`,
    );
  }

  let code = extractCode(text);
  // ref-img-01 -> real image URL (the model only ever sees the short token)
  code = applyAssetTokens(code, assets);
  // Foto stock yang ga nyambung sama bisnisnya (laptop di menu kopi, dst) ditukar.
  // Dilewati kalau user ngasih gambar referensi sendiri.
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

  // Apply post-generation validation and auto-fixing
  const validation = validateAndFixCode(code, file.path, {
    allPlannedFiles: allFiles,
  });

  code = validation.code;

  if (validation.warnings.length > 0) {
    console.log(
      `[Validator] Code adjustments for ${file.path}:\n  - ${validation.warnings.join("\n  - ")}`,
    );
  }

  // Relative imports must point to files that are in the plan, otherwise
  // Sandpack fails with "Could not find module in path". Missing stylesheets
  // are removed; any other missing file makes the retry loop regenerate.
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

  // Final gate: never save code that Sandpack/Babel/PostCSS cannot parse.
  // Throwing here makes the retry loop regenerate the file.
  const syntaxError = findSyntaxError(code, file.path);
  if (syntaxError) {
    // Show the exact offending line, so the real cause is visible in the log
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
//
// Kalau user upload "nasi_kuning.jpg", "nasi_goreng.jpg", "nasi_putih.jpg",
// model kadang nempatin posisi 1→1, 2→2, 3→3 (shuffle) alih-alih match label.
// Fungsi ini baca lagi hasil generate, ekstrak "URL ini dipakai di card mana",
// lalu tanya model: label cocok nggak sama judul card di sekitar URL itu?
// Kalau nggak, swap URL-nya. Pakai model YANG SAMA, 1 call kecil.
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

  const { object } = await generateObjectTracked("image-reconcile", {
    model,
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
//
// Dipanggil setelah plan selesai, pakai `plan.imageQueries` yang diisi planner.
// Hasilnya masuk ke buildReferenceContext sebagai extraAssets.
// IMPORTANT: hasil dari Unsplash WAJIB di-hotlink (jangan di-mirror), dan
// setiap foto yang dipakai harus trigger `downloadLocation` (Unsplash API rule).
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

// Generate project files: plan first, then build files in order with fallback retries
// options.brief = snapshot dari Project.brief (undefined = jalur lama tanpa brief)
export async function generateProject(prompt, callbacks, options = {}) {
  // Phase 0: read any URLs the user mentioned (content + design tokens).
  // `prompt` stays the user's original text (it is what gets stored in the DB);
  // `aiPrompt` is what the model actually sees: prompt + reference context.

  const uploadedImages = options.uploadedImages || [];
  const uploadedAssets = uploadedImages
    .filter((img) => img?.url)
    .map((img) => ({
      url: img.url,
      name: img.name || "",
      label: (img.name || "").replace(/\.[^.]+$/, "").trim(),
    }));

  const briefBlock = options.brief ? buildBriefBlock(options.brief) : "";

  // Context awal: cuma URL dari prompt + upload user. Dipakai buat plan.
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

  // Phase 1: Plan
  console.log(
    `[AI] Phase 1: Planning file structure for: "${prompt.slice(0, 80)}..."`,
  );
  const { object: rawPlan } = await generateObjectTracked("plan", {
    model,
    schema: FilePlanSchema,
    system: FILE_PLAN_SYSTEM,
    prompt: `Plan a React website for: ${initialAiPrompt}`,
    maxRetries: 2,
  });

  // Phase 1.5: stock photos dari Pexels (cuma kalau planner ngerasa butuh).
  // Hasilnya ditambahkan ke context supaya model bisa pakai ref-img-NN.
  // Phase 1.5: stock photos dari Unsplash (kalau planner ngerasa butuh).
  let stockAssets = [];
  if (rawPlan.imageQueries?.length && process.env.UNSPLASH_ACCESS_KEY) {
    stockAssets = await searchUnsplash(rawPlan.imageQueries);
    if (stockAssets.length > 0) {
      console.log(
        `[Unsplash] fetched ${stockAssets.length} photo(s) for: ${rawPlan.imageQueries.join(", ")}`,
      );
    }
  }

  // Phase 1.6: kalau ada pexels, rebuild context biar token-nya ke-include.
  // Kalau nggak ada pexels, reuse initialRefs — nggak fetch ulang URL prompt.
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

  // Phase 1b: contract. Everything that must be identical across files (exports,
  // theme plumbing, section ids, shared facts) is fixed here, before any file is
  // written, instead of every file guessing. See services/contract/.
  const { plan, contract } = applyContractToPlan(rawPlan, prompt);

  // Fakta dari planner itu karangan: ganti dengan yang berasal dari brief
  if (options.brief) {
    contract.facts = mergeBriefFacts(contract.facts, options.brief, prompt);
  }

  if (callbacks?.onPlan) {
    await callbacks.onPlan(plan);
  }

  console.log(
    `[AI] Phase 2: Generating ${plan.files.length} files in parallel (concurrency=${MAX_CONCURRENCY}): ${plan.files.map((f) => f.path).join(", ")}`,
  );

  const files = {};

  // Files the server writes itself (ThemeContext) go first, so every file
  // generated afterwards sees their real source in its context.
  for (const fc of contract.files) {
    if (fc.serverContent == null) continue;
    if (callbacks?.onFileStart) await callbacks.onFileStart(fc.path);
    files[fc.path] = fc.serverContent;
    if (callbacks?.onFileComplete) {
      await callbacks.onFileComplete(fc.path, fc.serverContent);
    }
  }

  let pendingFiles = plan.files
    .filter((f) => !Object.hasOwn(files, f.path))
    .map((f) => ({ ...f }));

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

          const singleResult = await generateSingleFile(
            file,
            plan.files,
            aiPrompt,
            files,
            assets,
            contract,
          );

          if (callbacks?.onFileComplete) {
            await callbacks.onFileComplete(file.path, singleResult.code);
          }
          return { success: true, file, result: singleResult };
        } catch (err) {
          return { success: false, file, error: err };
        }
      },
      { concurrency: MAX_CONCURRENCY },
    );

    const failedFiles = [];
    for (const entry of results) {
      if (entry.success) {
        const { path, code } = entry.result;
        files[path.startsWith("/") ? path : "/" + path] = code;
      } else {
        console.warn(
          `[AI] File ${entry.file.path} failed in round ${round}: ${entry.error?.message || entry.error}`,
        );
        failedFiles.push(entry.file);
      }
    }
    pendingFiles = failedFiles;
  }

  if (pendingFiles.length > 0) {
    const failedPaths = pendingFiles.map((f) => f.path).join(", ");
    console.error(
      `[AI] Failed to generate ${pendingFiles.length} files after all retry rounds: ${failedPaths}`,
    );

    // Without App.js there is nothing to render, so fail the whole generation
    // (status -> "failed" with a readable error) instead of faking success.
    if (pendingFiles.some((f) => f.path === "/App.js")) {
      throw new Error(
        `AI failed to generate /App.js after ${maxRetryRounds + 1} attempts. Failed files: ${failedPaths}`,
      );
    }

    // Any other file: save a placeholder so the project still renders.
    for (const file of pendingFiles) {
      const key = file.path.startsWith("/") ? file.path : "/" + file.path;
      const ext = file.path.split(".").pop()?.toLowerCase();
      const purpose = String(file.description || "").replace(/\*\//g, "* /");

      if (ext === "css") {
        files[key] = `/* ${purpose} - generation failed, please retry */\n`;
      } else {
        files[key] =
          "import React from 'react';\n\n" +
          `// This file could not be generated. Please retry.\n` +
          `// Purpose: ${purpose}\n\n` +
          "export default function Placeholder() {\n" +
          "  return (\n" +
          "    <div className='p-8 text-center text-zinc-400'>\n" +
          "      <p>Component failed to generate. Please try again.</p>\n" +
          "    </div>\n" +
          "  );\n" +
          "}\n";
      }
    }
  }

  if (!files["/App.js"]) {
    throw new Error("AI did not generate /App.js entry point");
  }

  // Phase 3: check the files against each other and the contract, fix what can
  // be fixed safely (missing exports, theme wiring, broken #links, invented icons)
  let finalFiles = files;
  let fixed = {};
  try {
    const check = checkContract(files, contract);
    finalFiles = check.files;
    fixed = check.fixed;
    const applied = check.issues.filter((i) => i.fixed);
    const open = check.issues.filter((i) => !i.fixed);
    if (applied.length > 0) {
      console.log(
        `[Contract] ${applied.length} fix(es) in ${Object.keys(fixed).length} file(s):\n  - ` +
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
    // the checker must never lose a generated project
    console.error(
      "[Contract] checker failed, keeping files as generated:",
      err,
    );
  }

  // Phase 3.5: reconcile uploaded images — kalau model masih shuffle
  // (label beda tempat), swap URL-nya berdasarkan label vs judul card.
  // Pakai model yang sama, cuma 1 call kecil.
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
    // reconcile harus nggak pernah ngerusak project
    console.error("[ImageReconcile] failed, keeping files as-is:", err);
  }

  // Phase 4: the preview runs Tailwind from the Play CDN, which ignores @apply /
  // @layer / theme() inside .css files (the rule ends up empty and every element
  // using it is unstyled). Expand them to plain CSS once, here. Runs after the
  // contract checker so it sees the files that will actually be saved.
  try {
    const style = await fixStylesheets(finalFiles);
    finalFiles = style.files;
    fixed = { ...fixed, ...style.fixed };
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
    // a stylesheet pass must never lose a generated project
    console.error(
      "[Styles] stylesheet pass failed, keeping files as generated:",
      err,
    );
  }

  // Unsplash API rule: setiap kali user "memakai" foto, kita WAJIB hit
  // `download_location` sekali. Fire & forget, jangan sampai gagal-in generate.
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

  return {
    files: finalFiles,
    fixed,
    description: plan.projectDescription,
  };

  return {
    files: finalFiles,
    fixed,
    description: plan.projectDescription,
  };
}

// Revision prompts that talk about images / links / sources ("pakai gambar dari
// url tadi") re-read the URLs shared earlier in the project. Other revisions
// ("ubah warna tombol") skip that, so they stay fast and cheap.
const REFERENCE_HINT_RE =
  /\b(url|link|situs|web|halaman|sumber|source|referensi|reference|gambar|foto|image|asset|picture|photo|logo|banner)/i;

export async function reviseProject(
  prompt,
  manifest,
  relevantFiles,
  recentMessages,
  historyUrls = [],
  uploadedImages = [],
) {
  const uploadedAssets = (uploadedImages || [])
    .filter((img) => img?.url)
    .map((img) => ({
      url: img.url,
      name: img.name || "",
      label: (img.name || "").replace(/\.[^.]+$/, "").trim(),
    }));

  const useHistory = historyUrls.length > 0 && REFERENCE_HINT_RE.test(prompt);
  const {
    context: referenceContext,
    failed: failedReferences,
    assets,
  } = await buildReferenceContext(prompt, useHistory ? historyUrls : [], {
    mirror: mirrorImages,
    extraAssets: uploadedAssets,
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

  // 2. Long URLs inside file contents become short tokens (old-url-NN /
  //    ref-img-NN), so the model never has to copy a 300-char URL into
  //    `search` exactly. Tokens are expanded again after the model answers.
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
    for (const [path, content] of Object.entries(relevantFiles)) {
      contextParts.push(
        `\n### ${path}\n\`\`\`\n${shield.shield(content)}\n\`\`\``,
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

  contextParts.push(`\n## Revision Request\n${prompt}`);

  console.log("[AI] Revising project...");

  const { object: rawParsed } = await generateObjectTracked("revise", {
    model,
    schema: RevisionResultSchema,
    system: REVISE_SYSTEM,
    prompt: contextParts.join("\n"),
    maxRetries: 2,
  });

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
  }
  // The controller needs these when it has to fall back to rewriteFile().
  return { ...rawParsed, referenceContext, assets };
}

// ---------------------------------------------------------------------------
// Fallback for a failed revision.
//
// Search/replace edits written by the model inside JSON are unreliable (newlines
// come back as &#10;, backslashes get dropped, the same declaration gets added
// twice...). When the edits for a file cannot be applied, ask for the COMPLETE
// new file as plain text instead (the same way generateSingleFile works, which
// is reliable) and run it through the same gates before it is saved.
// `deps.generate` exists so the function can be tested without a real model.
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
  );

  const baseMsg =
    `Revision request from the user:\n${prompt}\n\n` +
    `Summary of the intended change (an earlier attempt to apply it as a patch failed):\n${description || "(none)"}\n\n` +
    (draft
      ? `${filePath} is a NEW file. A draft of it was rejected (broken formatting or syntax). The draft:\n\`\`\`\n${shownCurrent}\n\`\`\`\n\n`
      : `Current content of ${filePath}:\n\`\`\`\n${shownCurrent}\n\`\`\`\n\n`) +
    (referenceContext ? `${referenceContext}\n\n` : "") +
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

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text, finishReason, usage } = await generate({
        model,
        system,
        prompt: lastError
          ? `${baseMsg}\n\nYour previous answer was rejected: ${lastError}\nFix that and return the complete file again.`
          : baseMsg,
        maxRetries: 2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
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
