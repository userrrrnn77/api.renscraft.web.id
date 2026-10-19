import fs from "node:fs";

const lines = fs.readFileSync("logs/usage.jsonl", "utf8").trim().split("\n");
const rows = lines.map((l) => JSON.parse(l));

const failed = rows.filter((r) => !r.ok);
const recent = failed.slice(-20);

console.log(`Total runs: ${rows.length}`);
console.log(`Failed: ${failed.length} (${(failed.length / rows.length * 100).toFixed(1)}%)`);
console.log("\nLast 20 failures:");
for (const r of recent) {
  console.log(`  ${r.ts}  ${r.kind}  ${r.error}`);
}