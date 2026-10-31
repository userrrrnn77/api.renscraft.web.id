// eval/cases/revision.mjs
//
// Kasus #6: generate landing, lalu revisi 1 file. F6 atomic + F3 finalize
// harus lewat. Metrics: fileCount sebelum/sesudah, versi, refunded.
//
// CATATAN: pakai generateProject + reviseProject langsung (bukan lewat
// chatController) biar eval nggak nyentuh DB project. Revisi lewat
// chatController butuh Project doc di Mongo — di luar scope eval.
import { generateProject, reviseProject } from "../../src/services/ai.js";
import { withUsageTracking } from "../../src/services/usageTracker.js";

export default async function () {
  return await withUsageTracking("generate", async () => {
    const initial = await generateProject(
      "Landing page untuk kopi lokal. Hero, menu, about, kontak.",
      {},
      {},
    );

    const paths = Object.keys(initial.files);
    if (!("/App.js" in initial.files)) {
      throw new Error("initial generation missing /App.js");
    }

    // Susun manifest + relevantFiles untuk reviseProject
    const manifest = paths.map((p) => ({
      path: p,
      hash: "eval-hash",
      size: (initial.files[p] || "").length,
    }));
    const relevantFiles = {};
    for (const p of paths) {
      const c = initial.files[p];
      relevantFiles[p] = typeof c === "string" ? c : (c?.content ?? "");
    }

    const revision = await reviseProject(
      "Ganti warna primary jadi emerald, hanya di Hero section.",
      manifest,
      relevantFiles,
      [], // recentMessages
      [], // historyUrls
      [], // uploadedImages      ← TAMBAH INI
      {}, // extra
    );

    const opCount = (revision.operations ?? []).length;
    const violations = [];
    if (opCount === 0) violations.push("revision produced 0 operations");
    if (violations.length > 0) {
      throw new Error(`Revision violations:\n  - ${violations.join("\n  - ")}`);
    }

    return {
      initialFileCount: paths.length,
      initialHasApp: true,
      opCount,
      opPaths: (revision.operations ?? []).map((o) => o.path),
      budgetExceeded: !!initial.budgetExceeded,
      budget: initial.budget ?? null,
    };
  });
}
