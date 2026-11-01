// scripts/test-design-v2.mjs (jalankan dari folder server: node --import tsx scripts/test-design-v2.mjs)
import assert from "node:assert";
import postcss from "postcss";
import {
  VIBE_PRESETS,
  CATEGORY_DEFAULT_PRESETS,
  designFromBrief,
} from "../src/services/brief/vibePresets.js";
import { injectDesignTokens } from "../src/services/contract/designTokens.js";
import { VIBE_OPTIONS } from "../src/services/brief/slotCatalog.js";
import { buildBase, BASE_SYSTEM } from "../src/services/prompts.js";

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    failures.push({ name, err });
  }
}

const briefWith = (category, vibe) => ({
  category,
  answers: vibe === undefined ? {} : { vibe: { value: vibe } },
});

// 1. Key VIBE_PRESETS == VIBE_OPTIONS (11 key, urutan sama)
check("VIBE_PRESETS keys match VIBE_OPTIONS (same order)", () => {
  assert.deepStrictEqual(Object.keys(VIBE_PRESETS), [...VIBE_OPTIONS]);
});

// 1b. Kandidat kategori valid dan hanya preset terang (dark !== null)
check("CATEGORY_DEFAULT_PRESETS points to valid light presets", () => {
  for (const [category, candidates] of Object.entries(
    CATEGORY_DEFAULT_PRESETS,
  )) {
    assert(
      Array.isArray(candidates) && candidates.length > 0,
      `Category "${category}" must be a non-empty array`,
    );
    for (const key of candidates) {
      const preset = VIBE_PRESETS[key];
      assert(preset, `Category "${category}" points to unknown preset "${key}"`);
      assert(
        preset.dark !== null,
        `Category "${category}" uses dark-native preset "${key}"`,
      );
    }
  }
});

// 2. Kontras WCAG: tokens (terang) + dark, hanya pasangan hex 6 digit
check("WCAG contrast >= 4.5 (light tokens and dark)", () => {
  const toRgb = (hex) =>
    typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex)
      ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      : null;
  const lum = (hex) => {
    const rgb = toRgb(hex);
    if (!rgb) return null;
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const bad = [];
  let compared = 0;
  for (const [id, preset] of Object.entries(VIBE_PRESETS)) {
    for (const mode of ["tokens", "dark"]) {
      const t = preset[mode];
      if (!t) continue;
      const bg = t.bg;
      const accent = t.accent ?? preset.tokens.accent;
      const accentInk = t.accentInk ?? preset.tokens.accentInk;
      const pairs = [
        ["ink/bg", t.ink, bg],
        ["muted/bg", t.muted, bg],
        ["accentInk/accent", accentInk, accent],
      ];
      for (const [label, c1, c2] of pairs) {
        const r = ratio(c1, c2);
        if (r === null) continue;
        compared++;
        if (r < 4.5) {
          bad.push(`${id} [${mode}] ${label} = ${r.toFixed(2)} (${c1} on ${c2})`);
        }
      }
    }
  }
  assert(compared > 0, "no contrast pairs were compared");
  assert.strictEqual(bad.length, 0, "Contrast < 4.5:\n    " + bad.join("\n    "));
});

// 3. designFromBrief
check("designFromBrief deterministic and correct sources", () => {
  const withVibe = briefWith("kuliner", "vintage / HANGAT"); // case-insensitive
  const a = designFromBrief(withVibe, "warkop andre");
  const b = designFromBrief(withVibe, "warkop andre");
  assert.deepStrictEqual(a, b, "not deterministic");
  assert.strictEqual(a.preset.source, "vibe");
  assert.strictEqual(a.preset.id, "Vintage / hangat");

  const noVibe = briefWith("kuliner", "");
  const c = designFromBrief(noVibe, "warkop andre");
  const d = designFromBrief(noVibe, "warkop andre");
  assert.deepStrictEqual(c, d, "category path not deterministic");
  assert.strictEqual(c.preset.source, "category");
  assert(CATEGORY_DEFAULT_PRESETS.kuliner.includes(c.preset.id));

  const unknown = designFromBrief(briefWith("kuliner", "ngawur"), "x");
  assert.strictEqual(unknown.preset.source, "category");

  assert.strictEqual(designFromBrief(null, "x"), null);
  assert.strictEqual(designFromBrief({}, "x"), null);
});

// 4. injectDesignTokens
check("injectDesignTokens: idempotent, marker once, @import on top, others untouched", () => {
  const files = {
    "/App.js": 'export default function App(){return null}',
    "/styles.css":
      "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');\n" +
      "@keyframes fadeIn{from{opacity:0}to{opacity:1}}\n.animate-fade-in{animation:fadeIn .4s}\n",
  };
  const contract = {
    design: designFromBrief(briefWith("kuliner", "Vintage / hangat"), "x"),
  };

  const out1 = injectDesignTokens(files, contract);
  const out2 = injectDesignTokens(out1, contract);
  assert.deepStrictEqual(out1, out2, "not idempotent");
  assert.strictEqual(out1["/App.js"], files["/App.js"], "non-CSS file changed");

  const css = out1["/styles.css"];
  const count = (re) => (css.match(re) || []).length;
  assert.strictEqual(count(/@server-design:start/g), 1, "start marker count");
  assert.strictEqual(count(/@server-design:end/g), 1, "end marker count");
  assert(css.includes("--c-accent"), "token variables missing");
  assert(css.includes("@keyframes fadeIn"), "original CSS lost");

  // semua @import harus sebelum rule/at-rule lain (kecuali @charset)
  const root = postcss.parse(css);
  let seenOther = false;
  root.each((node) => {
    if (node.type === "comment") return;
    if (node.type === "atrule" && node.name === "charset") return;
    if (node.type === "atrule" && node.name === "import") {
      assert(!seenOther, "@import appears after a non-import rule");
      return;
    }
    seenOther = true;
  });
  assert.strictEqual(css.trimStart().startsWith("@import"), true, "first @import not on top");

  // tanpa preset / tanpa styles.css: dikembalikan apa adanya
  assert.strictEqual(injectDesignTokens(files, {}), files);
  assert.strictEqual(injectDesignTokens(files, { design: null }), files);
  const noCss = { "/App.js": "x" };
  assert.strictEqual(injectDesignTokens(noCss, contract), noCss);
});

// 5. Flag PROMPT_V2
check("PROMPT_V2 flag", () => {
  const old = process.env.PROMPT_V2;
  try {
    delete process.env.PROMPT_V2;
    assert.strictEqual(buildBase({ hasBrief: false }), BASE_SYSTEM);
    process.env.PROMPT_V2 = "1";
    assert.strictEqual(buildBase({ hasBrief: false }), BASE_SYSTEM, "no-brief path changed by flag");
    const v2 = buildBase({ hasBrief: true });
    assert(v2.includes("bg-surface"), 'V2 base missing "bg-surface"');
    assert(!v2.includes("Plus Jakarta Sans"), 'V2 base still has "Plus Jakarta Sans"');
  } finally {
    if (old === undefined) delete process.env.PROMPT_V2;
    else process.env.PROMPT_V2 = old;
  }
});

if (failures.length) {
  console.error(`\n${failures.length} test(s) failed:`);
  for (const { name, err } of failures) console.error(`  - ${name}: ${err.message}`);
  process.exit(1);
}
console.log("\nAll tests passed.");
