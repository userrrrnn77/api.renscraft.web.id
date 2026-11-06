// src/utils/referenceUrls.js
// Utilitas kecil untuk mengenali URL halaman (bukan direct image link)
// yang disebut user di prompt.

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)(?:[?#]|$)/i;

const isDirectImageUrl = (u) => IMAGE_EXT_RE.test(u.pathname);

// Hostname lowercase tanpa prefix "www." — dipakai untuk dedup domain remake.
export const hostKey = (input) => {
  try {
    const u = input instanceof URL ? input : new URL(String(input));
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

// URL halaman dari teks bebas. Bukan URL gambar langsung. http(s) saja.
export const pageUrlsOf = (text) => {
  const found = String(text || "").match(URL_RE) || [];
  const cleaned = found.map((u) => u.replace(/[.,;:!?]+$/, ""));
  const unique = [...new Set(cleaned)];
  const pages = [];
  for (const raw of unique) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(u.protocol)) continue;
    if (u.username || u.password) continue;
    if (isDirectImageUrl(u)) continue;
    pages.push(u.href);
  }
  return pages;
};
