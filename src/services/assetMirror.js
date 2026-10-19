// src/services/assetMirror.js

// Gambar dari situs referensi (mis. Google Sites) sering ditolak browser (403)
// dan URL-nya berisi token yang berubah tiap request. Solusinya: SAAT referensi
// dibaca, server mengunduh gambarnya, mengunggahnya ke Cloudflare R2, dan
// website memakai URL permanen R2 itu.
//
// Key R2 = sha256 dari ISI gambar (bukan dari URL), jadi:
//   - gambar yang sama selalu dapat URL yang sama, walau token Google berubah
//   - revisi project berikutnya menghasilkan URL yang persis sama (url shield
//     dan `search` di file tetap cocok)
import crypto from "node:crypto";
import pMap from "p-map";
import { fetchImage } from "./webReference.js";
import { getPublicUrl, isR2Configured, uploadObject } from "../utils/s3.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 5;

// Hanya raster. SVG sengaja tidak disalin (bisa memuat script kalau dibuka
// langsung); SVG tetap memakai URL aslinya.
const EXT_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export const objectKeyFor = (buffer, contentType) => {
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) return null;
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return `reference/${hash}.${ext}`;
};

// Dependency injection supaya bisa dites tanpa internet dan tanpa R2
export function createMirror({
  fetchImage,
  upload,
  publicUrl,
  isConfigured = () => true,
  // URL yang sudah permanen di domain kita sendiri tidak perlu diunduh ulang
  isOwnUrl = () => false,
}) {
  // Mengembalikan array URL dengan panjang yang sama dengan `urls`:
  // URL R2 kalau berhasil, URL asli kalau gagal (jadi tidak lebih buruk dari
  // sebelumnya).
  return async function mirrorImages(urls, referers = []) {
    if (urls.length === 0) return [];

    if (!isConfigured()) {
      console.warn(
        "[AssetMirror] R2 belum dikonfigurasi (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL): gambar memakai URL asli",
      );
      return urls;
    }

    let mirrored = 0;
    let own = 0;

    const result = await pMap(
      urls,
      async (url, i) => {
        if (isOwnUrl(url)) {
          own++;
          return url;
        }
        try {
          const { buffer, contentType } = await fetchImage(
            url,
            MAX_IMAGE_BYTES,
            referers[i],
          );
          if (!buffer?.length) throw new Error("empty response");

          const key = objectKeyFor(buffer, contentType);
          if (!key) throw new Error(`unsupported type ${contentType}`);

          await upload(key, buffer, contentType);
          mirrored++;
          return publicUrl(key);
        } catch (err) {
          console.warn(
            `[AssetMirror] not mirrored (${err.message}): ${url.slice(0, 90)}`,
          );
          return url;
        }
      },
      { concurrency: CONCURRENCY },
    );

    console.log(
      `[AssetMirror] ${mirrored}/${urls.length} images mirrored` +
        (own ? `, ${own} already on our own domain` : ""),
    );
    return result;
  };
}

// R2_PUBLIC_URL + host tambahan di MIRROR_SKIP_HOSTS (pisah koma), mis. domain
// portfolio sendiri yang gambarnya sudah permanen.
export const isOwnUrl = (url) => {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }

  // Unsplash wajib hotlink per API Guidelines — jangan pernah di-mirror ke R2.
  if (host === "images.unsplash.com") return true;

  const own = new Set(
    String(process.env.MIRROR_SKIP_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  try {
    if (process.env.R2_PUBLIC_URL)
      own.add(new URL(process.env.R2_PUBLIC_URL).host.toLowerCase());
  } catch {
    // R2_PUBLIC_URL tidak valid: abaikan
  }
  return own.has(host);
};

export const mirrorImages = createMirror({
  fetchImage,
  upload: uploadObject,
  publicUrl: getPublicUrl,
  isConfigured: isR2Configured,
  isOwnUrl,
});
