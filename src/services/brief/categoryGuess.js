// services/brief/categoryGuess.js
//
// Tebakan kategori TANPA LLM, dari kata kunci di `hint` tiap kategori
// (slotCatalog.js) + beberapa varian ejaan di EXTRA_PHRASES.
//
// Perannya jaring pengaman, bukan pengganti classifier:
//   1. brief awal (status "classifying") langsung tampil di kategori yang masuk akal
//   2. classifier gagal / timeout -> fallback tidak selalu "lainnya"
//   3. penengah waktu confidence model rendah
//
// Return id kategori, atau null kalau tidak ada kata kunci yang cocok / seri.
import { CATEGORIES } from "./slotCatalog.js";

// Varian yang tidak ada di hint. Tambah sendiri kalau nemu prompt yang meleset.
const EXTRA_PHRASES = {
  portfolio: ["portofolio", "personal website"],
  kuliner: ["kafe", "resto", "rumah makan", "warung makan"],
  toko_produk: ["online shop", "olshop", "toko baju"],
  brosur: ["company profile"],
  event: ["undangan", "wedding"],
};

const norm = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// "warkop, cafe / toko kue" -> ["warkop", "cafe", "toko kue"]
const phrasesOf = (c) =>
  [...String(c.hint).split(/[,/]/), ...(EXTRA_PHRASES[c.id] ?? [])]
    .map(norm)
    .filter((p) => p.length >= 3);

const INDEX = CATEGORIES.filter((c) => c.id !== "lainnya").map((c) => ({
  id: c.id,
  phrases: phrasesOf(c),
}));

// Skor = total panjang frasa yang cocok (per kata utuh), jadi frasa panjang
// menang: "warung sembako" (toko_produk) > "warung" (kuliner).
export function guessCategory(prompt) {
  const text = ` ${norm(prompt)} `;
  let best = null;
  let bestScore = 0;
  let tie = false;

  for (const { id, phrases } of INDEX) {
    let score = 0;
    for (const p of phrases) if (text.includes(` ${p} `)) score += p.length;
    if (score > bestScore) {
      best = id;
      bestScore = score;
      tie = false;
    } else if (score > 0 && score === bestScore) {
      tie = true;
    }
  }
  return best && !tie ? best : null;
}
