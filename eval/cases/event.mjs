// eval/cases/event.mjs
//
// Kasus #5: undangan pernikahan. Banyak gambar (ref-img dari Unsplash),
// loading="lazy", credit fotografer wajib di setiap <img>.
import { generateProject } from "../../src/services/ai.js";
import { withUsageTracking } from "../../src/services/usageTracker.js";

export default async function () {
  return await withUsageTracking("generate", async () => {
    const result = await generateProject(
      "Undangan pernikahan online Rina dan Dimas, 15 Desember 2026, di Bandung. Tema modern minimalis dengan warna sage green. Ada section: Hero dengan foto pasangan, Cerita Kami, Detail Acara, Galeri 6 foto, RSVP WhatsApp 08123456789.",
      {},
      {},
    );

    const paths = Object.keys(result.files);
    const hasApp = "/App.js" in result.files;
    const componentCount = paths.filter((p) =>
      p.startsWith("/components/"),
    ).length;

    const violations = [];
    if (!hasApp) violations.push("missing /App.js");
    if (componentCount < 3) {
      violations.push(
        `event invitation should have >=3 components, got ${componentCount}`,
      );
    }
    if (violations.length > 0) {
      throw new Error(
        `Event invitation violations:\n  - ${violations.join("\n  - ")}`,
      );
    }

    return {
      fileCount: paths.length,
      hasApp,
      componentCount,
      placeholderCount: Object.keys(result.fixed ?? {}).length,
      budgetExceeded: !!result.budgetExceeded,
      semaphoreTimedOut: !!result.semaphoreTimedOut,
      budget: result.budget ?? null,
      gateMode: result.gateMode ?? null,
      gateIssues: (result.gateIssues ?? []).map((i) => i.code),
    };
  });
}
