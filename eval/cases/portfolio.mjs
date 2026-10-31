// eval/cases/portfolio.mjs
//
// Kasus #2: portfolio developer. Multi-file (Hero, About, Projects, Contact)
// DENGAN data dari prompt — nama, tech stack, project. Fakta harus konsisten.
import { generateProject } from "../../src/services/ai.js";
import { withUsageTracking } from "../../src/services/usageTracker.js";

export default async function () {
  return await withUsageTracking("generate", async () => {
    const result = await generateProject(
      "Portfolio fullstack developer. Nama saya Rendy, fokus React dan Node.js. Tiga project: E-commerce Kopi, Dashboard Analitik, Aplikasi Cuaca. Kontak: rendy@example.com",
      {},
      {},
    );

    const paths = Object.keys(result.files);
    const hasApp = "/App.js" in result.files;
    const hasStyles = "/styles.css" in result.files;
    const components = paths.filter((p) => p.startsWith("/components/"));

    const violations = [];
    if (!hasApp) violations.push("missing /App.js");
    if (!hasStyles) violations.push("missing /styles.css");
    if (components.length < 2) {
      violations.push(
        `portfolio should have >=2 components, got ${components.length}: ${components.join(", ")}`,
      );
    }
    if (violations.length > 0) {
      throw new Error(
        `Portfolio generation violations:\n  - ${violations.join("\n  - ")}`,
      );
    }

    return {
      fileCount: paths.length,
      hasApp,
      hasStyles,
      componentCount: components.length,
      componentFiles: components,
      placeholderCount: Object.keys(result.fixed ?? {}).length,
      budgetExceeded: !!result.budgetExceeded,
      semaphoreTimedOut: !!result.semaphoreTimedOut,
      budget: result.budget ?? null,
      gateMode: result.gateMode ?? null,
      gateIssues: (result.gateIssues ?? []).map((i) => i.code),
    };
  });
}
