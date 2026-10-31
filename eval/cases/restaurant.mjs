// eval/cases/restaurant.mjs
//
// Kasus #1: restoran, tanpa brief (jalur legacy). Sejak F4, dibungkus
// withUsageTracking supaya budget ter-record dan bisa dilihat di hasil eval.
import { generateProject } from "../../src/services/ai.js";
import { withUsageTracking } from "../../src/services/usageTracker.js";

export default async function () {
  return await withUsageTracking("generate", async () => {
    const result = await generateProject(
      "Website warkop Andre, kopi dan mie instan, buka 17:00-02:00, daerah Bandung",
      {},
      {},
    );
    return {
      fileCount: Object.keys(result.files).length,
      hasApp: "/App.js" in result.files,
      placeholderCount: Object.keys(result.fixed ?? {}).length,
      budgetExceeded: !!result.budgetExceeded,
      semaphoreTimedOut: !!result.semaphoreTimedOut,
      budget: result.budget ?? null,
    };
  });
}
