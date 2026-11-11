// src/controllers/manualPaymentController.ts

import type { Request, Response } from "express";
import { PaymentOrder } from "../models/PaymentOrder.js";
import { User } from "../models/User.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import {
  attachProof,
  createManualOrder,
} from "../services/payments/manualPayment.js";
import { objectKeyFor } from "../services/assetMirror.js";
import { isR2Configured, uploadObject } from "../utils/s3.js";
import { CREDIT_PACKAGES, findPackage } from "../utils/packages.js";

const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const ALLOWED_PROOF_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

interface AuthedRequest extends Request {
  user?: { userId?: string };
}

const userIdOf = (req: Request): string | null => {
  const id = (req as AuthedRequest).user?.userId;
  return typeof id === "string" && id ? id : null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface BankAccount {
  bank: string | null;
  number: string | null;
  holder: string | null;
  raw: string;
}

function parseBankInfo(raw: string): BankAccount[] {
  const text = String(raw || "").trim();
  if (!text) return [];

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): BankAccount => {
      const numberMatch = line.match(/\b\d{6,20}\b/);
      const number = numberMatch?.[0] ?? null;

      const holderMatch = line.match(
        /(?:a\.?\s*n\.?|a\/n|atas\s+nama)\s+(.+)$/i,
      );
      const holder = holderMatch?.[1]?.trim() ?? null;

      let bank: string | null = null;
      if (number) {
        const idx = line.indexOf(number);
        const before = line.slice(0, idx).trim();
        bank = before.split(/\s+/).filter(Boolean).pop() ?? null;
      }

      return { bank, number, holder, raw: line };
    });
}

export const getManualConfig = asyncHandler(
  async (_req: Request, res: Response) => {
    const bankInfoRaw = (process.env.MANUAL_BANK_INFO || "").trim();
    res.json({
      enabled: true,
      packages: CREDIT_PACKAGES.map((p) => ({
        id: p.id,
        credits: p.credits,
        amount: p.amount,
        label: p.label,
      })),
      bankInfo: bankInfoRaw,
      bankAccounts: parseBankInfo(bankInfoRaw),
      adminContact: (process.env.MANUAL_ADMIN_CONTACT || "").trim(),
      expiryHours: 24,
    });
  },
);

export const createManual = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = userIdOf(req);
    if (!userId) {
      fail(res, 401, "MANUAL_NOT_AUTHENTICATED", {}, "Not authenticated");
      return;
    }

    const pkg = findPackage(
      isRecord(req.body) ? req.body.packageId : undefined,
    );
    if (!pkg) {
      fail(res, 400, "MANUAL_UNKNOWN_PACKAGE", {}, "Unknown package");
      return;
    }

    const user = await User.findById(userId).select("name email").lean();
    if (!user) {
      fail(
        res,
        401,
        "MANUAL_ACCOUNT_NOT_FOUND",
        {},
        "Account not found, please sign in again.",
      );
      return;
    }

    const active = await PaymentOrder.countDocuments({
      owner: userId,
      method: "manual",
      status: {
        $in: [
          "pending_manual",
          "ocr_pending",
          "waiting_approval",
          "manual_review",
        ],
      },
    });
    if (active >= 3) {
      fail(
        res,
        429,
        "MANUAL_TOO_MANY_ACTIVE",
        { max: 3 },
        "You already have too many unpaid manual orders. Finish them first.",
      );
      return;
    }

    const order = await createManualOrder(userId, {
      id: pkg.id,
      credits: pkg.credits,
      amount: pkg.amount,
    });

    res.status(201).json({
      orderId: order.orderId,
      amount: order.amount,
      expectedAmount: order.expectedAmount,
      credits: order.credits,
      expiresAt: order.expiresAt,
      bankInfo: (process.env.MANUAL_BANK_INFO || "").trim(),
      adminContact: (process.env.MANUAL_ADMIN_CONTACT || "").trim(),
    });
  },
);

export const uploadProof = asyncHandler(async (req: Request, res: Response) => {
  const userId = userIdOf(req);
  if (!userId) {
    fail(res, 401, "MANUAL_NOT_AUTHENTICATED", {}, "Not authenticated");
    return;
  }

  if (!isR2Configured()) {
    fail(
      res,
      503,
      "MANUAL_STORAGE_NOT_CONFIGURED",
      {},
      "Storage not configured",
    );
    return;
  }

  const orderId = req.params.orderId;
  if (typeof orderId !== "string" || !orderId) {
    fail(res, 400, "MANUAL_ORDER_ID_REQUIRED", {}, "orderId required");
    return;
  }

  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail(res, 400, "MANUAL_EMPTY_IMAGE", {}, "Empty image");
    return;
  }
  if (buffer.length > MAX_PROOF_BYTES) {
    const max = Math.floor(MAX_PROOF_BYTES / 1024 / 1024);
    fail(
      res,
      413,
      "MANUAL_PROOF_TOO_LARGE",
      { max },
      `Proof too large (max ${max}MB)`,
    );
    return;
  }

  const rawContentType = String(req.headers["content-type"] || "");
  const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (!ALLOWED_PROOF_TYPES.has(contentType)) {
    fail(
      res,
      400,
      "MANUAL_PROOF_INVALID_TYPE",
      {},
      "Proof must be JPEG, PNG, WebP, GIF, or AVIF",
    );
    return;
  }

  const manualName = decodeURIComponent(
    String(req.headers["x-manual-name"] || ""),
  )
    .slice(0, 120)
    .trim();
  const manualBank = decodeURIComponent(
    String(req.headers["x-manual-bank"] || ""),
  )
    .slice(0, 60)
    .trim();

  if (!manualName || !manualBank) {
    fail(
      res,
      400,
      "MANUAL_NAME_BANK_REQUIRED",
      {},
      "Name and bank are required",
    );
    return;
  }

  const key = `manual-proofs/${orderId}-${Date.now()}.${
    objectKeyFor(buffer, contentType)?.split(".").pop() || "jpg"
  }`;
  let proofUrl: string;
  try {
    proofUrl = await uploadObject(key, buffer, contentType, {
      cacheControl: "private, max-age=0",
    });
  } catch (err) {
    console.error(
      `[ManualPayment] R2 upload failed for ${orderId}: ${(err as Error).message}`,
    );
    fail(res, 502, "MANUAL_UPLOAD_FAILED", {}, "Upload failed, try again");
    return;
  }

  const result = await attachProof({
    orderId,
    ownerId: userId,
    proofUrl,
    proofBuffer: buffer,
    manualName,
    manualBank,
  });

  if (!result.ok) {
    const map: Record<string, [number, string, string]> = {
      not_found: [404, "MANUAL_ORDER_NOT_FOUND", "Order not found"],
      wrong_status: [
        409,
        "MANUAL_ORDER_WRONG_STATUS",
        "This order is no longer accepting proofs",
      ],
      duplicate_proof: [
        409,
        "MANUAL_PROOF_DUPLICATE",
        "This screenshot was already used for another order",
      ],
    };
    const entry = map[result.reason];
    if (entry) {
      fail(res, entry[0], entry[1], {}, entry[2]);
      return;
    }
    fail(res, 400, "MANUAL_ATTACH_FAILED", {}, "Could not attach proof");
    return;
  }

  res.status(200).json({
    orderId: result.order.orderId,
    status: result.order.status,
    proofUrl: proofUrl, 
  });
});
