process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  process.exit(1);
});

// src/server.js
import express from "express";
import "dotenv/config";
import cors from "cors";
import cookieParser from "cookie-parser";
import { connectToDatabase } from "./config/db.js";
import {
  getAllowedOrigins,
  validateEnv,
  isOriginAllowed,
} from "./config/env.js";
import appRouter from "./routes/index.routes.js";
import { initWebSocket } from "./config/ws.js";
import runtimeRouter from "./routes/runtimeRoutes.js";
import { recoverStaleProjects } from "./controllers/projectController.js";

try {
  validateEnv();
} catch (err) {
  console.error(`[Config] ${err.message}`);
  process.exit(1);
}

const app = express();

const trustProxy = Number(process.env.TRUST_PROXY_HOPS) || 0;

app.set("trust proxy", trustProxy);
console.log(`[Config] trust proxy = ${trustProxy} (TRUST_PROXY_HOPS)`);

if (process.env.NODE_ENV === "production" && trustProxy === 0) {
  console.warn(
    "[Config] WARNING: trust proxy = 0 di production. Kalau backend di belakang Cloudflare Tunnel / proxy lain, req.ip akan jadi IP proxy dan semua pengunjung berbagi limit per-IP. Set TRUST_PROXY_HOPS sesuai jumlah hop yang dipercaya.",
  );
}

// ─── Boot: connect DB, LALU recover project yang nyangkut (F2) ─────────────
(async () => {
  let delay = 3000;
  let attempt = 1;
  while (true) {
    try {
      await connectToDatabase();
      console.log("[Boot] DB ready.");
      break;
    } catch (err) {
      console.error(
        `[Boot] DB connect attempt ${attempt} failed: ${err.message}. Retry in ${delay / 1000}s.`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 60000);
      attempt += 1;
    }
  }

  // Recovery dijalankan SETELAH DB ready, di dalam IIFE ini.
  // Kalau di luar, top-level await race dengan connect loop → query ter-buffer.
  try {
    const graceMs =
      (Number(process.env.BOOT_SETTLE_GRACE_SECONDS) || 120) * 1000;
    const recovered = await recoverStaleProjects(graceMs);
    console.log(`[Boot] Recovered ${recovered} stale project(s)`);
  } catch (err) {
    console.error(`[Boot] Recovery failed:`, err);
  }
})();

// F8.1: validasi env harness AI. Warn only, jangan block boot — env
// yang salah di sini bikin biaya tracking meleset, bukan server mati.
(function validateHarnessEnv() {
  const warnings = [];

  if (
    process.env.AI_FAST_FOR_PLAN === "1" &&
    !String(process.env.AI_MODEL_FAST ?? "").trim()
  ) {
    warnings.push(
      "AI_FAST_FOR_PLAN=1 but AI_MODEL_FAST is empty. The planner will use the main model (no speedup).",
    );
  }

  const hasFastModel = !!String(process.env.AI_MODEL_FAST ?? "").trim();
  const hasFastPriceIn = !!String(
    process.env.AI_FAST_PRICE_IN_PER_M ?? "",
  ).trim();
  const hasFastPriceOut = !!String(
    process.env.AI_FAST_PRICE_OUT_PER_M ?? "",
  ).trim();
  if (hasFastModel && (!hasFastPriceIn || !hasFastPriceOut)) {
    warnings.push(
      "AI_MODEL_FAST is set but AI_FAST_PRICE_IN_PER_M / AI_FAST_PRICE_OUT_PER_M is empty. Cost tracking will fall back to the main model pricing (inaccurate).",
    );
  }

  if (
    process.env.HARNESS_QA_GATE === "enforce" &&
    !String(process.env.CHROMIUM_PATH ?? "").trim()
  ) {
    // enforce + no chromium = QA render unavailable → semua project jadi
    // passed_with_warnings (bukan failed), tapi lo harus tau ini.
    warnings.push(
      "HARNESS_QA_GATE=enforce but CHROMIUM_PATH is not set. If Playwright browsers are missing, Render stage will be skipped as warning.",
    );
  }

  for (const w of warnings) {
    console.warn(`[Config] WARNING: ${w}`);
  }
})();

app.use(express.json({ limit: "3mb" }));

app.use("/api/runtime", runtimeRouter);

const strictCors = cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(null, false);
    }
  },
  credentials: true,
});

const publicCors = cors({ origin: true, credentials: true });

const PUBLIC_PREFIXES = [
  "/api/dynamic/public",
  "/api/projects/public",
  "/api/payments/packages",
  "/api/dynamic/config",
];

const isPublicPath = (path) =>
  PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

app.use((req, res, next) => {
  if (isPublicPath(req.path)) return publicCors(req, res, next);
  return strictCors(req, res, next);
});

app.use(cookieParser());

app.get("/", (req, res) => {
  res.send("Server is live");
});

app.use("/api", appRouter);

app.use((err, _req, res, _next) => {
  console.error(`[Error] ${err.message}`);
  const status = err.status || err.statusCode || 500;
  const message =
    status >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message;
  const code =
    status === 429
      ? "RATE_LIMITED"
      : status >= 500
        ? "INTERNAL_ERROR"
        : "BAD_REQUEST";
  res.status(status).json({ error: message, code });
});

const port = process.env.PORT || 3000;

const httpServer = app.listen(port, () => {
  console.log(`server is running at http://localhost:${port}`);
});

initWebSocket(httpServer);
