// eval/cases/app-tool.mjs
//
// Kasus #4: small interactive app (Tic Tac Toe). Single-file rule: model harus
// generate /App.js + /styles.css saja, tanpa /components/. Semua state, logic,
// dan UI di dalam /App.js.
//
// Metrics di-return buat eval-compare.mjs (FR-0.3). Assertion di bawah pakai
// throw: kalau rule dilanggar, case ini FAILED dan kita tau persis kenapa.
import { generateProject } from "../../src/services/ai.js";
import { withUsageTracking } from "../../src/services/usageTracker.js";

export default async function () {
  return await withUsageTracking("generate", async () => {
    const result = await generateProject(
      "Tic Tac Toe game 2 pemain dengan deteksi menang, indikator giliran, dan tombol reset. Desain modern minimalis.",
      {},
      {},
    );

    const paths = Object.keys(result.files);
    const componentFiles = paths.filter((p) => p.startsWith("/components/"));

    const appRaw = result.files["/App.js"];
    const appChars =
      typeof appRaw === "string"
        ? appRaw.length
        : (appRaw?.content?.length ?? 0);

    // ─── Assertions: single-file rule ────────────────────────────────────
    const violations = [];
    if (!("/App.js" in result.files)) {
      violations.push("missing /App.js");
    }
    if (!("/styles.css" in result.files)) {
      violations.push("missing /styles.css");
    }
    if (paths.length > 2) {
      violations.push(
        `expected <=2 files, got ${paths.length}: ${paths.join(", ")}`,
      );
    }
    if (componentFiles.length > 0) {
      violations.push(
        `/components/ files present (single-file rule violated): ${componentFiles.join(", ")}`,
      );
    }
    if (appChars < 2000) {
      violations.push(
        `/App.js too small (${appChars} chars); expected >2000 for a full game`,
      );
    }
    if (violations.length > 0) {
      throw new Error(
        `Single-file rule violations:\n  - ${violations.join("\n  - ")}`,
      );
    }

    // ─── Metrics (buat eval-compare.mjs nanti) ───────────────────────────
    return {
      fileCount: paths.length,
      hasApp: true,
      hasStyles: true,
      componentFiles: [],
      appChars,
      placeholderCount: Object.keys(result.fixed ?? {}).length,
      budgetExceeded: !!result.budgetExceeded,
      semaphoreTimedOut: !!result.semaphoreTimedOut,
      budget: result.budget ?? null,
      gateMode: result.gateMode ?? null,
      gateIssues: (result.gateIssues ?? []).map((i) => i.code),
    };
  });
}
