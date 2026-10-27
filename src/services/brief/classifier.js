// services/brief/classifier.js
//
// Layer 1: SATU panggilan model. Membaca prompt user, lalu MERANCANG daftar
// pertanyaan wizard yang spesifik untuk website itu — bukan memilih dari
// daftar pertanyaan static.
//
// Perbedaan dengan versi sebelumnya:
// - dulu: pilih kategori + ekstrak nilai slot dari katalog static.
// - sekarang: pilih kategori, EKSTRAK nilai yang sudah ada di prompt, DAN
//   RANCANG daftar slot yang paling relevan untuk bisnis/project ini.
//
// Katalog static (SLOTS, CATEGORIES) tetap ada, tapi perannya berubah: jadi
// "vocabulary hint" untuk model, bukan sumber kebenaran pertanyaan.
import { z } from "zod";
import { generateObjectTracked, fastModel, FAST_MODEL_NAME } from "../ai.js";
import { briefConfig } from "./briefConfig.js";
import { normalizeAnswer } from "./slotValidate.js";
import {
  CATEGORIES,
  CATEGORY_IDS,
  SLOTS,
  VIBE_OPTIONS,
  categorySlots,
  EXTRA_KEY_RE,
} from "./slotCatalog.js";
import { guessCategory } from "./categoryGuess.js";

const SlotKindSchema = z.enum([
  "text",
  "longtext",
  "list",
  "choice",
  "phone",
  "email",
  "handle",
  "url",
]);

const ComposedSlotSchema = z.object({
  key: z.string(),
  label: z.string(),
  question: z.string(),
  kind: SlotKindSchema,
  group: z.enum(["fact", "style"]).default("fact"),
  placeholder: z.string().default(""),
  options: z.array(z.string()).default([]),
  // Dipakai untuk override contract.facts (businessName, address, phone, ...).
  // Hanya untuk kategori yang butuh; kalau tidak, kosongkan.
  mapsTo: z.string().nullable().optional(),
});

const ComposerSchema = z.object({
  category: z.enum([...CATEGORY_IDS]),
  confidence: z.number().min(0).max(1),
  // Nilai yang sudah user tulis eksplisit di prompt (opsional, dict biasa).
  extracted: z.record(z.string(), z.string()).default({}),
  // Rancangan pertanyaan: 3-8 slot, selalu diawali brand_name dan diakhiri vibe.
  slots: z.array(ComposedSlotSchema).min(1).max(10),
});

// Vocabulary referensi: model boleh pakai key ini kalau cocok (biar placeholder
// & validasi katalog tetap konsisten) atau bikin key x_* kalau butuh sesuatu
// yang tidak ada di katalog.
function buildVocabulary() {
  const lines = [];
  for (const cat of CATEGORIES) {
    if (!cat.slots?.length) continue;
    const items = cat.slots.map((k) => {
      const s = SLOTS[k];
      return `\`${k}\` (${s.label}, ${s.kind})`;
    });
    lines.push(`- ${cat.id} (${cat.label}): ${items.join(", ")}`);
  }
  return lines.join("\n");
}

function buildCategoryHints() {
  return CATEGORIES.map((c) => `- ${c.id}: ${c.label} — ${c.hint}`).join("\n");
}

function buildSystem() {
  return `Kamu adalah PERANCANG BRIEF website. Baca prompt user, lalu RANCANG daftar pertanyaan wizard yang SPESIFIK untuk website itu.

Bukan daftar pertanyaan generik. Pikirkan: untuk JENIS bisnis/project INI, data apa yang WAJIB diisi user supaya hasil generate terasa REAL, bukan template AI?

## Cara berpikir (WAJIB diikuti)

Sebelum menulis output, analisis dulu (tidak perlu ditulis di output):
1. Ini website tentang apa? Siapa target audiensnya?
2. Kalau website ini jadi, apa yang bikin terasa "ini beneran bisnis X" bukan template AI?
3. Data apa yang hanya user yang bisa jawab (bukan yang bisa dikarang AI: tagline, deskripsi umum, judul section)?
4. Data apa yang mesti diisi supaya link/CTA berfungsi (WA, email, IG)?

## Contoh reasoning

Prompt: "bikinin web untuk warkop andre"
→ Kategori: kuliner
→ Untuk warkop, yang penting: nama (sudah ada), menu andalan + harga, jam operasional (warkop biasanya buka malam), daerah/lokasi, kontak WA. Tambahan yang bikin beda: cerita singkat di balik warkop → section About jadi hidup.
→ Output:
  - brand_name (dari prompt: "Warkop Andre")
  - menu: "Menu apa saja + harganya?" kind: list
  - jam_buka: "Jam buka dan tutupnya?" kind: text
  - x_lokasi_daerah: "Warkopnya di daerah mana?" kind: text
  - whatsapp: "Nomor WA untuk pesan antar?" kind: phone
  - x_cerita_unik: "Ada cerita unik di balik warkop ini?" kind: longtext
  - vibe: kind: choice

Prompt: "portfolio fullstack developer, nama saya Rendy"
→ Kategori: portfolio
→ Yang penting: nama (ada), role/tagline, tech stack, project unggulan, klien. Tambahan: pengalaman klien buat "social proof".
→ Output: brand_name, profesi, tech_stack (list), projects (list), x_pengalaman_klien (list), email, vibe

Prompt: "undangan pernikahan Rina & Dimas"
→ Kategori: event
→ Yang penting: nama pasangan (ada), tanggal, lokasi, RSVP. Tambahan: love story → section khas undangan modern.
→ Output: brand_name, tanggal, address, rsvp, x_love_story (longtext), vibe

## ATURAN KHUSUS URL (SANGAT PENTING)
Jika prompt user menyertakan URL (misal: "buat ini lebih menarik: https://..."), sistem backend akan otomatis melakukan scraping data dari URL tersebut (teks, gambar, design tokens).
OLEH KARENA ITU:
- JANGAN buat slot/pertanyaan untuk menanyakan data fakta (nama, profesi, bio, email, nomor telepon, alamat, project, dll) karena sistem sudah mengambilnya dari URL tersebut.
- ANGGAP SEMUA DATA FAKTA SUDAH ADA DI URL TERSEBUT.
- Hanya buat slot 'vibe' (gaya tampilan) atau slot 'x_' (jika user memberikan instruksi spesifik yang tidak ada di web).
- Jika user HANYA memberikan URL tanpa instruksi tambahan, cukup buat 1 slot saja: 'vibe'.

## ATURAN KERAS

1. **Maksimal 6 slot total** (termasuk brand_name & vibe). Idealnya 4-5.
2. **brand_name SELALU** jadi slot pertama. Label menyesuaikan konteks: "Nama warkop", "Nama lengkap", "Nama kedua mempelai".
3. **vibe SELALU** jadi slot terakhir. kind: "choice", group: "style", options: ${JSON.stringify(VIBE_OPTIONS)}.
4. **Maksimal 4 slot fakta tambahan** (selain brand_name). Kalau 2-3 cukup, jangan tambah 4.

### MUST-HAVE vs NICE-TO-HAVE — WAJIB DIBEDAKAN

**Must-have** = TANPA data ini website GAK BERFUNGSI atau kelihatan BOHONG:
- brand_name (SELALU)
- Kontak utama (whatsapp / email / rsvp) — kalau ada CTA
- Menu / produk / layanan — kalau itu katalog
- Alamat / lokasi — kalau bisnis fisik
- Jam buka — kalau bisnis fisik
- Tanggal / acara — kalau event

**Nice-to-have** = bikin website lebih kaya TAPI AI bisa generate copywriting sendiri:
- Cerita unik / profil panjang / about singkat
- Pengalaman klien / testimoni
- Bio panjang (kecuali portfolio yang butuh)
- Tagline (selalu copywriting AI)
- Best seller (bisa ditebak dari urutan menu)
- Promo (opsional)
- Cara order (bisa ditulis AI dari konteks)
- Area kirim / area layanan (kalau gak disebut, AI bisa generate placeholder netral)

**ATURAN MUST-HAVE:**
- **HANYA masukkan must-have ke slots[]. Nice-to-have JANGAN dijadikan pertanyaan.**
- **Kalau user SUDAH nyebut must-have di prompt**, TETAP masukkan sebagai slot (biar nilainya ke-extract lewat 'extracted'), tapi **JANGAN tambahin must-have lain yang GAK disebut** cuma karena "biasanya perlu".
- Kalau ragu, ANGGAP NICE-TO-HAVE dan jangan masukkan.

**Contoh konkret:**
Prompt: "warung sembako putra 58, jual beras gula minyak, buka 8-5, wa 08123456789, di jl merdeka bandung"
→ Semua must-have udah disebut. Nice-to-have (cara_order, area_kirim, instagram) JANGAN dijadikan slot.
→ Output:
  - brand_name (extracted: "Putra 58")
  - produk (extracted: "beras\ngula\nminyak")
  - jam_buka (extracted: "8-5")
  - whatsapp (extracted: "08123456789")
  - address (extracted: "Jl. Merdeka, Bandung")
  - vibe
→ questionKeys KOSONG. Jangan tambah x_cara_order, x_area_kirim, atau instagram.

Prompt: "toko kue, jual brownies dan cookies"
→ Must-have: produk (ada). Nice-to-have: harga, cara_order, area_kirim, promo — JANGAN jadi slot.
→ Output:
  - brand_name (extracted: "Toko Kue")
  - produk (extracted: "brownies\ncookies")
  - whatsapp
  - vibe
→ Sisa pertanyaan: whatsapp (kalau gak disebut) + vibe. Harga & cara_order di-generate AI.

5. **Kalau vocabulary punya key yang cocok, pakai key itu** (mis. menu, jam_buka, address, whatsapp, email). Biar placeholder & validasi katalog berlaku.
6. **Kalau butuh sesuatu yang tidak ada di vocabulary, bikin key x_**: lowercase, huruf/angka/underscore, 3-30 char, diawali x_. Set origin-nya implicit "ai".
7. **Label**: 2-5 kata, singkat. Contoh bagus: "Menu & harga", "Klien yang pernah kerja bareng". Contoh jelek: "Daftar item menu makanan beserta harga masing-masing".
8. **Question**: Bahasa Indonesia yang natural, jangan kaku-formal. Boleh ada hint di dalam kurung. Contoh: "Menu apa saja + harganya? (satu per baris: Nama - harga)".
9. **Kind**:
   - text = 1 baris pendek (nama, jam, profesi)
   - longtext = paragraf (alamat lengkap, cerita, bio)
   - list = beberapa baris (menu, produk, project, klien). SELALU tambahkan hint format di question dalam tanda kurung.
   - choice = pilihan terbatas (vibe). WAJIB isi options.
   - phone = nomor WA/telepon
   - email = email
   - handle = username sosial (IG)
   - url = link (GitHub, LinkedIn, website)
10. **placeholder**: kalau user skip, placeholder ini yang tampil. Natural, jelas. Contoh: "Alamat belum diisi", "Menu akan tampil di sini". Kalau memang lebih baik elemennya dihilangkan (mis. promo opsional), kosongkan ("") — nanti sistem hilangkan section-nya.
11. **mapsTo**: isi HANYA kalau slot ini adalah salah satu dari: businessName, address, phone, email, openingHours, tagline, city, foundedYear. Dipakai override contract.facts. Kalau tidak yakin, biarkan null.
12. **extracted**: nilai yang sudah user tulis eksplisit di prompt. Salin apa adanya (jangan mengarang, jangan menerjemahkan). Kalau tidak yakin nilainya ada, jangan masukkan. Kunci extracted harus ada juga di slots[].
13. **confidence** 0..1: seberapa yakin kategori & rancangan ini.
14. **Kategori tanpa slot** (app_tool, dashboard): slots cukup [brand_name, vibe] atau bahkan [brand_name] aja. User tinggal langsung generate.

## Kategori (untuk labeling)

${buildCategoryHints()}

## Vocabulary referensi (boleh dipakai, boleh tidak)

${buildVocabulary()}

## Output JSON

{
  "category": "<id>",
  "confidence": 0.9,
  "extracted": { "<key>": "<nilai dari prompt>" },
  "slots": [
    { "key": "brand_name", "label": "...", "question": "...", "kind": "text", "group": "fact", "placeholder": "..." },
    { "key": "x_sesuatu", "label": "...", "question": "...", "kind": "list", "group": "fact", "placeholder": "..." },
    { "key": "vibe", "label": "Gaya tampilan", "question": "Mau nuansanya gimana?", "kind": "choice", "group": "style", "options": ${JSON.stringify(VIBE_OPTIONS)} }
  ]
}
- "warung sembako", "toko kelontong", "toko bahan pokok" → toko_produk
  (BUKAN kuliner, karena jual barang bukan makanan siap saji)  
`;
}

// ── Evidence check (sama seperti sebelumnya) ────────────────────────────────

const normText = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/[@"'`]/g, "")
    .trim();

const stripUrl = (s) =>
  normText(s)
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "");

const loose = (s) =>
  normText(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

function hasEvidence(slotDef, value, prompt) {
  const p = normText(prompt);
  switch (slotDef.kind) {
    case "phone": {
      const runs = prompt.replace(/[\s.\-()+]/g, "").match(/\d+/g) ?? [];
      const tail = value.replace(/\D/g, "").slice(-9);
      return tail.length === 9 && runs.some((r) => r.includes(tail));
    }
    case "choice":
      return (slotDef.options ?? []).includes(value);
    case "list":
    case "longtext": {
      const pl = loose(prompt);
      const lines = value.split("\n").map(loose).filter(Boolean);
      return lines.length > 0 && lines.every((l) => pl.includes(l));
    }
    case "url": {
      const v = stripUrl(value);
      return v.length > 0 && stripUrl(prompt).includes(v);
    }
    default: {
      const v = loose(value);
      const pl = loose(prompt);
      if (v && pl.includes(v)) return true;
      const vNoSpace = v.replace(/\s+/g, "");
      return vNoSpace.length >= 3 && pl.replace(/\s+/g, "").includes(vNoSpace);
    }
  }
}

// ── Post-processing ────────────────────────────────────────────────────────

// Cek apakah key berasal dari katalog (untuk menentukan origin & map otomatis).
const CATALOG_KEYS = new Set(Object.keys(SLOTS));

function cleanSlots(rawSlots, extracted, prompt) {
  const out = [];
  const seen = new Set();

  for (const s of rawSlots) {
    const key = String(s.key ?? "").trim();
    const label = String(s.label ?? "").trim();
    const question = String(s.question ?? "").trim();
    if (!key || !label || !question) continue;
    if (seen.has(key)) continue;

    // Kalau key custom, harus lolos EXTRA_KEY_RE. Kalau catalog key, OK.
    const isCatalog = CATALOG_KEYS.has(key);
    if (!isCatalog && !EXTRA_KEY_RE.test(key)) continue;

    const isVibe = key === "vibe";
    const kind = isVibe ? "choice" : s.kind;
    const group = isVibe || s.group === "style" ? "style" : "fact";
    const placeholder = String(s.placeholder ?? "")
      .trim()
      .slice(0, 120);
    // vibe: opsi SELALU dari kode, jangan percaya output composer
    const options = isVibe
      ? VIBE_OPTIONS
      : kind === "choice" && Array.isArray(s.options) && s.options.length > 0
        ? s.options
            .map((o) => String(o).trim())
            .filter(Boolean)
            .slice(0, 10)
        : kind === "choice"
          ? VIBE_OPTIONS
          : [];

    seen.add(key);
    out.push({
      key,
      label: label.slice(0, 60),
      question: question.slice(0, 200),
      kind,
      group,
      placeholder,
      options: [...options],
      origin: isCatalog ? "catalog" : "ai",
      mapsTo:
        typeof s.mapsTo === "string" && s.mapsTo.length > 0 ? s.mapsTo : null,
    });
  }

  // Pastikan brand_name & vibe ada di depan/belakang.
  if (!out.some((s) => s.key === "brand_name")) {
    out.unshift({
      key: "brand_name",
      label: "Nama brand / judul",
      question: "Nama website atau brand-nya apa?",
      kind: "text",
      group: "fact",
      placeholder: "Nama Brand",
      options: [],
      origin: "catalog",
      mapsTo: "businessName",
    });
  }
  if (!out.some((s) => s.key === "vibe")) {
    out.push({
      key: "vibe",
      label: "Gaya tampilan",
      question: "Mau nuansanya gimana?",
      kind: "choice",
      group: "style",
      placeholder: "",
      options: [...VIBE_OPTIONS],
      origin: "catalog",
      mapsTo: null,
    });
  }

  return out;
}

// Nilai extracted yang lolos normalisasi + evidence check → answers awal.
function cleanExtracted(slots, extracted, prompt) {
  const answers = {};
  for (const [key, raw] of Object.entries(extracted)) {
    const def = slots.find((s) => s.key === key);
    if (!def) continue;
    const norm = normalizeAnswer(def, String(raw));
    if (!norm.ok) continue;
    if (!hasEvidence(def, norm.value, prompt)) continue;
    answers[key] = { value: norm.value, source: "prompt" };
  }
  return answers;
}

// B2: pure resolver. Kept exported so the table can be checked without a model.
export function resolveCategory({
  modelCategory,
  confidence,
  keywordGuess,
  minConfidence,
}) {
  // (1) Model said "lainnya" but keywords clearly point somewhere.
  if (modelCategory === "lainnya" && keywordGuess) return keywordGuess;
  // (2) Model is confident: trust it.
  if (confidence >= minConfidence) return modelCategory;
  // (3) Low confidence, keywords disagree with the model: use keywords.
  if (keywordGuess && keywordGuess !== modelCategory) return keywordGuess;
  // (4) Low confidence, no keyword evidence: trust the model.
  return modelCategory;
}

// B2: generic fallback. Only injected when category is "lainnya" and the
// composed slots contain no fact slot besides brand_name.
const DEFAULT_BRAND_NAME_SLOT = {
  key: "brand_name",
  label: "Nama brand / judul",
  question: "Nama website atau brand-nya apa?",
  kind: "text",
  group: "fact",
  placeholder: "Nama Brand",
  options: [],
  mapsTo: "businessName",
};

const DEFAULT_VIBE_SLOT = {
  key: "vibe",
  label: "Gaya tampilan",
  question: "Mau nuansanya gimana?",
  kind: "choice",
  group: "style",
  placeholder: "",
  options: [...VIBE_OPTIONS],
  mapsTo: null,
};

function injectGenericFallback(category, rawSlots) {
  if (category !== "lainnya") return rawSlots;
  const slots = Array.isArray(rawSlots) ? rawSlots : [];
  const hasFactSlot = slots.some((s) => {
    const group = s.group ?? "fact";
    return group !== "style" && s.key !== "brand_name";
  });
  if (hasFactSlot) return slots;

  const brandName =
    slots.find((s) => s.key === "brand_name") ?? DEFAULT_BRAND_NAME_SLOT;
  const vibe = slots.find((s) => s.key === "vibe") ?? DEFAULT_VIBE_SLOT;
  const middle = slots.filter((s) => s !== brandName && s !== vibe);

  return [
    brandName,
    {
      key: "whatsapp",
      label: "WhatsApp",
      question: "Nomor WA untuk dihubungi?",
      kind: "phone",
      group: "fact",
      placeholder: "Nomor WhatsApp belum diisi",
      options: [],
      mapsTo: "phone",
    },
    {
      key: "address",
      label: "Alamat",
      question: "Alamat lengkapnya di mana?",
      kind: "longtext",
      group: "fact",
      placeholder: "Alamat belum diisi",
      options: [],
      mapsTo: "address",
    },
    ...middle,
    vibe,
  ];
}

// ── API ─────────────────────────────────────────────────────────────────────

export async function classifyPrompt(prompt) {
  const cfg = briefConfig();

  // C3: brief is a "small call", use the fast model when configured.
  const { object } = await generateObjectTracked("brief", {
    model: fastModel,
    modelName: FAST_MODEL_NAME || undefined,
    schema: ComposerSchema,
    system: buildSystem(),
    prompt: `Prompt user:\n"""\n${prompt.slice(0, 2000)}\n"""`,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(cfg.classifyTimeoutMs),
  });

  const guess = guessCategory(prompt);
  const category = resolveCategory({
    modelCategory: object.category,
    confidence: object.confidence,
    keywordGuess: guess,
    minConfidence: cfg.minConfidence,
  });

  console.log(
    `[Brief] classify raw: model=${object.category} conf=${object.confidence} keyword=${guess ?? "-"} -> category=${category}`,
  );

  const rawSlots = injectGenericFallback(category, object.slots);
  const slots = cleanSlots(rawSlots, object.extracted, prompt);
  const answers = cleanExtracted(slots, object.extracted, prompt);

  return { category, confidence: object.confidence, slots, answers };
}
