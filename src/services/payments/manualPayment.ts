// src/services/payments/manualPayment.ts

// Manual-transfer flow (semi-auto):
//   1. user pilih paket → kita bikin order dengan nominal UNIK (mis. 50123)
//   2. user TF tepat 50123 + upload bukti
//   3. worker OCR baca bukti → cocokin dengan expectedAmount
//   4. kalau cocok, masuk ke admin queue (waiting_approval) → admin klik approve
//
// Attacker harus tau nominal unik + TF beneran. Fake screenshot nominal 50000
// bakal ditolak (mismatch). Reuse screenshot bakal ditolak (proofHash unique).
import crypto from "node:crypto";
import { PaymentOrder } from "../../models/PaymentOrder.js";
import type { IPaymentOrder } from "../../models/PaymentOrder.js";
import { finishCredit } from "./paymentService.js";
import { notifyAdmin } from "../../config/ws.js";

// ── Nominal unik ────────────────────────────────────────────────────────────

const UNIQUE_SUFFIX_MAX = 999;

// Cari suffix 1-999 yang belum dipakai oleh order pending_manual aktif.
// Retry max 5x; kalau gagal semua, lempar error (kemungkinan besar ada
// ratusan order pending sekaligus — di luar skala MVP).
export async function generateUniqueAmount(
  baseAmount: number,
): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const suffix = Math.floor(Math.random() * UNIQUE_SUFFIX_MAX) + 1;
    const candidate = baseAmount + suffix;
    const exists = await PaymentOrder.exists({
      method: "manual",
      expectedAmount: candidate,
      status: {
        $in: [
          "pending_manual",
          "ocr_pending",
          "waiting_approval",
          "manual_review",
        ],
      },
    });
    if (!exists) return candidate;
  }
  throw new Error(
    "Could not allocate a unique amount (too many pending orders)",
  );
}

// ── Parser OCR ──────────────────────────────────────────────────────────────

// Buang non-digit, tapi hati-hati sama format Indonesia:
//   "50.123"      → 50123
//   "50.123,00"   → 50123
//   "50,123.00"   → 50123
//   "Rp 50.000"   → 50000
// Balikin null kalau angka terlalu panjang (>10 digit, kemungkinan tanggal/
// gabungan) atau kosong.
export function parseIdrAmount(raw: string): number | null {
  let s = String(raw).replace(/\s/g, "");
  if (!s) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  let intPart = s;
  if (lastDot > -1 && lastComma > -1) {
    // Dua-duanya ada. Yang di kanan = desimal.
    intPart = lastDot > lastComma ? s.slice(0, lastDot) : s.slice(0, lastComma);
  } else if (lastDot > -1) {
    const after = s.length - lastDot - 1;
    // 3 digit setelah titik → titik = pemisah ribuan
    intPart = after === 3 ? s.replace(/\./g, "") : s.slice(0, lastDot);
  } else if (lastComma > -1) {
    const after = s.length - lastComma - 1;
    intPart = after === 3 ? s.replace(/,/g, "") : s.slice(0, lastComma);
  }

  const digits = intPart.replace(/\D/g, "");
  if (!digits || digits.length > 10) return null;
  const n = parseInt(digits, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// Extract semua nominal bergaya "Rp 50.123" atau "IDR 50.123" dari teks OCR.
// Balikin array unik.
const AMOUNT_RE = /(?:Rp\.?|IDR)\s*([\d][\d.,]*)/gi;

export function extractAmounts(text: string): number[] {
  const out = new Set<number>();
  for (const m of String(text).matchAll(AMOUNT_RE)) {
    const n = parseIdrAmount(m[1] ?? "");
    if (n !== null) out.add(n);
  }
  return [...out];
}

// Cari tanggal format umum di teks OCR — info doang buat admin, bukan buat
// gating. Return string apa adanya kalau ketemu.
const DATE_RE =
  /\b(\d{1,2}[\s/-][A-Za-z]{3,9}[\s/-]\d{2,4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/;

export function extractDate(text: string): string | null {
  const m = String(text).match(DATE_RE);
  return m?.[1] ?? null;
}
// ── Create order ────────────────────────────────────────────────────────────

interface PackageInfo {
  id: string;
  credits: number;
  amount: number;
}

const ORDER_TTL_HOURS = 24;
const ORDER_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/1/O/I

function generateOrderId(): string {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const bytes = crypto.randomBytes(12); // ← 9 → 12
  let rand = "";
  for (let i = 0; i < 12; i++) {
    // ← 9 → 12
    const b = bytes[i] ?? 0;
    rand += ORDER_ID_CHARS[b % ORDER_ID_CHARS.length] ?? "X";
  }
  return `RSC-${yy}${mm}${dd}-${rand}`;
}

export async function createManualOrder(
  ownerId: string,
  pkg: PackageInfo,
  now: Date = new Date(),
): Promise<IPaymentOrder> {
  const expectedAmount = await generateUniqueAmount(pkg.amount);
  const expiresAt = new Date(now.getTime() + ORDER_TTL_HOURS * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await PaymentOrder.create({
        orderId: generateOrderId(),
        owner: ownerId,
        packageId: pkg.id,
        credits: pkg.credits,
        amount: pkg.amount,
        expectedAmount,
        method: "manual",
        status: "pending_manual",
        expiresAt,
      });
    } catch (err) {
      const isDup =
        typeof err === "object" &&
        err !== null &&
        (err as { code?: unknown }).code === 11000;
      if (attempt >= 2 || !isDup) throw err;
    }
  }
  throw new Error("Failed to create order");
}

// ── Attach proof (upload bukti) ─────────────────────────────────────────────

export interface AttachProofInput {
  orderId: string;
  ownerId: string;
  proofUrl: string;
  proofBuffer: Buffer;
  manualName: string;
  manualBank: string;
}

export type AttachProofResult =
  | { ok: true; order: IPaymentOrder }
  | { ok: false; reason: "not_found" | "wrong_status" | "duplicate_proof" };

export async function attachProof({
  orderId,
  ownerId,
  proofUrl,
  proofBuffer,
  manualName,
  manualBank,
}: AttachProofInput): Promise<AttachProofResult> {
  const proofHash = crypto
    .createHash("sha256")
    .update(proofBuffer)
    .digest("hex");

  // Unique index di proofHash → kalau gambar yang sama pernah ke-upload
  // (untuk order manapun), ini bakal throw duplicate key.
  try {
    const order = await PaymentOrder.findOneAndUpdate(
      {
        orderId,
        owner: ownerId,
        method: "manual",
        status: "pending_manual",
      },
      {
        $set: {
          proofUrl,
          proofHash,
          proofUploadedAt: new Date(),
          manualName: manualName.slice(0, 120),
          manualBank: manualBank.slice(0, 60),
          status: "ocr_pending",
        },
      },
      { returnDocument: "after" },
    );
    if (!order) {
      const exists = await PaymentOrder.exists({ orderId, owner: ownerId });
      return { ok: false, reason: exists ? "wrong_status" : "not_found" };
    }

    if (order) {
      // KIRIM NOTIF KE ADMIN DI SINI
      notifyAdmin({
        type: "MANUAL_PAYMENT",
        title: "Pesanan Manual Baru! 💸",
        message: `Order ${orderId.slice(-6)}: User udah upload bukti transfer. Cek dashboard!`,
      });
    }
    return { ok: true, order };
  } catch (err) {
    const isDup =
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === 11000;
    if (isDup) return { ok: false, reason: "duplicate_proof" };
    throw err;
  }
}

// ── OCR result processing (dipanggil worker) ────────────────────────────────

export interface OcrProcessResult {
  outcome: "waiting_approval" | "manual_review" | "stale";
  reason?: string;
}

export async function applyOcrResult(
  orderId: string,
  ocr: {
    text?: string;
    error?: string;
  },
): Promise<OcrProcessResult> {
  const order = await PaymentOrder.findOne({
    orderId,
    method: "manual",
    status: "ocr_pending",
  });
  if (!order) return { outcome: "stale" };

  const now = new Date();

  // Kalau OCR API sendiri gagal → manual review, jangan auto reject.
  if (ocr.error || !ocr.text) {
    await PaymentOrder.updateOne(
      { _id: order._id, status: "ocr_pending" },
      {
        $set: {
          status: "manual_review",
          ocrProcessedAt: now,
          ocrError: (ocr.error || "empty OCR text").slice(0, 300),
          flag: "ocr_failed",
        },
      },
    );
    return { outcome: "manual_review", reason: "ocr_failed" };
  }

  const amounts = extractAmounts(ocr.text);
  const dateStr = extractDate(ocr.text) ?? undefined;
  const matched =
    order.expectedAmount !== undefined &&
    amounts.includes(order.expectedAmount);

  if (matched) {
    await PaymentOrder.updateOne(
      { _id: order._id, status: "ocr_pending" },
      {
        $set: {
          status: "waiting_approval",
          ocrProcessedAt: now,
          ocrText: ocr.text.slice(0, 4000),
          ocrAmount: order.expectedAmount,
          ocrAllAmounts: amounts,
          ocrDate: dateStr,
        },
      },
    );
    return { outcome: "waiting_approval" };
  }

  await PaymentOrder.updateOne(
    { _id: order._id, status: "ocr_pending" },
    {
      $set: {
        status: "manual_review",
        ocrProcessedAt: now,
        ocrText: ocr.text.slice(0, 4000),
        ocrAmount: amounts[0] ?? null,
        ocrAllAmounts: amounts,
        ocrDate: dateStr,
        flag: "amount_mismatch",
      },
    },
  );
  return { outcome: "manual_review", reason: "amount_mismatch" };
}

// ── Admin decisions ─────────────────────────────────────────────────────────

export interface AdminDecisionResult {
  ok: boolean;
  reason?: string;
  order?: IPaymentOrder;
}

export async function approveManualOrder(
  orderId: string,
  adminLabel: string,
): Promise<AdminDecisionResult> {
  const now = new Date();

  const claimed = await PaymentOrder.findOneAndUpdate(
    {
      orderId,
      method: "manual",
      status: { $in: ["waiting_approval", "manual_review"] },
      credited: false,
    },
    {
      $set: {
        status: "paid",
        paidAt: now,
        reviewedAt: now,
        reviewedBy: adminLabel.slice(0, 60),
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return { ok: false, reason: "not_pending" };

  // Credit lewat jalur yang sama dengan Midtrans, biar ledger + flag
  // credited konsisten. Kalau gagal, jangan revert — admin bisa retry.
  const result = await finishCredit(claimed);
  if (result === "no_user") {
    return { ok: false, reason: "user_missing", order: claimed };
  }

  return { ok: true, order: claimed };
}

export async function rejectManualOrder(
  orderId: string,
  adminLabel: string,
  reason: string,
): Promise<AdminDecisionResult> {
  const order = await PaymentOrder.findOneAndUpdate(
    {
      orderId,
      method: "manual",
      status: { $in: ["waiting_approval", "manual_review"] },
    },
    {
      $set: {
        status: "manual_rejected",
        reviewedAt: new Date(),
        reviewedBy: adminLabel.slice(0, 60),
        rejectReason: String(reason || "Rejected by admin").slice(0, 300),
      },
    },
    { returnDocument: "after" },
  );
  if (!order) return { ok: false, reason: "not_pending" };
  return { ok: true, order };
}

// ── Expiry sweep (dipanggil worker) ─────────────────────────────────────────

export async function expireStaleManualOrders(): Promise<number> {
  const res = await PaymentOrder.updateMany(
    {
      method: "manual",
      status: { $in: ["pending_manual", "ocr_pending"] },
      expiresAt: { $lt: new Date() },
    },
    { $set: { status: "expired" } },
  );
  return res.modifiedCount ?? 0;
}
