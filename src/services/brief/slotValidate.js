// services/brief/slotValidate.js
//
// Normalisasi + validasi SATU jawaban slot. Tanpa LLM, tanpa I/O.
// Dipakai di dua tempat supaya format yang tersimpan selalu sama:
//   - PATCH /api/briefs/:id  (jawaban user)
//   - classifier             (nilai yang diekstrak dari prompt)
//
// normalizeAnswer(slotDef, raw) -> { ok: true, value } | { ok: false, error }

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

const EMPTY_ERROR = "Jawaban kosong. Pakai tombol Lewati kalau belum ada.";
const PHONE_ERROR = "Nomor tidak valid. Contoh: 0812 3456 7890";
const EMAIL_ERROR = "Email tidak valid. Contoh: nama@email.com";
const HANDLE_ERROR = "Username tidak valid. Contoh: @warkopandre";
const URL_ERROR = "Link tidak valid. Contoh: https://contoh.com";
const PROFESI_ERROR =
  "Itu bukan nama profesi. Contoh: Fullstack Web Dev, UI/UX, Data Analyst";

// Semua karakter kontrol KECUALI \t \n \r (ditangani terpisah di clean()).
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const MULTILINE_KINDS = new Set(["longtext", "list"]);

function clean(raw, multiline) {
  let s = raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_RE, "")
    .replace(/\t/g, " ");

  if (multiline) {
    s = s
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  } else {
    s = s.replace(/\s*\n\s*/g, " ");
  }
  return s.trim();
}

// ─── per kind ────────────────────────────────────────────────────────────────

function normalizeText(s) {
  const v = s.replace(/\s+/g, " ");
  if (v.length > 120) return fail("Terlalu panjang (maks 120 karakter).");
  return ok(v);
}

function normalizeLongtext(slotDef, s) {
  const max = slotDef.key === "isi_artikel" ? 8000 : 1500;
  if (s.length > max) return fail(`Terlalu panjang (maks ${max} karakter).`);
  return ok(s);
}

function normalizeList(slotDef, s) {
  const lines = s
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return fail(EMPTY_ERROR);
  if (lines.length > 30) return fail("Maksimal 30 baris.");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 200) {
      return fail(`Baris ${i + 1} terlalu panjang (maks 200 karakter).`);
    }
    // projects: minimal judul (bagian sebelum "|")
    if (slotDef.key === "projects" && !(line.split("|")[0] ?? "").trim()) {
      return fail(
        `Baris ${i + 1}: judul project wajib ada. Format: Judul | deskripsi | link`,
      );
    }
  }

  const joined = lines.join("\n");
  if (joined.length > 4000) return fail("Terlalu panjang (maks 4000 karakter).");
  return ok(joined);
}

function normalizeChoice(slotDef, s) {
  const options = Array.isArray(slotDef.options) ? slotDef.options : [];
  const hit = options.find((o) => o.toLowerCase() === s.toLowerCase());
  return hit ? ok(hit) : fail("Pilih salah satu opsi");
}

function normalizePhone(s) {
  let d = s.replace(/\D/g, "");
  if (d.startsWith("620")) d = `62${d.slice(3)}`; // "+62 0812..." salah ketik umum
  else if (d.startsWith("62")) d = d;
  else if (d.startsWith("0")) d = `62${d.slice(1)}`;
  else if (d.startsWith("8")) d = `62${d}`;
  else return fail(PHONE_ERROR);

  if (d.length < 10 || d.length > 15) return fail(PHONE_ERROR);
  return ok(d);
}

function normalizeEmail(s) {
  const v = s.toLowerCase();
  if (v.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
    return fail(EMAIL_ERROR);
  }
  return ok(v);
}

function normalizeHandle(s) {
  let h = s;
  const m = h.match(
    /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#\s]+)/i,
  );
  if (m?.[1]) h = m[1];
  h = h.replace(/^@/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(h) ? ok(h) : fail(HANDLE_ERROR);
}

function normalizeUrl(slotDef, s) {
  if (/\s/.test(s)) return fail(URL_ERROR);

  let candidate = s;
  const scheme = candidate.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1] ?? "")) return fail(URL_ERROR);
  } else {
    candidate = `https://${candidate}`;
  }

  let u;
  try {
    u = new URL(candidate);
  } catch {
    return fail(URL_ERROR);
  }

  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) {
    return fail(URL_ERROR);
  }
  if (u.href.length > 300) return fail("Link terlalu panjang (maks 300 karakter).");

  const host = u.hostname.toLowerCase();
  if (slotDef.key === "github" && host !== "github.com" && host !== "www.github.com") {
    return fail("Link harus dari github.com. Contoh: https://github.com/username");
  }
  // titik di depan: "evillinkedin.com" tidak boleh lolos
  if (
    slotDef.key === "linkedin" &&
    host !== "linkedin.com" &&
    !host.endsWith(".linkedin.com")
  ) {
    return fail("Link harus dari linkedin.com. Contoh: https://linkedin.com/in/username");
  }

  return ok(u.href);
}

function byKind(slotDef, s) {
  switch (slotDef.kind) {
    case "text":
      return normalizeText(s);
    case "longtext":
      return normalizeLongtext(slotDef, s);
    case "list":
      return normalizeList(slotDef, s);
    case "choice":
      return normalizeChoice(slotDef, s);
    case "phone":
      return normalizePhone(s);
    case "email":
      return normalizeEmail(s);
    case "handle":
      return normalizeHandle(s);
    case "url":
      return normalizeUrl(slotDef, s);
    default:
      // kind tidak dikenal: jangan simpan apa pun yang tidak bisa divalidasi
      return fail("Jenis isian tidak didukung.");
  }
}

// ─── per key ─────────────────────────────────────────────────────────────────

// Baris/kata yang jelas bukan nama profesi. Heuristik murni, tanpa LLM:
// terlalu sedikit huruf, tanpa vokal, satu huruf diulang, 5+ konsonan beruntun
// ("asdfgh"), atau 5 huruf berurutan di baris keyboard ("qwerty", "asdfg").
// Konsonan beruntun dihitung tanpa "y" supaya "Gym" / "Python" tetap lolos.
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function isKeyboardMash(word) {
  for (let i = 0; i + 5 <= word.length; i++) {
    const chunk = word.slice(i, i + 5);
    if (KEYBOARD_ROWS.some((row) => row.includes(chunk))) return true;
  }
  return false;
}

function looksLikeGibberish(value) {
  const words = value
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  const letters = words.join("");

  if (letters.length < 3) return true;
  if (!/[aeiouy]/.test(letters)) return true;
  if (/^(\p{L})\1*$/u.test(letters)) return true;
  if (/(\p{L})\1{3,}/u.test(letters)) return true;

  return words.some(
    (w) => /[b-df-hj-np-tv-xz]{5,}/.test(w) || (w.length >= 5 && isKeyboardMash(w)),
  );
}

function checkProfesi(value) {
  if (value.length < 3 || value.length > 60) return fail(PROFESI_ERROR);
  if (looksLikeGibberish(value)) return fail(PROFESI_ERROR);
  return ok(value);
}

function checkBrandName(value) {
  if (value.length < 2) return fail("Nama minimal 2 karakter.");
  if (value.length > 60) return fail("Nama terlalu panjang (maks 60 karakter).");
  // bukan hanya angka / simbol
  if (!/\p{L}/u.test(value)) return fail("Nama harus mengandung huruf.");
  return ok(value);
}

// tanggal, waktu, jam_buka: teks bebas, cukup batas panjang dari kind "text".
function byKey(key, value) {
  if (key === "profesi") return checkProfesi(value);
  if (key === "brand_name") return checkBrandName(value);
  return ok(value);
}

// ─── API ─────────────────────────────────────────────────────────────────────

export function normalizeAnswer(slotDef, raw) {
  if (typeof raw !== "string") return fail("Jawaban harus berupa teks.");
  if (!slotDef || typeof slotDef !== "object") return fail("Slot tidak dikenal");

  const s = clean(raw, MULTILINE_KINDS.has(slotDef.kind));
  if (!s) return fail(EMPTY_ERROR);

  const byKindResult = byKind(slotDef, s);
  if (!byKindResult.ok) return byKindResult;

  return byKey(slotDef.key, byKindResult.value);
}