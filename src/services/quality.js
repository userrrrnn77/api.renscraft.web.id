// src/services/quality.js
//
// F1: builder untuk QualityReport. Pure function — nggak baca DB, nggak panggil AI.
// Panggil dari runBackgroundGeneration setelah file final terkumpul (termasuk
// placeholder) dan dari runBackgroundGeneration di revisi kalau F6 mendarat.
export function buildQualityReport(
  issues = [],
  { stages = {}, repairRounds = 0, version = 1 } = {},
) {
  const blocking = issues.filter((i) => i.severity === "blocking");
  const warnings = issues.filter((i) => i.severity === "warning");

  let status = "passed";
  if (blocking.length > 0) status = "failed";
  else if (warnings.length > 0) status = "passed_with_warnings";

  return {
    status,
    issues,
    stages,
    repairRounds,
    checkedAt: new Date(),
    version,
  };
}
