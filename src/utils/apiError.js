// src/utils/apiError.js
//
// Satu-satunya cara controller mengirim error ke client.
//
// Bentuk respons:
//   { error: string, code: string, params?: object }
//
//   error  = teks fallback (English). Client lama / bahasa yang belum
//            didukung tetap bisa nampilin sesuatu.
//   code   = dipakai client buat translate lewat locales/*.json key
//            `errors.<code>`. Ini yang jadi sumber kebenaran.
//   params = nilai dinamis buat interpolasi, mis. { required: 12, have: 3 }.
//            Cuma dikirim kalau ada isinya.
//
// Aturan: JANGAN pernah kirim pesan yang mengandung nama host, nama
// collection, query string, atau stack trace. Untuk error tak terduga
// (DB down, bug), pakai kode generik + log detailnya di server.

export const fail = (res, status, code, params = {}, fallback = code) => {
  const body = { error: fallback, code };
  if (params && Object.keys(params).length > 0) body.params = params;
  return res.status(status).json(body);
};

// Katalog kode (dokumentasi, tidak dipakai runtime).
//
// ── Auth ────────────────────────────────────────────────────────────────────
// AUTH_INVALID_CREDENTIALS      | 400/401 | email/password salah, atau input login invalid
// AUTH_EMAIL_EXISTS             | 400     | email sudah terdaftar (local register)
// AUTH_NOT_AUTHENTICATED        | 401     | tidak ada token / token hilang
// AUTH_SESSION_EXPIRED          | 401     | token invalid / expired
// AUTH_USER_NOT_FOUND           | 404     | user di token sudah tidak ada di DB
// AUTH_SUPABASE_NOT_CONFIGURED  | 503     | SUPABASE_URL / ANON_KEY belum diisi
// AUTH_SUPABASE_INVALID_TOKEN   | 401     | access token Supabase ditolak
// AUTH_SUPABASE_OAUTH_ONLY      | 403     | bukan Google/GitHub
// AUTH_SUPABASE_NO_EMAIL        | 400     | Supabase tidak kasih email
// AUTH_EMAIL_ACCOUNT_EXISTS     | 409     | email dipakai akun lain (local), auto-link dimatikan
//
// ── Admin ───────────────────────────────────────────────────────────────────
// ADMIN_NOT_CONFIGURED          | 503
// ADMIN_INVALID_CREDENTIALS     | 401
// ADMIN_TOO_MANY_ATTEMPTS       | 429
// ADMIN_REQUIRED                | 401
// ADMIN_SESSION_EXPIRED         | 401
// ADMIN_INVALID_USER_ID         | 400
// ADMIN_INVALID_AMOUNT          | 400
// ADMIN_USER_NOT_FOUND          | 404
// ADMIN_ORDER_NOT_FOUND         | 404
// ADMIN_ORDER_NOT_PENDING       | 409
// ADMIN_USER_MISSING            | 410
// ADMIN_APPROVE_FAILED          | 400
// ADMIN_ORDER_NOT_REVIEW        | 409
// ADMIN_REASON_REQUIRED         | 400
// ADMIN_ORDER_ID_REQUIRED       | 400
//
// ── Credits ─────────────────────────────────────────────────────────────────
// INSUFFICIENT_CREDITS          | 402 | params { required, credits }
// ACCOUNT_NOT_FOUND             | 401
//
// ── Projects ────────────────────────────────────────────────────────────────
// PROJECT_NOT_FOUND             | 404
// PROJECT_PROMPT_REQUIRED       | 400
// PROJECT_PROMPT_TOO_LONG       | 400 | params { max }
// PROJECT_TOO_MANY_ACTIVE       | 429
// PROJECT_BUSY                  | 409
// PROJECT_FILES_INVALID         | 400
// PROJECT_TOO_MANY_FILES        | 400 | params { max }
// PROJECT_FILE_PATH_INVALID     | 400 | params { path }
// PROJECT_FILE_TOO_LARGE        | 400 | params { path }
// PROJECT_TOO_LARGE             | 400
// PROJECT_PUBLISH_NAME_TAKEN    | 409
// PROJECT_PUBLISH_NOT_COMPLETED | 409
// PROJECT_PUBLIC_NOT_AVAILABLE  | 404
// PROJECT_IMAGE_R2_MISSING      | 503
// PROJECT_IMAGE_EMPTY           | 400
// PROJECT_IMAGE_TOO_LARGE       | 413 | params { max }
// PROJECT_IMAGE_UNSUPPORTED     | 400
// PROJECT_IMAGE_UPLOAD_FAILED   | 502
// PROJECT_IMAGE_URL_REQUIRED    | 400
// PROJECT_BRIEF_NOT_FOUND       | 404
// PROJECT_BRIEF_USED            | 409
//
// ── Brief ───────────────────────────────────────────────────────────────────
// BRIEF_PROMPT_REQUIRED         | 400
// BRIEF_PROMPT_TOO_LONG         | 400 | params { max }
// BRIEF_TOO_MANY_ATTEMPTS       | 429
// BRIEF_NOT_FOUND               | 404
// BRIEF_ANSWERS_INVALID         | 400
// BRIEF_TOO_MANY_ANSWERS        | 400 | params { max }
// BRIEF_UNKNOWN_CATEGORY        | 400
//
// ── Chat / revision ─────────────────────────────────────────────────────────
// CHAT_PROMPT_REQUIRED          | 400
// CHAT_PROMPT_TOO_LONG          | 400 | params { max }
// CHAT_FAILED                   | 500
//
// ── Payments (Midtrans) ─────────────────────────────────────────────────────
// PAYMENTS_DISABLED             | 503
// PAYMENTS_NOT_AUTHENTICATED    | 401
// PAYMENTS_UNKNOWN_PACKAGE      | 400
// PAYMENTS_ACCOUNT_NOT_FOUND    | 401
// PAYMENTS_TOO_MANY_PENDING     | 429
// PAYMENTS_TOO_MANY_ATTEMPTS    | 429
// PAYMENTS_GATEWAY_DOWN         | 502
// PAYMENTS_INVALID_NOTIFICATION | 400
// PAYMENTS_INVALID_SIGNATURE    | 403
// PAYMENTS_UNKNOWN_ORDER        | 404
// PAYMENTS_ORDER_NOT_FOUND      | 404
// PAYMENTS_STATUS_UNAVAILABLE   | 503
// PAYMENTS_TEMP_ERROR           | 503
//
// ── Manual payment ──────────────────────────────────────────────────────────
// MANUAL_DISABLED               | 503
// MANUAL_NOT_AUTHENTICATED      | 401
// MANUAL_STORAGE_NOT_CONFIGURED | 503
// MANUAL_ORDER_ID_REQUIRED      | 400
// MANUAL_EMPTY_IMAGE            | 400
// MANUAL_PROOF_TOO_LARGE        | 413 | params { max }
// MANUAL_PROOF_INVALID_TYPE     | 400
// MANUAL_NAME_BANK_REQUIRED     | 400
// MANUAL_UPLOAD_FAILED          | 502
// MANUAL_ORDER_NOT_FOUND        | 404
// MANUAL_ORDER_WRONG_STATUS     | 409
// MANUAL_PROOF_DUPLICATE        | 409
// MANUAL_ATTACH_FAILED          | 400
// MANUAL_TOO_MANY_ACTIVE        | 429
// MANUAL_UNKNOWN_PACKAGE        | 400
// MANUAL_ACCOUNT_NOT_FOUND      | 401
//
// ── Generic ─────────────────────────────────────────────────────────────────
// INTERNAL_ERROR                | 500
// RATE_LIMITED                  | 429
// BAD_REQUEST                   | 400
//
// ── Project.errorCode (disimpan di DB, bukan HTTP body) ─────────────────────
// GENERATION_FAILED
// GENERATION_TIMEOUT
// REVISION_TIMEOUT
// REVISION_NO_CHANGE
// NO_APP_JS