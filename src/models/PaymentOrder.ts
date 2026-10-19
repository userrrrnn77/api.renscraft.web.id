// src/models/PaymentOrder.ts

import mongoose, { Schema, type Types } from "mongoose";

// Status untuk dua flow:
//  - Midtrans (otomatis): pending → challenge → paid / failed / expired / canceled
//  - Manual transfer (semi-auto): pending_manual → ocr_pending → waiting_approval → paid
//    atau manual_review → manual_rejected
export const PAYMENT_STATUSES = [
  // Midtrans
  "pending",
  "challenge",
  "paid",
  "failed",
  "expired",
  "canceled",
  "refunded",
  "chargeback",
  // Manual transfer
  "pending_manual", // user belum upload bukti
  "ocr_pending", // bukti ke-upload, worker lagi OCR
  "waiting_approval", // OCR lulus, admin tinggal approve
  "manual_review", // OCR gagal / ada mismatch, admin harus cek manual
  "manual_rejected", // admin tolak
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface ILastMidtransStatus {
  transaction_status?: string;
  fraud_status?: string;
  status_code?: string;
  payment_type?: string;
  settlement_time?: string;
}

export interface IPaymentOrder {
  orderId: string;
  owner: Types.ObjectId;
  packageId: string;
  credits: number;
  amount: number;
  status: PaymentStatus;
  credited: boolean;
  clawedBack: number;
  clawbackShortfall: number;
  clawbackAt?: Date;

  // Midtrans
  snapToken?: string;
  redirectUrl?: string;
  paymentType?: string;
  transactionId?: string;
  lastMidtransStatus?: ILastMidtransStatus;

  // ── Manual transfer ────────────────────────────────────────────────────
  method: "midtrans" | "manual";
  // Nominal unik buat order manual (mis. 50123). User WAJIB TF tepat sejumlah
  // ini, jadi screenshot yang di-edit ke nominal bulat (50000) bakal ditolak.
  expectedAmount?: number;
  // Bukti transfer user
  proofUrl?: string;
  proofHash?: string; // sha256 buffer → anti-reuse gambar yang sama
  proofUploadedAt?: Date;
  manualName?: string; // nama lengkap user di form
  manualBank?: string; // bank asal user
  // Hasil OCR
  ocrText?: string;
  ocrAmount?: number; // nominal paling relevan yang ke-extract
  ocrAllAmounts?: number[]; // semua nominal yang ketemu di screenshot
  ocrDate?: string; // date string apa adanya dari OCR (info buat admin)
  ocrProcessedAt?: Date;
  ocrError?: string; // kalau OCR sendiri gagal (API down, dll)
  // Admin review
  reviewedAt?: Date;
  reviewedBy?: string; // label admin
  rejectReason?: string;

  ocrAttempts: number;

  flag?: string;
  expiresAt: Date;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const integer = {
  validator: Number.isInteger,
  message: "must be an integer",
};

const PaymentOrderSchema = new Schema<IPaymentOrder>(
  {
    orderId: { type: String, required: true, unique: true, maxlength: 50 },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    packageId: { type: String, required: true },
    credits: { type: Number, required: true, min: 1, validate: integer },
    amount: { type: Number, required: true, min: 1, validate: integer },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "pending",
      required: true,
    },
    credited: { type: Boolean, default: false },
    clawedBack: { type: Number, default: 0, min: 0, validate: integer },
    clawbackShortfall: { type: Number, default: 0, min: 0, validate: integer },
    clawbackAt: { type: Date },

    // Midtrans
    snapToken: { type: String },
    redirectUrl: { type: String },
    paymentType: { type: String },
    transactionId: { type: String },
    lastMidtransStatus: { type: Schema.Types.Mixed },

    // Manual
    method: {
      type: String,
      enum: ["midtrans", "manual"],
      default: "midtrans",
      required: true,
    },
    expectedAmount: { type: Number, min: 1, validate: integer },
    proofUrl: { type: String },
    proofHash: { type: String },
    proofUploadedAt: { type: Date },
    manualName: { type: String, maxlength: 120 },
    manualBank: { type: String, maxlength: 60 },
    ocrText: { type: String, maxlength: 4000 },
    ocrAmount: { type: Number },
    ocrAllAmounts: { type: [Number], default: [] },
    ocrDate: { type: String, maxlength: 60 },
    ocrProcessedAt: { type: Date },
    ocrError: { type: String, maxlength: 300 },
    reviewedAt: { type: Date },
    reviewedBy: { type: String, maxlength: 60 },
    rejectReason: { type: String, maxlength: 300 },
    ocrAttempts: { type: Number, default: 0 },

    flag: { type: String },
    expiresAt: { type: Date, required: true },
    paidAt: { type: Date },
  },
  { timestamps: true },
);

PaymentOrderSchema.index({ owner: 1, createdAt: -1 });
PaymentOrderSchema.index({ status: 1, createdAt: 1 });
// Worker OCR polling: cari order yang perlu diproses
PaymentOrderSchema.index({ status: 1, method: 1, updatedAt: 1 });
// Anti-reuse: satu gambar bukti cuma boleh dipakai sekali
PaymentOrderSchema.index({ proofHash: 1 }, { unique: true, sparse: true });

export const PaymentOrder = mongoose.model<IPaymentOrder>(
  "PaymentOrder",
  PaymentOrderSchema,
);
