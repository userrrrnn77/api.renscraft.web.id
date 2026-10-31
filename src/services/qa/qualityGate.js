// src/services/qa/qualityGate.js
import { bundleProject, collectCss, isInfraBundleError } from "./bundle.js";
import { renderAndSmoke } from "./render.js";

const DEFAULT_CONCURRENCY = 2;
let active = 0;
const waiters = [];

async function acquire() {
  if (active < DEFAULT_CONCURRENCY) {
    active++;
    return () => release();
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) return next();
  active = Math.max(0, active - 1);
}

export function getGateMode(env = process.env) {
  const raw = String(env.HARNESS_QA_GATE ?? "shadow")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return "off";
  if (raw === "enforce") return "enforce";
  if (raw === "warn") return "warn";
  return "shadow";
}

const RESOURCE_NOISE_RE =
  /Failed to load resource|net::ERR_FAILED|net::ERR_BLOCKED_BY_CLIENT|Failed to fetch|net::ERR_NAME_NOT_RESOLVED|net::ERR_INTERNET_DISCONNECTED|net::ERR_CONNECTION_REFUSED/i;

export async function runQualityGate(files, contract) {
  const mode = getGateMode();
  if (mode === "off") return { mode, issues: [], stages: {} };

  const issues = [];
  const stages = {};
  const releaseSlot = await acquire();

  try {
    const t0 = Date.now();
    const bundle = await bundleProject(files);
    stages.bundle = { ok: bundle.ok, durationMs: Date.now() - t0 };

    if (!bundle.ok) {
      const infra = isInfraBundleError(bundle.error);
      issues.push({
        code: infra ? "QA_BUNDLE_UNAVAILABLE" : "BUNDLE_ERROR",
        severity: infra ? "warning" : "blocking",
        stage: "bundle",
        message: infra
          ? `QA render skipped: React runtime files are missing from node_modules. ` +
            `This is an install issue, not a problem with the generated project. ` +
            `Run "bun install --force" in server/. (${bundle.error.slice(0, 200)})`
          : bundle.error,
      });
      return finalize(mode, issues, stages);
    }

    const cssText = collectCss(files);
    const t1 = Date.now();
    const render = await renderAndSmoke(bundle.code, cssText, {
      reactUmd: bundle.reactUmd,
      reactDomUmd: bundle.reactDomUmd,
    });
    stages.render = { ok: render.ok, durationMs: Date.now() - t1 };

    if (!render.ok) {
      issues.push({
        code: render.unavailable ? "QA_RENDER_UNAVAILABLE" : "RENDER_ERROR",
        severity: "warning",
        stage: "render",
        message: render.error,
      });
      return finalize(mode, issues, stages);
    }

    const s = render.smoke;

    for (const msg of s.pageErrors) {
      issues.push({
        code: "PAGE_ERROR",
        severity: "blocking",
        stage: "smoke",
        message: msg,
      });
    }

    for (const msg of s.consoleErrors) {
      const noise = RESOURCE_NOISE_RE.test(msg);
      issues.push({
        code: noise ? "RESOURCE_BLOCKED" : "CONSOLE_ERROR",
        severity: noise ? "warning" : "blocking",
        stage: "smoke",
        message: msg,
      });
    }

    if (s.rootChildren === 0) {
      issues.push({
        code: "ROOT_EMPTY",
        severity: "blocking",
        stage: "smoke",
        message: "Root element has no children (blank page)",
      });
    }

    if (s.missingAnchors.length > 0) {
      issues.push({
        code: "ANCHOR_MISSING",
        severity: "warning",
        stage: "smoke",
        message: `Anchor(s) point to non-existent id: ${s.missingAnchors
          .slice(0, 5)
          .join(", ")}`,
      });
    }

    if (s.overflow) {
      issues.push({
        code: "OVERFLOW_MOBILE",
        severity: "warning",
        stage: "smoke",
        message: "Horizontal overflow at 390px viewport",
      });
    }

    // F5.4: gambar rusak → warning
    for (const src of s.brokenImages || []) {
      issues.push({
        code: "IMAGE_BROKEN",
        severity: "warning",
        stage: "smoke",
        message: `Image failed to load: ${src.slice(0, 120)}`,
      });
    }
  } finally {
    releaseSlot();
  }

  return finalize(mode, issues, stages);
}

function finalize(mode, issues, stages) {
  const adjusted =
    mode === "warn"
      ? issues.map((i) => ({ ...i, severity: "warning" }))
      : issues;
  const reportable = mode !== "shadow";
  const loggable =
    mode === "shadow"
      ? adjusted.filter((i) => i.severity === "blocking")
      : adjusted;
  return { mode, issues: adjusted, stages, reportable, loggable };
}
