// src/config/env.js
//
// Settings the server must not guess. A guessed default here is worse than a crash
// at startup: a known JWT secret lets anyone forge a login cookie, and a guessed
// CORS list silently blocks (or opens) the frontend.
//
// Everything is read lazily, so dotenv has already run when these are called and
// tests can change process.env.

const MIN_SECRET_LENGTH = 32;
// What the code used to fall back to. Anyone who has read the source knows it.
const REJECTED_SECRETS = new Set(["fallback_secret"]);
// Vite's default dev server. Only used outside production when ORIGINS is unset.
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const isProduction = () => process.env.NODE_ENV === "production";

let warnedShortSecret = false;

export function getJwtSecret() {
  const secret = (process.env.JWT_SECRET ?? "").trim();

  if (!secret || REJECTED_SECRETS.has(secret)) {
    throw new Error(
      "JWT_SECRET is not set. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    const message = `JWT_SECRET is only ${secret.length} characters, use at least ${MIN_SECRET_LENGTH}`;
    if (isProduction()) throw new Error(message);
    if (!warnedShortSecret) {
      warnedShortSecret = true;
      console.warn(`[Config] ${message} (only allowed outside production)`);
    }
  }

  return secret;
}

export function getAllowedOrigins() {
  const origins = String(process.env.ORIGINS ?? "")
    .split(",")
    // browsers send the Origin header without a trailing slash
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (origins.includes("*")) {
    throw new Error(
      'ORIGINS cannot contain "*": the session cookie needs credentials, so list the exact origins',
    );
  }
  if (origins.length > 0) return origins;

  if (isProduction()) {
    throw new Error(
      "ORIGINS is not set. Use a comma-separated list, e.g. https://app.example.com",
    );
  }
  return [...DEV_ORIGINS];
}

export function getMidtransConfig() {
  const merchantId = (process.env.MIDTRANS_MERCHANT_ID ?? "").trim();
  const serverKey = (process.env.MIDTRANS_SERVER_KEY ?? "").trim();
  const clientKey = (process.env.MIDTRANS_CLIENT_KEY ?? "").trim();
  const isProduction = process.env.MIDTRANS_IS_PRODUCTION === "true";

  if (!merchantId || !serverKey || !clientKey) {
    throw new Error(
      "Midtrans configuration is incomplete. MIDTRANS_MERCHANT_ID, MIDTRANS_SERVER_KEY, and MIDTRANS_CLIENT_KEY must be set.",
    );
  }

  return { merchantId, serverKey, clientKey, isProduction };
}

// PAYMENTS_ENABLED=false switches the whole top-up feature off: the Midtrans variables
// are then not required to boot and every /api/payments route answers 503. Default: on.
export function isPaymentsEnabled() {
  return (
    String(process.env.PAYMENTS_ENABLED ?? "true")
      .trim()
      .toLowerCase() !== "false"
  );
}

// Optional. Only used to build the Snap `callbacks.finish` URL, nothing sensitive.
export function getPublicAppUrl() {
  const raw = String(process.env.PUBLIC_APP_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

// Warn-only checks: they catch the classic "sandbox keys on the live site" mistake
// without ever stopping the server from starting.
function warnAboutPaymentSetup() {
  if (!isPaymentsEnabled()) return;

  const { serverKey, clientKey, isProduction: live } = getMidtransConfig();

  if (!live && isProduction()) {
    console.warn(
      "[Config] WARNING: NODE_ENV=production but MIDTRANS_IS_PRODUCTION is not 'true'. " +
        "This server takes SANDBOX payments: no real money moves, and nobody pays for credits.",
    );
  }

  const looksSandbox =
    serverKey.startsWith("SB-Mid-server-") &&
    clientKey.startsWith("SB-Mid-client-");
  if (!live && !looksSandbox) {
    console.warn(
      "[Config] WARNING: MIDTRANS_IS_PRODUCTION is not 'true', but the keys do not look like sandbox keys " +
        "(SB-Mid-server-... / SB-Mid-client-...). Check that the keys and the flag belong together.",
    );
  }
  if (live && (serverKey.startsWith("SB-") || clientKey.startsWith("SB-"))) {
    console.warn(
      "[Config] WARNING: MIDTRANS_IS_PRODUCTION=true, but a Midtrans key looks like a sandbox key.",
    );
  }
}

// Called once at startup: report every problem at once instead of dying on the
// first one with a stack trace from somewhere deep inside a library.
export function validateEnv() {
  const problems = [];

  if (!String(process.env.MONGODB_URI ?? "").trim()) {
    problems.push("MONGODB_URI is not set");
  }

  const checks = [getJwtSecret, getAllowedOrigins];
  // Midtrans is only mandatory while payments are on
  if (isPaymentsEnabled()) checks.push(getMidtransConfig);

  for (const check of checks) {
    try {
      check();
    } catch (err) {
      problems.push(err.message);
    }
  }

  // It turns off certificate checks for EVERY outbound HTTPS call, Midtrans included
  if (isPaymentsEnabled() && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    problems.push(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate checks for every outbound HTTPS call, " +
        "including the ones to Midtrans. Remove it, or set PAYMENTS_ENABLED=false.",
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment:\n\n${problems.join("\n")}`);
  }

  warnAboutPaymentSetup();
}
