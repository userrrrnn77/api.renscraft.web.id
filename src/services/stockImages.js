// src/services/stockImages.js
//
// Foto stok Unsplash per-item (menu, produk, layanan) untuk jalur revisi.
// Alur: LLM kelompokkan item -> 1 search per kelompok -> tiap foto dilabeli
// dengan NAMA ITEM -> masuk "Available images" sebagai token ref-img-NN.

import { z } from "zod";

const API = "https://api.unsplash.com";
const UTM = "utm_source=renscraft&utm_medium=referral";
const MAX_GROUPS = 6;
const MAX_ITEMS = 24;
const MAX_ITEMS_PER_GROUP = 12;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 200;

export const ImageGroupsSchema = z.object({
  groups: z.array(
    z.object({
      query: z.string(),
      items: z.array(z.string()),
    }),
  ),
});

export const IMAGE_GROUPS_SYSTEM = `You choose stock-photo search queries for website cards.
You receive the user's request and the current source code of a React site.
1. Find every card/item that should get a photo (menu items, products, services, portfolio pieces). Use the item's EXACT name as written in the code.
2. Group items that can share one search (e.g. "Latte", "Cappuccino", "Mocha" -> "latte art coffee"). At most ${MAX_GROUPS} groups, at most ${MAX_ITEMS_PER_GROUP} items per group, at most ${MAX_ITEMS} items in total.
3. query: English, 2-4 words, a concrete visible subject a photographer would tag (e.g. "iced matcha latte", "chocolate milkshake", "coffee jelly dessert"). No brand names, no people, no vague words like "beautiful".
4. Skip things that are not physical items (prices, categories, buttons, headings).`;

// files: { "/components/Menu.js": "code...", ... }
export function buildImageGroupsPrompt(message, files) {
  let budget = 14000;
  const parts = [];
  for (const [path, code] of Object.entries(files || {})) {
    if (budget <= 0) break;
    const text = String(code || "").slice(0, budget);
    budget -= text.length;
    parts.push(`### ${path}\n${text}`);
  }
  return `User request: ${message}\n\nCode:\n${parts.join("\n\n")}`;
}

const WANTS_IMAGES =
  /\b(gambar|foto|photo|photos|image|images|picture|pictures|pic|pics|ilustrasi|thumbnail)\b/i;
const REMOVES_IMAGES =
  /\b(hapus|hilangkan|buang|remove|delete|tanpa|without)\b[^.\n]{0,30}\b(gambar|foto|image|images|photo|photos)\b/i;

export function wantsImages(message) {
  const text = String(message || "");
  return WANTS_IMAGES.test(text) && !REMOVES_IMAGES.test(text);
}

// ── search + cache ──────────────────────────────────────────────────────────
const cache = new Map(); // key -> { at, photos }

async function searchPhotos(query, perPage, orientation) {
  const key = `${query.toLowerCase()}|${perPage}|${orientation}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.photos;

  const res = await fetch(
    `${API}/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}&content_filter=high`,
    {
      headers: {
        Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
        "Accept-Version": "v1",
      },
    },
  );
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    console.log(`[Unsplash] rate limit remaining: ${remaining}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const photos = (data.results || []).filter((p) => p?.urls?.small);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), photos });
  return photos;
}

function normalizeGroups(groups) {
  const seen = new Set();
  let total = 0;
  const out = [];
  for (const g of (groups || []).slice(0, MAX_GROUPS)) {
    const query = String(g?.query || "")
      .trim()
      .slice(0, 60);
    if (!query) continue;
    const items = [];
    for (const raw of (g.items || []).slice(0, MAX_ITEMS_PER_GROUP)) {
      const name = String(raw || "")
        .trim()
        .slice(0, 80);
      const k = name.toLowerCase();
      if (!name || seen.has(k) || total >= MAX_ITEMS) continue;
      seen.add(k);
      items.push(name);
      total++;
    }
    if (items.length) out.push({ query, items });
  }
  return out;
}

// groups: [{ query, items: ["Americano", "Latte"] }]
// return: { assets, missing } — assets bentuknya sama dengan searchUnsplash()
// di ai.js, tapi label = nama item (bukan alt_description Unsplash).
export async function fetchItemPhotos(groups) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return { assets: [], missing: [] };

  const clean = normalizeGroups(groups);
  const settled = await Promise.allSettled(
    clean.map((g) =>
      searchPhotos(g.query, Math.min(30, g.items.length + 3), "squarish"),
    ),
  );

  const usedIds = new Set(); // satu foto cuma boleh dipakai satu item
  const assets = [];
  const missing = [];

  clean.forEach((g, i) => {
    const r = settled[i];
    if (r.status !== "fulfilled") {
      console.warn(
        `[Unsplash] query "${g.query}" failed: ${r.reason?.message}`,
      );
      missing.push(...g.items);
      return;
    }
    const pool = r.value.filter((p) => !usedIds.has(p.id));
    for (const item of g.items) {
      const photo = pool.shift();
      if (!photo) {
        missing.push(item);
        continue;
      }
      usedIds.add(photo.id);
      assets.push({
        url: photo.urls.small,
        name: item,
        label: item,
        source: "unsplash",
        photographer: photo.user?.name || "Unknown",
        photographerUrl: photo.user?.links?.html
          ? `${photo.user.links.html}?${UTM}`
          : `https://unsplash.com/?${UTM}`,
        photoUrl: `${photo.links?.html}?${UTM}`,
        downloadLocation: photo.links?.download_location,
      });
    }
  });

  return { assets, missing };
}

// Unsplash API rule: trigger download untuk foto yang BENAR-BENAR dipakai.
// `code` = gabungan kode file hasil revisi (sesudah token di-expand jadi URL).
export async function triggerDownloads(assets, code = "") {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return 0;

  const used = (assets || []).filter((a) => {
    if (a?.source !== "unsplash" || !a.downloadLocation) return false;
    if (!code) return true;
    try {
      return code.includes(new URL(a.url).pathname);
    } catch {
      return true;
    }
  });

  const results = await Promise.allSettled(
    used.map((a) =>
      fetch(a.downloadLocation, {
        headers: { Authorization: `Client-ID ${key}` },
      }),
    ),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  console.log(
    `[Unsplash] triggered download for ${ok}/${used.length} photo(s)`,
  );
  return ok;
}

// ── Credits (deterministik, bukan tugas LLM) ────────────────────────────────
const CREDITS_PATH = "/components/PhotoCredits.js";
const CREDITS_IMPORT = `import PhotoCredits from "./components/PhotoCredits";`;

function renderCreditsFile(list) {
  return `import React from "react";

// Dibuat otomatis oleh server (Unsplash API Guidelines: credit fotografer + Unsplash).
// Daftar ini diperbarui tiap kali foto Unsplash ditambahkan lewat revisi.
const CREDITS = ${JSON.stringify(list)};

export default function PhotoCredits() {
  if (!CREDITS.length) return null;
  return (
    <p className="mx-auto max-w-6xl px-4 py-4 text-center text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
      Photos on{" "}
      <a href="https://unsplash.com/?${UTM}" target="_blank" rel="noopener noreferrer" className="underline">Unsplash</a>
      {": "}
      {CREDITS.map((c, i) => (
        <span key={c.name}>
          {i > 0 ? ", " : ""}
          <a href={c.url} target="_blank" rel="noopener noreferrer" className="underline">{c.name}</a>
        </span>
      ))}
    </p>
  );
}
`;
}

function readExistingCredits(code) {
  const m = /const CREDITS = (\[[\s\S]*?\]);/.exec(code || "");
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.filter((c) => c?.name && c?.url) : [];
  } catch {
    return [];
  }
}

// files: { "/App.js": "code", ... } (string content)
// Return: { files, changed } — `changed` = path yang dibuat / diubah.
export function ensureUnsplashCredits(files, assets) {
  const stock = (assets || []).filter(
    (a) => a?.source === "unsplash" && a.photographer,
  );
  if (!stock.length) return { files, changed: [] };

  // Hanya foto yang beneran dipakai di kode final.
  const code = Object.entries(files)
    .filter(([p]) => p !== CREDITS_PATH)
    .map(([, c]) => String(c || ""))
    .join("\n");
  const used = stock.filter((a) => {
    try {
      return code.includes(new URL(a.url).pathname);
    } catch {
      return false;
    }
  });
  if (!used.length) return { files, changed: [] };

  // Gabung dengan credit lama (revisi sebelumnya) supaya nggak hilang.
  const merged = new Map();
  for (const c of readExistingCredits(files[CREDITS_PATH])) {
    merged.set(c.name, c);
  }
  for (const a of used) {
    merged.set(a.photographer, {
      name: a.photographer,
      url: a.photographerUrl || `https://unsplash.com/?${UTM}`,
    });
  }

  const result = { ...files };
  const changed = [];

  const next = renderCreditsFile([...merged.values()]);
  if (files[CREDITS_PATH] !== next) {
    result[CREDITS_PATH] = next;
    changed.push(CREDITS_PATH);
  }

  // Sambungkan ke App.js: import di atas, <PhotoCredits /> tepat sebelum <Footer.
  const app = files["/App.js"];
  if (typeof app === "string" && !/PhotoCredits/.test(app)) {
    const idx = app.search(/<Footer\b/);
    if (idx !== -1) {
      const lineStart = app.lastIndexOf("\n", idx) + 1;
      const indent = (/^[ \t]*/.exec(app.slice(lineStart, idx)) || [""])[0];
      result["/App.js"] =
        CREDITS_IMPORT +
        "\n" +
        app.slice(0, idx) +
        `<PhotoCredits />\n${indent}` +
        app.slice(idx);
      changed.push("/App.js");
    } else {
      console.warn(
        "[Unsplash] credits: <Footer> not found in /App.js, PhotoCredits not wired",
      );
    }
  }

  return { files: result, changed };
}
