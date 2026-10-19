// src/services/imageGuard.js
//
// Dulu file ini punya dua pekerjaan:
//   1. render pool ID Unsplash untuk prompt
//   2. tukar foto Unsplash yang gak nyambung sama domain bisnis
//
// Keduanya sudah tidak dipakai. Model sekarang generate URL LoremFlickr
// dinamis per item (lihat prompts.js section 7), jadi:
//   - tidak ada lagi "pool ID yang harus dihafal model"
//   - tidak ada lagi mismatch nama menu ↔ foto
//
// File ini dipertahankan sebagai no-op supaya import di ai.js
// (`import { fixOffTopicImages } from "./imageGuard.js"`) tidak perlu diubah.

// No-op: mengembalikan kode apa adanya. Selalu kosong dari swap.
export function fixOffTopicImages(code /* , { prompt, filePath } = {} */) {
  return { code, swapped: [] };
}