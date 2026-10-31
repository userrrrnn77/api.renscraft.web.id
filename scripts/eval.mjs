// scripts/eval.mjs
//
// Eval suite skeleton (PRD F0). Jalankan dari root server/:
//   bun run eval
//
// Setiap file di eval/cases/*.mjs default-export sebuah async function yang
// mengembalikan metrik. Hasil disimpan ke eval/results/<git-sha>.json dan
// di-commit supaya baseline + regresi bisa dilacak.

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

const CASES_DIR = "eval/cases";
const RESULTS_DIR = "eval/results";

async function loadCases() {
  const filter = process.env.CASE
    ? new Set(
        process.env.CASE.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  const files = await fs.readdir(CASES_DIR).catch(() => []);
  return files
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => {
      if (!filter) return true;
      return filter.has(path.basename(f, ".mjs"));
    })
    .map((f) => path.join(CASES_DIR, f));
}

async function runCase(casePath) {
  const mod = await import(path.resolve(casePath));
  if (typeof mod.default !== "function") {
    throw new Error(`${casePath}: default export must be a function`);
  }
  return mod.default();
}

async function main() {
  const gitSha = execSync("git rev-parse --short HEAD").toString().trim();
  const cases = await loadCases();

  if (cases.length === 0) {
    console.error(
      `No cases found in ${CASES_DIR}/ — add at least one before running.`,
    );
    process.exit(1);
  }
  console.log(`Running ${cases.length} case(s) at ${gitSha}...\n`);

  const results = [];
  let failures = 0;

  for (const c of cases) {
    const startedAt = Date.now();
    try {
      const metrics = await runCase(c);
      const entry = {
        case: c,
        ok: true,
        ms: Date.now() - startedAt,
        ...metrics,
      };
      results.push(entry);
      console.log(`✅ ${c}  (${entry.ms}ms)`);
    } catch (err) {
      failures++;
      results.push({
        case: c,
        ok: false,
        ms: Date.now() - startedAt,
        error: err?.message ?? String(err),
      });
      console.log(`❌ ${c}  ${err?.message ?? err}`);
    }
  }

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${gitSha}.json`);
  await fs.writeFile(
    outFile,
    JSON.stringify(
      { sha: gitSha, ts: new Date().toISOString(), results },
      null,
      2,
    ),
  );
  console.log(`\nResults → ${outFile}`);
  console.log(`${results.length - failures}/${results.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
