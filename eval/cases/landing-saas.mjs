// eval/cases/landing-saas.mjs
//
// Kasus #3: landing page SaaS. Paling banyak komponen — Hero, Features, Pricing,
// Testimonials, CTA, Footer. Stress test buat planner + contract anchors.
import { generateProject } from "../../src/services/ai.js";
import { withUsageTracking } from "../../src/services/usageTracker.js";

export default async function () {
  return await withUsageTracking("generate", async () => {
    const result = await generateProject(
      "Landing page SaaS analytics bernama MetricsPro. Hero dengan tagline, section Fitur (4 fitur utama), Pricing (3 tier: Starter, Pro, Enterprise), Testimonial dari 3 pelanggan, CTA, Footer. Warna utama indigo.",
      {},
      {},
    );

    const paths = Object.keys(result.files);
    const hasApp = "/App.js" in result.files;
    const components = paths.filter((p) => p.startsWith("/components/"));

    // Landing page SaaS: paling nggak 4 komponen. Kalau model gabungin semua
    // ke App.js, ini gagal planner rule.
    const violations = [];
    if (!hasApp) violations.push("missing /App.js");
    if (components.length < 4) {
      violations.push(
        `landing SaaS should have >=4 components, got ${components.length}: ${components.join(", ")}`,
      );
    }
    if (violations.length > 0) {
      throw new Error(
        `Landing SaaS violations:\n  - ${violations.join("\n  - ")}`,
      );
    }

    return {
      fileCount: paths.length,
      hasApp,
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
