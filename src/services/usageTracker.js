// src/services/usageTracker.js
// Catat token dan estimasi biaya (Rp) tiap generate / revisi, supaya harga
// kredit bisa dikunci pakai angka asli, bukan tebakan.
//
// Cara kerja: withUsageTracking("generate", fn) membuka satu "catatan" untuk
// seluruh pekerjaan di dalam fn (termasuk panggilan model paralel), lewat
// AsyncLocalStorage, jadi tidak ada parameter tambahan di fungsi mana pun.
// recordUsage(label, usage) dipanggil setelah tiap panggilan model. Saat fn
// selesai (sukses ATAU gagal, karena generate yang gagal tetap memakan token),
// satu baris ringkasan dicetak dan ditambahkan ke logs/usage.jsonl.
//
// Harga (USD per 1 juta token) dan kurs diatur lewat env, default = harga
// Nemotron 3 Ultra di provider berbayar:
//   AI_PRICE_IN_PER_M=0.50  AI_PRICE_OUT_PER_M=2.20  USD_IDR=16500
//   AI_USAGE_LOG=logs/usage.jsonl   (isi "off" untuk mematikan file log)
// Selama masih di endpoint gratis NVIDIA, angkanya "biaya andai bayar".
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";

const als = new AsyncLocalStorage();

const num = (v) => (Number.isFinite(v) ? v : 0);

export const getPricing = (env = process.env) => ({
  inPerM: Number(env.AI_PRICE_IN_PER_M) || 0.5,
  outPerM: Number(env.AI_PRICE_OUT_PER_M) || 2.2,
  usdIdr: Number(env.USD_IDR) || 16500,
});

// C3: optional fast-model pricing.
const getFastPricing = (env = process.env) => {
  const inPerM = Number(env.AI_FAST_PRICE_IN_PER_M);
  const outPerM = Number(env.AI_FAST_PRICE_OUT_PER_M);
  if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) return null;
  return { inPerM, outPerM };
};

// Ringkas semua panggilan model dalam satu catatan.
export function summarize(store, pricing = getPricing()) {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  const byLabel = {};
  let usd = 0;

  const fastPricing = getFastPricing();
  const fastModelName = process.env.AI_MODEL_FAST || null;

  for (const c of store.calls) {
    inputTokens += c.in;
    outputTokens += c.out;
    reasoningTokens += c.reasoning;
    // "file /App.js" dengan n=2 artinya file itu diulang (retry)
    const key = c.label;
    const slot = (byLabel[key] ||= { n: 0, in: 0, out: 0 });
    slot.n++;
    slot.in += c.in;
    slot.out += c.out;

    // C3: per-model pricing. A call recorded with `model` equal to the fast
    // model name uses fast pricing when configured; everything else uses the
    // default pricing.
    const useFast =
      fastPricing !== null &&
      fastModelName !== null &&
      c.model === fastModelName;
    const inPerM = useFast ? fastPricing.inPerM : pricing.inPerM;
    const outPerM = useFast ? fastPricing.outPerM : pricing.outPerM;
    usd += (c.in * inPerM + c.out * outPerM) / 1_000_000;
  }

  return {
    ts: new Date(store.start).toISOString(),
    kind: store.kind,
    ok: store.ok,
    ...(store.error ? { error: String(store.error).slice(0, 200) } : {}),
    ...store.meta,
    calls: store.calls.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    usd: Number(usd.toFixed(5)),
    idr: Math.round(usd * pricing.usdIdr),
    ms: store.end - store.start,
    pricing,
    byLabel,
  };
}

const fmt = (n) => Math.round(n).toLocaleString("id-ID");

export const formatLine = (s) =>
  `[Usage] ${s.kind} ${s.ok ? "ok" : "FAILED"}: ${s.calls} calls | in ${fmt(s.inputTokens)} | out ${fmt(s.outputTokens)}` +
  (s.reasoningTokens ? ` (reasoning ${fmt(s.reasoningTokens)})` : "") +
  ` | ~$${s.usd.toFixed(3)} = Rp${fmt(s.idr)} | ${Math.round(s.ms / 1000)}s`;

// Cetak ke konsol + tambahkan satu baris JSON ke file. Tidak pernah throw.
const defaultSink = async (summary) => {
  console.log(formatLine(summary));

  const file = process.env.AI_USAGE_LOG ?? "logs/usage.jsonl";
  if (file === "off" || process.env.NODE_TEST_CONTEXT) return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(summary)}\n`);
  } catch (err) {
    console.warn(`[Usage] could not write ${file}: ${err.message}`);
  }
};

// Jalankan fn dengan satu catatan pemakaian. Kalau sudah ada catatan aktif
// (mis. controller membungkus reviseProject + rewriteFile sekaligus), fn ikut
// mencatat ke catatan luar itu dan tidak membuat baris baru.
export async function withUsageTracking(
  kind,
  fn,
  meta = {},
  { sink = defaultSink, pricing } = {},
) {
  if (als.getStore()) return fn();

  const store = {
    kind,
    meta: { model: process.env.NVIDIA_MODEL, ...meta },
    calls: [],
    ok: true,
    error: null,
    start: Date.now(),
    end: 0,
  };

  try {
    return await als.run(store, fn);
  } catch (err) {
    store.ok = false;
    store.error = err?.message ?? String(err);
    throw err;
  } finally {
    store.end = Date.now();
    if (store.calls.length > 0) {
      try {
        await sink(summarize(store, pricing ?? getPricing()));
      } catch (err) {
        console.warn(`[Usage] sink failed: ${err.message}`);
      }
    }
  }
}

// Panggil tepat setelah tiap panggilan model. `usage` = objek usage dari AI SDK.
// Aman dipanggil di luar withUsageTracking (tidak melakukan apa-apa).
// `modelName` dipakai C3 untuk per-model pricing; setiap field usage.jsonl
// yang sudah ada tetap dipertahankan.
export function recordUsage(label, usage, modelName = null) {
  const store = als.getStore();
  if (!store || !usage) return;
  store.calls.push({
    label,
    in: num(usage.inputTokens),
    out: num(usage.outputTokens),
    reasoning: num(usage.outputTokenDetails?.reasoningTokens),
    model: modelName ?? null,
  });
}

// Untuk handler yang menangkap error sendiri (mis. chatController): tandai
// catatan aktif sebagai gagal walaupun fn tidak throw.
export function markUsageFailed(err) {
  const store = als.getStore();
  if (!store) return;
  store.ok = false;
  store.error = err?.message ?? String(err ?? "failed");
}
