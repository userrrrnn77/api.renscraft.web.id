// src/services/contract/cssFix.ts
//
// The preview runs Tailwind from the Play CDN (a <script> in the browser). The CDN
// only understands utilities in markup; it does NOT process `@apply`, `@layer`,
// `@tailwind` or `theme()` inside a normal CSS file. The model writes them anyway
// (it is how most Tailwind projects look):
//
//   .btn-primary { @apply inline-flex px-6 py-3 rounded-xl bg-indigo-600 ... }
//
// In the browser that rule silently becomes EMPTY, so every element using
// .btn-primary / .card-premium comes out unstyled.
//
// This pass runs the real Tailwind compiler over the stylesheet once, on the
// server, and stores plain CSS. Nothing in the preview has to change.
import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Root,
  type Rule,
} from "postcss";

export interface StyleFixResult {
  files: Record<string, string>;
  // only the stylesheets whose content changed
  fixed: Record<string, string>;
  notes: string[];
}

const DIRECTIVE_RE = /@(apply|tailwind|layer|screen|config)\b|\btheme\(/;
const isCss = (p: string): boolean => /\.css$/i.test(p);

type TailwindFactory = (config: Record<string, unknown>) => postcss.Plugin;
let tailwindPromise: Promise<TailwindFactory> | null = null;

// loaded lazily: most projects never need it, and it is ~100 ms to import
function loadTailwind(): Promise<TailwindFactory> {
  tailwindPromise ??= import("tailwindcss").then(
    (m) => (m as unknown as { default: TailwindFactory }).default,
  );
  return tailwindPromise;
}

const TAILWIND_CONFIG = {
  darkMode: "class",
  // @apply needs no content scan; an empty source keeps Tailwind quiet
  content: [{ raw: "", extension: "html" }],
  corePlugins: { preflight: false },
};

async function runTailwind(css: string): Promise<string> {
  const tailwind = await loadTailwind();
  const result = await postcss([tailwind(TAILWIND_CONFIG)]).process(css, {
    from: undefined,
  });
  return result.css;
}

// `@tailwind x;` is removed, `@layer x { ... }` is unwrapped. Both only make
// sense when Tailwind generates the whole stylesheet, which the CDN does instead.
function normalizeDirectives(root: Root): void {
  root.walkAtRules("tailwind", (rule) => {
    rule.remove();
  });
  root.walkAtRules("layer", (rule) => {
    if (rule.nodes && rule.nodes.length > 0) rule.replaceWith(rule.nodes);
    else rule.remove();
  });
}

const hasApply = (node: ChildNode): boolean => {
  let found = false;
  if (node.type === "atrule" && node.name === "apply") return true;
  if ("walkAtRules" in node) {
    (node as Container).walkAtRules("apply", () => {
      found = true;
      return false;
    });
  }
  return found;
};

// One bad class ("@apply text-brand-500" without such a color) makes Tailwind throw
// for the whole file. Retry rule by rule so only the broken rule loses its styles.
async function expandPerRule(root: Root, notes: string[]): Promise<void> {
  for (const node of [...(root.nodes ?? [])]) {
    if (node.type === "comment" || !hasApply(node)) continue;
    const source = node.toString();
    try {
      const out = await runTailwind(source);
      const parsed = postcss.parse(out);
      node.replaceWith(parsed.nodes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const label =
        node.type === "rule"
          ? (node as Rule).selector
          : `@${(node as AtRule).name}`;
      notes.push(
        `${label}: @apply failed (${message.split("\n")[0]}), @apply removed`,
      );
      (node as Container).walkAtRules("apply", (a) => {
        a.remove();
      });
    }
  }
}

export async function expandTailwindDirectives(
  css: string,
): Promise<{ css: string; changed: boolean; notes: string[] }> {
  if (!DIRECTIVE_RE.test(css)) return { css, changed: false, notes: [] };

  const notes: string[] = [];
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch {
    return {
      css,
      changed: false,
      notes: ["stylesheet does not parse, left untouched"],
    };
  }

  normalizeDirectives(root);
  const normalized = root.toString();

  if (!/@apply\b|\btheme\(/.test(normalized)) {
    notes.push("removed @tailwind / @layer directives");
    return { css: normalized, changed: normalized !== css, notes };
  }

  try {
    const out = await runTailwind(normalized);
    notes.push("expanded @apply into plain CSS");
    return { css: out, changed: true, notes };
  } catch {
    // fall through: find the broken rule(s)
  }

  await expandPerRule(root, notes);
  const out = root.toString();
  notes.push("expanded @apply into plain CSS (per rule)");
  return { css: out, changed: out !== css, notes };
}

export async function fixStylesheets(
  files: Record<string, string>,
): Promise<StyleFixResult> {
  const out: Record<string, string> = { ...files };
  const fixed: Record<string, string> = {};
  const notes: string[] = [];

  for (const [p, code] of Object.entries(files)) {
    if (!isCss(p)) continue;
    try {
      const res = await expandTailwindDirectives(code);
      if (res.changed) {
        out[p] = res.css;
        fixed[p] = res.css;
      }
      for (const n of res.notes) notes.push(`${p}: ${n}`);
    } catch (err) {
      // never lose a generated project over a stylesheet pass
      notes.push(
        `${p}: style pass crashed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return { files: out, fixed, notes };
}
