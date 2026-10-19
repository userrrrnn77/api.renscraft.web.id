// scripts/usage-report.mjs

// Ringkasan logs/usage.jsonl: rata-rata biaya asli per generate / revisi.
//   npm run usage:report            (atau: node scripts/usage-report.mjs [file])
// Dipakai untuk mengunci harga kredit pakai data, bukan tebakan.
import fs from "node:fs";

const file = process.argv[2] || process.env.AI_USAGE_LOG || "logs/usage.jsonl";

// Harga per kredit TERENDAH (paket terbesar: Rp100.000 / 310 kredit) = skenario margin terburuk
const CREDITS = { generate: 15, revision: 5 };
const WORST_IDR_PER_CREDIT = 100000 / 310;

if (!fs.existsSync(file)) {
  console.error(`Belum ada ${file}. Jalankan beberapa generate dulu.`);
  process.exit(1);
}

const rows = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
};
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const rp = (n) => `Rp${Math.round(n).toLocaleString("id-ID")}`;
const num = (n) => Math.round(n).toLocaleString("id-ID");

for (const kind of ["generate", "revision"]) {
  const all = rows.filter((r) => r.kind === kind);
  if (!all.length) continue;
  const ok = all.filter((r) => r.ok);
  const idr = all.map((r) => r.idr); // yang gagal tetap dihitung: tokennya tetap dibayar
  const revenue = CREDITS[kind] * WORST_IDR_PER_CREDIT;

  console.log(`\n== ${kind.toUpperCase()} (${all.length} run, ${all.length - ok.length} gagal) ==`);
  console.log(`biaya   : rata-rata ${rp(avg(idr))} | median ${rp(pct(idr, 50))} | p90 ${rp(pct(idr, 90))} | max ${rp(Math.max(...idr))}`);
  console.log(`token   : in ${num(avg(all.map((r) => r.inputTokens)))} | out ${num(avg(all.map((r) => r.outputTokens)))} | panggilan ${avg(all.map((r) => r.calls)).toFixed(1)} (rata-rata)`);
  console.log(`harga   : ${CREDITS[kind]} kredit x ${rp(WORST_IDR_PER_CREDIT)} (paket termurah) = ${rp(revenue)}`);
  console.log(`margin  : ${(revenue / avg(idr)).toFixed(2)}x di rata-rata, ${(revenue / pct(idr, 90)).toFixed(2)}x di p90 (belum kena fee Midtrans)`);
}
if (rows.length < 20) console.log(`\n(baru ${rows.length} baris, idealnya >= 20 biar angkanya stabil)`);
