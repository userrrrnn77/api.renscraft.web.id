// services/brief/briefConfig.js
//
// Env BRIEF_* dibaca lewat satu tempat. Gaya sama dengan intEnv di credits.ts:
// angka tidak valid -> default. Nol juga dianggap tidak valid (timeout 0 atau
// TTL 0 hanya akan merusak fitur, bukan mematikannya).

const intEnv = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ratioEnv = (name, fallback) => {
  const n = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

// Dibaca lazy (fungsi, bukan konstanta) supaya dotenv sudah jalan dan env
// bisa diubah saat tes.
export const briefConfig = () => ({
  maxPerHour: intEnv("BRIEF_MAX_PER_HOUR", 20),
  ttlHours: intEnv("BRIEF_TTL_HOURS", 24),
  classifyTimeoutMs: intEnv("BRIEF_CLASSIFY_TIMEOUT_MS", 45000),
  minConfidence: ratioEnv("BRIEF_MIN_CONFIDENCE", 0.5),
});
