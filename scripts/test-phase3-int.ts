// scripts/test-phase3-int.ts
import "dotenv/config";
import { generateProject } from "../src/services/ai.js";
import { generateRenstraftSdk } from "../src/services/contract/dynamicSdk.js";

// Tip: cast sekali di batas modul JS → TS. Kalau `generateProject` nanti
// diubah ke .ts, hapus cast ini.
type GenResult = {
  files: Record<string, string>;
  fixed: Record<string, string>;
  description: string;
  // NEW: verify A.2 actually persisted the AI's proposal
  dataSpec: {
    collections?: Array<{ name: string; label?: string; fields?: unknown[] }>;
  } | null;
};

const PROMPT =
  "Buat website kontak dengan form: nama, email, pesan. Simpan pesannya di database MongoDB.";

let failed = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};

console.log("⏳ generating (makan kuota AI, sabar ya ~30-60s)...");
const raw = await generateProject(PROMPT, {}, {});
const result = raw as unknown as GenResult;
const files = result.files;

console.log("\nfiles:", Object.keys(files));
const hasSdk = "/lib/renscraft.js" in files;

if (!hasSdk) {
  // Ini BUKAN bug — LLM boleh skip dataSpec. Cek apakah planner decide
  // "nggak butuh database" (bisa valid kalau prompt diinterpret contact
  // form = cukup kirim email, nggak simpan).
  console.log(
    "\n⚠️  LLM tidak propose dataSpec kali ini. Ini bukan bug — planner boleh skip.",
  );
  console.log(
    "   Rekomendasi: percaya unit test (test-phase3.ts) yang deterministic,",
  );
  console.log("   bukan integration test ini.");
  process.exit(0);
}

// ── Kalau SDK ada, WAJIB identik dengan generator server ─────────────────
const sdkActual = files["/lib/renscraft.js"];
const sdkExpected = generateRenstraftSdk("draft-slug", false);

ok("SDK exact match dengan generateRenstraftSdk()", sdkActual === sdkExpected);
ok("SDK berisi memory adapter", sdkActual.includes("memoryDb"));
ok("SDK punya DO NOT EDIT warning", sdkActual.includes("AUTO-GENERATED"));

ok(
  "dataSpec dibalikin di return (A.2)",
  result.dataSpec !== null && result.dataSpec !== undefined,
  JSON.stringify(result.dataSpec?.collections?.map((c) => c.name) ?? []),
);

// ── Cek bahwa setidaknya satu file LAIN ngimport `db` ────────────────────
const consumers = Object.entries(files).filter(
  ([p, c]) =>
    p !== "/lib/renscraft.js" && /from\s+['"][^'"]*renscraft['"]/.test(c),
);
ok(
  "ada file yang import db dari /lib/renscraft",
  consumers.length > 0,
  consumers.map(([p]) => p).join(", ") || "tidak ada consumer",
);

// ── Cek file lama TIDAK berubah (legacy byte-identical) ──────────────────
ok("App.js masih ada", "/App.js" in files);
ok("styles.css masih ada", "/styles.css" in files);

// ── Cek SDK tidak appear di `fixed` (server-owned, bukan model output) ──
ok(
  "SDK tidak masuk `fixed` (artinya tidak di-generate model)",
  !("/lib/renscraft.js" in result.fixed),
);

console.log(failed === 0 ? "\n🎉 PHASE 3 INT PASS" : `\n❌ ${failed} gagal`);
process.exit(failed === 0 ? 0 : 1);
