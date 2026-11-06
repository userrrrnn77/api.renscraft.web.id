// src/controllers/adminController.js

import { timingSafeEqual } from "node:crypto";
import { User } from "../models/User.js";
import { Project } from "../models/Project.js";
import { PaymentOrder } from "../models/PaymentOrder.js";
import { CreditTransaction } from "../models/CreditTransaction.js";
import { signAdminSession } from "../utils/jwt.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import {
  approveManualOrder,
  rejectManualOrder,
} from "../services/payments/manualPayment.js";
import mongoose from "mongoose";
import { RedeemCode } from "../models/RedeemCode.js";
import { DynamicApp } from "../models/DynamicApp.js";

// ─── Rate limit in-memory ───────────────────────────────────────────────────
const loginAttempts = new Map();
const RATE_LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;

const checkRateLimit = (ip) => {
  const now = Date.now();
  const e = loginAttempts.get(ip);
  if (!e || e.until < now) return true;
  return e.count < RATE_LIMIT;
};

const recordAttempt = (ip) => {
  const now = Date.now();
  const e = loginAttempts.get(ip);
  if (!e || e.until < now) {
    loginAttempts.set(ip, { count: 1, until: now + WINDOW_MS });
  } else {
    e.count += 1;
  }
};

// Constant-time compare biar nggak bisa dibaca pakai timing attack
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

const cookieOptions = () => {
  const isProd = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    // Secure cuma di prod (HTTPS). Di dev, cookie harus bisa dikirim via HTTP localhost.
    secure: isProd,
    // SameSite=None WAJIB bareng Secure. Kalau dev, pakai "lax" biar cookie tetap jalan.
    sameSite: isProd ? "none" : "lax",
    // Ini yang tadi kelewat: Domain supaya cookie bisa dibaca dari api.renscraft.web.id juga.
    domain: isProd
      ? process.env.COOKIE_DOMAIN || ".renscraft.web.id"
      : undefined,

    maxAge: 12 * 60 * 60 * 1000,
    path: "/api/admin",
  };
};

// ─── Auth ───────────────────────────────────────────────────────────────────

export const adminLogin = asyncHandler(async (req, res) => {
  const number = String(req.body?.number ?? "").trim();
  const password = String(req.body?.password ?? "");

  const ip = req.ip || req.socket?.remoteAddress || "unknown";

  if (!checkRateLimit(ip)) {
    return fail(
      res,
      429,
      "ADMIN_TOO_MANY_ATTEMPTS",
      {},
      "Too many login attempts. Try again in 15 minutes.",
    );
  }

  const expectedNumber = (process.env.ADMIN_NUMBER ?? "").trim();
  const expectedPassword = process.env.ADMIN_PASSWORD ?? "";

  if (!expectedNumber || !expectedPassword) {
    console.error("[Admin] ADMIN_NUMBER / ADMIN_PASSWORD not configured");
    return fail(
      res,
      503,
      "ADMIN_NOT_CONFIGURED",
      {},
      "Admin auth not configured",
    );
  }

  const ok =
    safeEqual(number, expectedNumber) && safeEqual(password, expectedPassword);

  if (!ok) {
    recordAttempt(ip);
    console.warn(`[Admin] Failed login from ${ip}`);
    return fail(
      res,
      401,
      "ADMIN_INVALID_CREDENTIALS",
      {},
      "Invalid credentials",
    );
  }

  loginAttempts.delete(ip);

  res.cookie("admin_token", signAdminSession(), cookieOptions());
  console.log(`[Admin] Login OK from ${ip}`);
  res.json({ ok: true });
});

export const adminLogout = asyncHandler(async (_req, res) => {
  res.clearCookie("admin_token", { ...cookieOptions(), maxAge: 0 });
  res.json({ ok: true });
});

export const adminMe = asyncHandler(async (_req, res) => {
  res.json({ admin: true });
});

// ─── Stats ──────────────────────────────────────────────────────────────────

// GET /api/admin/stats
export const adminStats = asyncHandler(async (_req, res) => {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    newUsers24h,
    newUsers7d,
    totalProjects,
    publishedProjects,
    failedProjects,
    revenueAgg,
    pendingOrders,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: dayAgo } }),
    User.countDocuments({ createdAt: { $gte: weekAgo } }),
    Project.countDocuments({}),
    Project.countDocuments({ published: true }),
    Project.countDocuments({ status: "failed" }),
    PaymentOrder.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    PaymentOrder.countDocuments({ status: "pending" }),
  ]);

  const revenue = revenueAgg[0] || { total: 0, count: 0 };

  res.json({
    users: { total: totalUsers, last24h: newUsers24h, last7d: newUsers7d },
    projects: {
      total: totalProjects,
      published: publishedProjects,
      failed: failedProjects,
    },
    payments: {
      revenue: revenue.total,
      paidCount: revenue.count,
      pending: pendingOrders,
    },
  });
});

// ─── Lists (paginated) ──────────────────────────────────────────────────────

const paginate = (req) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(
    100,
    Math.max(5, parseInt(req.query.limit || "25", 10)),
  );
  return { page, limit, skip: (page - 1) * limit };
};

// GET /api/admin/users?page=1&limit=25&q=
export const adminListUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req);
  const q = String(req.query.q ?? "").trim();

  const filter = q
    ? {
        $or: [
          { name: { $regex: q, $options: "i" } },
          { email: { $regex: q, $options: "i" } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("name email provider credits createdAt")
      .lean(),
    User.countDocuments(filter),
  ]);

  res.json({ users, total, page, limit });
});

// GET /api/admin/projects?page=1&status=published|busy|failed
export const adminListProjects = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req);
  const status = String(req.query.status || "").trim();

  const filter = {};
  if (status === "published") filter.published = true;
  else if (status === "failed") filter.status = "failed";
  else if (status === "busy")
    filter.status = { $in: ["pending", "generating", "revising"] };

  const [projects, total] = await Promise.all([
    Project.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        "name owner status version published creditsHeld createdAt updatedAt",
      )
      .populate("owner", "name email")
      .lean(),
    Project.countDocuments(filter),
  ]);

  res.json({ projects, total, page, limit });
});

// ─── Remakes (takedown per domain) ──────────────────────────────────────────
//
// GET /api/admin/remakes?domain=&page=&limit=
// Domain dinormalisasi (strip protocol/path/www) supaya "https://www.example.com/x"
// dan "example.com" menghasilkan filter yang sama.

const normalizeRemakeDomain = (raw) => {
  let d = String(raw || "")
    .trim()
    .toLowerCase();
  if (!d) return "";
  d = d
    .replace(/^[a-z]+:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0];
  d = d.replace(/^www\./, "");
  return d;
};

export const adminListRemakes = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req);
  const domain = normalizeRemakeDomain(req.query.domain);

  const filter = domain
    ? { remakeOf: domain }
    : { remakeOf: { $exists: true, $not: { $size: 0 } } };

  const [projects, total] = await Promise.all([
    Project.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("name owner published customSubdomain remakeOf createdAt")
      .populate("owner", "name email")
      .lean(),
    Project.countDocuments(filter),
  ]);

  res.json({ projects, total, page, limit, domain });
});

// GET /api/admin/orders?page=1&status=pending|paid|...
export const adminListOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req);
  const status = String(req.query.status || "").trim();

  const filter = status ? { status } : {};

  const [orders, total] = await Promise.all([
    PaymentOrder.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("owner", "name email")
      .lean(),
    PaymentOrder.countDocuments(filter),
  ]);

  res.json({ orders, total, page, limit });
});

// GET /api/admin/manual?status=waiting_approval|manual_review|review|all
export const adminListManualOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req);
  const status = String(req.query.status || "review").trim();

  const statusFilter =
    status === "all"
      ? {
          $in: [
            "pending_manual",
            "ocr_pending",
            "waiting_approval",
            "manual_review",
            "manual_rejected",
            "paid",
            "expired",
          ],
        }
      : status === "review"
        ? { $in: ["waiting_approval", "manual_review"] }
        : status;

  const filter = { method: "manual", status: statusFilter };

  const [orders, total] = await Promise.all([
    PaymentOrder.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("owner", "name email credits")
      .lean(),
    PaymentOrder.countDocuments(filter),
  ]);

  res.json({ orders, total, page, limit });
});

// ─── Manual credit adjustment ───────────────────────────────────────────────

// POST /api/admin/users/:id/credits  { amount, reason }
export const adminGrantCredits = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  if (!/^[a-f\d]{24}$/i.test(userId)) {
    return fail(res, 400, "ADMIN_INVALID_USER_ID", {}, "Invalid user id");
  }

  const amount = parseInt(req.body?.amount, 10);
  const reason = String(req.body?.reason ?? "")
    .slice(0, 200)
    .trim();

  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10000) {
    return fail(
      res,
      400,
      "ADMIN_INVALID_AMOUNT",
      {},
      "Amount must be an integer between -10000 and 10000",
    );
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { credits: amount } },
    {
      returnDocument: "after",
      projection: { name: 1, email: 1, credits: 1 },
    },
  );
  if (!user) {
    return fail(res, 404, "ADMIN_USER_NOT_FOUND", {}, "User not found");
  }

  await CreditTransaction.create({
    user: user._id,
    type: amount > 0 ? "admin_grant" : "admin_adjust",
    amount,
    balanceAfter: user.credits,
    refKind: "admin",
    refId: "manual",
    key: `admin:${Date.now()}:${user._id}:${Math.random().toString(36).slice(2, 10)}`,
  }).catch((err) => {
    console.warn(`[Admin] Ledger write failed: ${err.message}`);
  });

  console.log(
    `[Admin] ${amount > 0 ? "+" : ""}${amount} credits → ${user.email} (${reason || "no reason"})`,
  );
  res.json({ user });
});

// ─── Manual transfer review ─────────────────────────────────────────────────

// POST /api/admin/manual/:orderId/approve  { label? }
export const adminApproveManual = asyncHandler(async (req, res) => {
  const orderId = String(req.params.orderId || "").trim();
  if (!orderId) {
    return fail(res, 400, "ADMIN_ORDER_ID_REQUIRED", {}, "orderId required");
  }

  const label = String(req.body?.label || "admin").slice(0, 60);
  const result = await approveManualOrder(orderId, label);

  if (!result.ok) {
    if (result.reason === "not_pending") {
      return fail(
        res,
        409,
        "ADMIN_ORDER_NOT_PENDING",
        {},
        "Order is not awaiting approval",
      );
    }
    if (result.reason === "user_missing") {
      return fail(res, 410, "ADMIN_USER_MISSING", {}, "User no longer exists");
    }
    return fail(res, 400, "ADMIN_APPROVE_FAILED", {}, "Approve failed");
  }

  console.log(`[Admin] Manual approved ${orderId} by ${label}`);
  res.json({ ok: true, order: result.order });
});

// POST /api/admin/manual/:orderId/reject  { reason, label? }
export const adminRejectManual = asyncHandler(async (req, res) => {
  const orderId = String(req.params.orderId || "").trim();
  if (!orderId) {
    return fail(res, 400, "ADMIN_ORDER_ID_REQUIRED", {}, "orderId required");
  }

  const reason = String(req.body?.reason || "")
    .slice(0, 300)
    .trim();
  if (!reason) {
    return fail(res, 400, "ADMIN_REASON_REQUIRED", {}, "reason is required");
  }

  const label = String(req.body?.label || "admin").slice(0, 60);
  const result = await rejectManualOrder(orderId, label, reason);

  if (!result.ok) {
    return fail(
      res,
      409,
      "ADMIN_ORDER_NOT_REVIEW",
      {},
      "Order is not awaiting review",
    );
  }

  console.log(`[Admin] Manual rejected ${orderId} by ${label}: ${reason}`);
  res.json({ ok: true, order: result.order });
});

// ─── Redeem codes ───────────────────────────────────────────────────────────
const CODE_RE = /^[A-Z0-9_-]{3,64}$/;

export const adminListRedeemCodes = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req);
  const [codes, total] = await Promise.all([
    RedeemCode.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    RedeemCode.countDocuments({}),
  ]);
  res.json({ codes, total, page, limit });
});

export const adminCreateRedeemCode = asyncHandler(async (req, res) => {
  const code = String(req.body?.code ?? "")
    .trim()
    .toUpperCase();
  const credits = parseInt(req.body?.credits, 10);
  const maxRedemptions = parseInt(req.body?.maxRedemptions, 10);
  const expiresAtRaw = req.body?.expiresAt;
  const expiresAt = new Date(expiresAtRaw);

  if (!CODE_RE.test(code)) {
    return fail(
      res,
      400,
      "ADMIN_REDEEM_CODE_INVALID",
      {},
      "Code must be 3-64 chars: A-Z, 0-9, _ or -",
    );
  }
  if (!Number.isInteger(credits) || credits < 1 || credits > 10000) {
    return fail(
      res,
      400,
      "ADMIN_REDEEM_CREDITS_INVALID",
      {},
      "Credits must be 1-10000",
    );
  }
  if (
    !Number.isInteger(maxRedemptions) ||
    maxRedemptions < 1 ||
    maxRedemptions > 10000
  ) {
    return fail(
      res,
      400,
      "ADMIN_REDEEM_MAX_INVALID",
      {},
      "maxRedemptions must be 1-10000",
    );
  }
  if (isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    return fail(
      res,
      400,
      "ADMIN_REDEEM_EXPIRY_INVALID",
      {},
      "Expiry must be a future date",
    );
  }

  try {
    const redeem = await RedeemCode.create({
      code,
      credits,
      maxRedemptions,
      expiresAt,
      createdBy: String(req.body?.label ?? "admin").slice(0, 60),
    });
    console.log(
      `[Admin] Created redeem code ${code} (${credits} credits, max ${maxRedemptions})`,
    );
    res.status(201).json({ redeem });
  } catch (err) {
    if (err?.code === 11000) {
      return fail(
        res,
        409,
        "ADMIN_REDEEM_CODE_EXISTS",
        {},
        "A code with that name already exists",
      );
    }
    throw err;
  }
});

export const adminDeleteRedeemCode = asyncHandler(async (req, res) => {
  const id = String(req.params.id || "");
  if (!mongoose.isObjectIdOrHexString(id)) {
    return fail(res, 400, "ADMIN_REDEEM_ID_INVALID", {}, "Invalid id");
  }
  const result = await RedeemCode.findByIdAndDelete(id);
  if (!result) {
    return fail(res, 404, "ADMIN_REDEEM_NOT_FOUND", {}, "Code not found");
  }
  console.log(
    `[Admin] Deleted redeem code ${result.code} (${result.redemptionCount}/${result.maxRedemptions} used)`,
  );
  res.json({ ok: true });
});

// ─── Dynamic Apps (suspend / restore) ───────────────────────────────────────

// GET /api/admin/dynamic?page=1&limit=25&status=published|draft|suspended|archived
export const adminListDynamicApps = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req);
  const status = String(req.query.status || "").trim();

  const filter = status ? { status } : {};

  const [apps, total] = await Promise.all([
    DynamicApp.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("-publishedFiles")
      .populate("ownerId", "name email")
      .populate("sourceProjectId", "name status published")
      .lean(),
    DynamicApp.countDocuments(filter),
  ]);

  res.json({ apps, total, page, limit });
});

// POST /api/admin/projects/:id/unpublish  { reason? }
// Idempotent: memanggil pada project yang sudah unpublished tidak error.
export const adminUnpublishProject = asyncHandler(async (req, res) => {
  const id = String(req.params.id || "");
  if (!mongoose.isObjectIdOrHexString(id)) {
    return fail(res, 404, "PROJECT_NOT_FOUND", {}, "Project not found");
  }

  const reason = String(req.body?.reason ?? "")
    .slice(0, 300)
    .trim();

  const project = await Project.findByIdAndUpdate(
    id,
    { $set: { published: false } },
    {
      returnDocument: "after",
      projection: {
        name: 1,
        published: 1,
        remakeOf: 1,
        customSubdomain: 1,
        owner: 1,
      },
    },
  ).lean();

  if (!project) {
    return fail(res, 404, "PROJECT_NOT_FOUND", {}, "Project not found");
  }

  console.log(
    `[Admin] Unpublished project ${id} (${project.name})${reason ? `: ${reason}` : ""}`,
  );

  res.json({ ok: true, project });
});

// POST /api/admin/dynamic/:id/suspend  { reason? }
export const adminSuspendDynamicApp = asyncHandler(async (req, res) => {
  const id = String(req.params.id || "");
  if (!mongoose.isObjectIdOrHexString(id)) {
    return fail(res, 400, "ADMIN_INVALID_APP_ID", {}, "Invalid app id");
  }

  const reason = String(req.body?.reason ?? "")
    .slice(0, 300)
    .trim();

  const app = await DynamicApp.findOneAndUpdate(
    { _id: id, status: { $in: ["draft", "published"] } },
    { $set: { status: "suspended" } },
    { returnDocument: "after", projection: { publishedFiles: 0 } },
  ).lean();

  if (!app) {
    const existing = await DynamicApp.findById(id).select("status").lean();
    if (!existing) {
      return fail(res, 404, "ADMIN_APP_NOT_FOUND", {}, "App not found");
    }
    return fail(
      res,
      409,
      "ADMIN_APP_NOT_SUSPENDABLE",
      { status: existing.status },
      `App is already ${existing.status}`,
    );
  }

  console.log(
    `[Admin] Suspended dynamic app ${app.slug} (${app._id})${reason ? `: ${reason}` : ""}`,
  );

  res.json({ ok: true, app });
});

// POST /api/admin/dynamic/:id/restore
//
// Suspended app selalu kembali ke "draft". Owner harus publish ulang untuk
// live lagi — ini kasih kesempatan admin review sebelum kontennya publik.
// Sengaja tidak "auto-publish" balik ke status sebelumnya: kalau suspend
// karena ada masalah konten, kita tidak mau app otomatis live lagi.
export const adminRestoreDynamicApp = asyncHandler(async (req, res) => {
  const id = String(req.params.id || "");
  if (!mongoose.isObjectIdOrHexString(id)) {
    return fail(res, 400, "ADMIN_INVALID_APP_ID", {}, "Invalid app id");
  }

  const app = await DynamicApp.findOneAndUpdate(
    { _id: id, status: "suspended" },
    { $set: { status: "draft" } },
    { returnDocument: "after", projection: { publishedFiles: 0 } },
  ).lean();

  if (!app) {
    const existing = await DynamicApp.findById(id).select("status").lean();
    if (!existing) {
      return fail(res, 404, "ADMIN_APP_NOT_FOUND", {}, "App not found");
    }
    return fail(
      res,
      409,
      "ADMIN_APP_NOT_RESTORABLE",
      { status: existing.status },
      `App is ${existing.status}, not suspended`,
    );
  }

  console.log(`[Admin] Restored dynamic app ${app.slug} (${app._id}) to draft`);

  res.json({ ok: true, app });
});
