// test-render.mjs — bisa dihapus abis test
import "dotenv/config";
import { buildReferenceContext } from '../src/services/webReference.js';

const { context, failed, assets } = await buildReferenceContext(
  "https://rensdev.my.id",
);

console.log("\n=== FAILED ===");
console.log(failed);

console.log("\n=== ASSETS ===");
console.log(`${assets.length} images`);
assets.slice(0, 5).forEach((u, i) => console.log(`  ref-img-0${i + 1}: ${u}`));

console.log("\n=== CONTEXT (first 2000 chars) ===");
console.log(context.slice(0, 2000));