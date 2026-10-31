// scripts/eval-compare.mjs
//
// Bandingkan dua hasil eval. Exit 1 kalau regresi > ambang.
//   node scripts/eval-compare.mjs eval/results/<baseline>.json eval/results/<candidate>.json
import fs from "node:fs";

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error(
    "Usage: node scripts/eval-compare.mjs <baseline.json> <candidate.json>",
  );
  process.exit(2);
}

const load = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const a = load(fileA);
const b = load(fileB);

console.log(`Baseline : ${a.sha} (${a.ts}, ${a.results.length} cases)`);
console.log(`Candidate: ${b.sha} (${b.ts}, ${b.results.length} cases)`);

const byCase = (r) => Object.fromEntries(r.results.map((x) => [x.case, x]));
const aMap = byCase(a);
const bMap = byCase(b);

let failures = 0;

// ── Global pass rate ─────────────────────────────────────────────────
const passRate = (r) => r.results.filter((x) => x.ok).length / r.results.length;
const aPass = passRate(a);
const bPass = passRate(b);
const deltaPp = (bPass - aPass) * 100;
console.log(
  `\nPass rate: ${(aPass * 100).toFixed(1)}% → ${(bPass * 100).toFixed(1)}% (${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(1)}pp)`,
);
if (aPass - bPass > 0.05) {
  console.error(`❌ Pass rate drop > 5pp`);
  failures++;
}

// ── Per-case regression ──────────────────────────────────────────────
for (const [caseName, av] of Object.entries(aMap)) {
  const bv = bMap[caseName];
  if (!bv) {
    console.warn(`⚠ Case ${caseName} missing in candidate`);
    continue;
  }

  if (av.ok && !bv.ok) {
    console.error(
      `❌ ${caseName}: pass → FAIL (${bv.error ?? "no error msg"})`,
    );
    failures++;
  }

  if (
    typeof av.placeholderCount === "number" &&
    typeof bv.placeholderCount === "number"
  ) {
    const diff = bv.placeholderCount - av.placeholderCount;
    if (diff > 2) {
      console.error(
        `❌ ${caseName}: placeholderCount ${av.placeholderCount} → ${bv.placeholderCount} (+${diff})`,
      );
      failures++;
    }
  }

  if (!av.budgetExceeded && bv.budgetExceeded) {
    console.error(`❌ ${caseName}: budgetExceeded false → true`);
    failures++;
  }
  if (!av.semaphoreTimedOut && bv.semaphoreTimedOut) {
    console.error(`❌ ${caseName}: semaphoreTimedOut false → true`);
    failures++;
  }

  // Gate issues baru = sinyal regresi kualitas
  const newIssues = (bv.gateIssues || []).filter(
    (code) => !(av.gateIssues || []).includes(code),
  );
  if (newIssues.length > 0) {
    console.warn(`⚠ ${caseName}: new gate issue(s): ${newIssues.join(", ")}`);
  }
}

// ── Latency ──────────────────────────────────────────────────────────
const avgMs = (r) =>
  r.results.reduce((s, x) => s + (x.ms || 0), 0) / r.results.length;
const aMs = avgMs(a);
const bMs = avgMs(b);
console.log(`\nAvg latency: ${Math.round(aMs)}ms → ${Math.round(bMs)}ms`);
if (bMs > aMs * 1.5) {
  console.error(`❌ Avg latency increased >50%`);
  failures++;
}

if (failures > 0) {
  console.error(`\n❌ ${failures} regression(s) detected`);
  process.exit(1);
}

console.log(`\n✅ No regression`);
process.exit(0);
