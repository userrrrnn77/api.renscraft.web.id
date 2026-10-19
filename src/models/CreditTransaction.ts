// src/models/CreditTransaction.ts

import mongoose, { Schema, type Types } from "mongoose";

// Append-only ledger of credit movements that come from payments.
// `key` is the idempotency key (purchase:<orderId>, clawback:<orderId>): inserting
// the same key twice fails the unique index, and that failure means "already done".
//
// Rows are never updated or deleted. Only "purchase" and "purchase_clawback" are
// written today; the other types are reserved for a later phase (PRD P5).
export const CREDIT_TX_TYPES = [
  "purchase",
  "purchase_clawback",
  "signup_grant",
  "charge",
  "refund",
  "admin_grant",
  "admin_adjust",
] as const;
export type CreditTxType = (typeof CREDIT_TX_TYPES)[number];

export interface ICreditTransaction {
  user: Types.ObjectId;
  type: CreditTxType;
  // signed: + for a purchase, - for a clawback
  amount: number;
  balanceAfter: number;
  refKind: string;
  refId: string;
  key: string;
  createdAt: Date;
}

const CreditTransactionSchema = new Schema<ICreditTransaction>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: CREDIT_TX_TYPES, required: true },
    amount: {
      type: Number,
      required: true,
      validate: { validator: Number.isInteger, message: "must be an integer" },
    },
    balanceAfter: { type: Number, required: true },
    refKind: { type: String, required: true },
    refId: { type: String, required: true },
    key: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

CreditTransactionSchema.index({ user: 1, createdAt: -1 });

export const CreditTransaction = mongoose.model<ICreditTransaction>(
  "CreditTransaction",
  CreditTransactionSchema,
);
