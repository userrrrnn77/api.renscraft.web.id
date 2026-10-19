// worker/ocr.js
//
// Worker terpisah dari server: polling PaymentOrder dengan status "ocr_pending",
// kirim buktinya ke OCR.Space, terus terapkan hasilnya. Jalanin pakai PM2:
//
//   pm2 start worker/ocr.js --name renscraft-ocr
//
// Nggak pakai Redis/BullMQ dulu — polling tiap 5 detik udah cukup buat MVP.
// Worker idempoten: kalau crash di tengah, order tetep "ocr_pending" dan
// bakal di-retry di iterasi berikutnya (asal <10 menit — kalau lebih, di-skip
// biar nggak nyangkut selamanya).

import "dotenv/config";
import { connectToDatabase } from "../src/config/db.js";
import { PaymentOrder } from "../src/models/PaymentOrder.js";
import {
  applyOcrResult,
  expireStaleManualOrders,
} from "../src/services/payments/manualPayment.js";
import { fetch as undiciFetch } from "undici";

const OCR_KEY = process.env.OCRSPACE_KEY;
const POLL_MS = Number(process.env.OCR_POLL_MS) || 5000;
const BATCH = Number(process.env.OCR_BATCH) || 3;
const STALE_MS = 10 * 60 * 1000; // 10 menit
const OCR_TIMEOUT_MS = 30_000;

if (!OCR_KEY) {
  console.error("[OCR worker] OCRSPACE_KEY not set. Exiting.");
  process.exit(1);
}

// ── Download proof dari R2 (URL publik, no signing needed) ──────────────────

async function downloadImage(url) {
  const res = await undiciFetch(url, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`proof fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("empty proof");
  if (buf.length > 6 * 1024 * 1024) throw new Error("proof too large");
  return buf;
}

// ── Kirim ke OCR.Space ──────────────────────────────────────────────────────

// ── Kirim ke OCR.Space — pakai endpoint imageurl ────────────────────────────
//
// Kenapa URL, bukan upload file:
//   - Node native FormData + Blob + undici kadang bikin multipart yang nggak
//     diterima OCR.Space (HTTP 400 tanpa detail)
//   - Bukti udah ada di R2 (public URL), jadi nggak ada alasan download dulu
//   - OCR.Space fetch dari server-nya sendiri, jadi URL harus publik
//
// Kalau R2 lo private, ganti ke metode upload ulang (lihat komentar di bawah).

async function callOcrUrl(imageUrl) {
  const body = new URLSearchParams({
    apikey: OCR_KEY,
    url: imageUrl,
    language: "eng",
    OCREngine: "2",
    isTable: "false",
    scale: "true",
    isOverlayRequired: "false",
  });

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `OCR non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const msg = extractOcrError(data) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (data?.IsErroredOnProcessing) {
    const msg = extractOcrError(data) || "OCR processing error";
    throw new Error(msg);
  }

  const text = data?.ParsedResults?.[0]?.ParsedText;
  if (!text) throw new Error("no ParsedText in OCR response");
  return String(text);
}



// ── Proses 1 order ──────────────────────────────────────────────────────────

const MAX_OCR_ATTEMPTS = 3;

async function processOrder(order) {
  const id = order.orderId;
  const attempts = order.ocrAttempts ?? 0;
  console.log(
    `[OCR] processing ${id} (attempt ${attempts + 1}/${MAX_OCR_ATTEMPTS})`,
  );

  if (!order.proofUrl || !/^https?:\/\//i.test(order.proofUrl)) {
    const msg = "proofUrl missing or not http(s)";
    console.warn(`[OCR] ${id} skipped: ${msg}`);
    await applyOcrResult(id, { error: msg }).catch(() => {});
    return;
  }

  try {
    const text = await callOcrUrl(order.proofUrl);
    const result = await applyOcrResult(id, { text });
    console.log(
      `[OCR] ${id} → ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`,
    );
  } catch (err) {
    const message = err.message || String(err);
    const nextAttempt = attempts + 1;

    await PaymentOrder.updateOne(
      { orderId: id },
      { $inc: { ocrAttempts: 1 } },
    ).catch(() => {});

    if (nextAttempt >= MAX_OCR_ATTEMPTS) {
      console.warn(
        `[OCR] ${id} failed ${nextAttempt}x, → manual_review: ${message}`,
      );
      await applyOcrResult(id, { error: message }).catch(() => {});
    } else {
      console.warn(
        `[OCR] ${id} attempt ${nextAttempt} failed (will retry): ${message}`,
      );
    }
  }
}

// ── Loop utama ──────────────────────────────────────────────────────────────

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const cutoff = new Date(Date.now() - STALE_MS);
    const stale = await PaymentOrder.find({
      method: "manual",
      status: "ocr_pending",
      updatedAt: { $gte: cutoff },
      $or: [{ ocrAttempts: { $exists: false } }, { ocrAttempts: { $lt: 3 } }],
    });

    if (stale.length === 0) {
      // Sekalian sweep expiry tiap kali nggak ada kerjaan
      const expired = await expireStaleManualOrders();
      if (expired > 0)
        console.log(`[OCR] expired ${expired} stale manual order(s)`);
      return;
    }

    await Promise.all(stale.map(processOrder));
  } catch (err) {
    console.error(`[OCR] tick error: ${err.message}`);
  } finally {
    running = false;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  await connectToDatabase();
  console.log(`[OCR worker] started (poll ${POLL_MS}ms, batch ${BATCH})`);
  // Loop rekursif biar nggak overlap
  const loop = async () => {
    await tick();
    setTimeout(loop, POLL_MS).unref?.();
  };
  loop();

  // Graceful shutdown
  const shutdown = () => {
    console.log("[OCR worker] shutting down");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[OCR worker] fatal:", err);
  process.exit(1);
});
