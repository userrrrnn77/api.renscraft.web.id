// FILE: src/services/contract/projectContract.ts
//
// The "project contract": everything that has to be identical across files, fixed
// BEFORE any file is generated.
//
// Why: generateProject writes files in parallel and blind. Header guesses the
// shape of ThemeContext, Hero guesses its own id, About invents another founding
// year. The contract removes the guessing:
//   1. plan -> contract (who exports what, which ids exist, shared facts)
//   2. the server writes the shared plumbing itself (ThemeContext), the model
//      never touches it
//   3. every file prompt gets the contract (renderContractPrompt)
//   4. contractChecker.ts verifies + auto-fixes the result afterwards
import path from "node:path";
import { generateRenstraftSdk } from "./dynamicSdk.js";
import { isDynamicAppsEnabled } from "../../config/env.js";

// ── Plan (what the planner returns) ─────────────────────────────────────────

export interface PlanFile {
  path: string;
  description: string;
  exports?: string;
  imports?: string[];
}

export interface PlanFacts {
  businessName?: string;
  tagline?: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  openingHours?: string;
  foundedYear?: string | number;
}

// C4: design tokens. All fields optional on the planner side; defaults are
// applied in applyContractToPlan.
export interface PlanDesign {
  accent?: string;
  font?: string;
  radius?: string;
}

export interface PlanDataSpec {
  collections: Array<{
    name: string;
    label: string;
    fields: Array<{
      key: string;
      label: string;
      type: string;
      required?: boolean;
      options?: string[];
    }>;
  }>;
}

export interface ProjectPlan {
  files: PlanFile[];
  projectName: string;
  projectDescription: string;
  facts?: PlanFacts;
  design?: PlanDesign;
  dataSpec?: PlanDataSpec;
}

// ── Contract ────────────────────────────────────────────────────────────────

export interface FileContract {
  path: string;
  defaultExport: string | null;
  namedExports: string[];
  // set for files the server writes itself; the model never generates them
  serverContent: string | null;
  // id the file's root element must carry, when other files link to it (#hero)
  sectionId: string | null;
}

// Design V2: the preset attached by designFromBrief() when PROMPT_V2 is on and
// the project has a brief. The shape mirrors vibePresets.js exactly (id, source,
// hint, tokens, dark, fonts, radius, border, shadow, avoid, note).
export interface DesignPreset {
  id: string;
  source: string;
  hint: string;
  tokens: {
    bg: string;
    surface: string;
    ink: string;
    muted: string;
    line: string;
    accent: string;
    accentInk: string;
    accent2?: string;
    accent3?: string;
    bgImage?: string;
  };
  dark: {
    bg: string;
    surface: string;
    ink: string;
    muted: string;
    line: string;
    accent?: string;
    accentInk?: string;
  } | null;
  fonts: {
    display: { family: string; weights: string; kind: string };
    body: { family: string; weights: string; kind: string };
    code?: { family: string; weights: string; kind: string };
  };
  radius: string;
  border: string;
  shadow: string;
  avoid: string[];
  note: string;
}

// C4: design tokens. Non-null for a fresh generation (defaults applied).
// null for a derived contract (revision): the project's current design is
// whatever its files already contain, so no design block is rendered.
//
// Design V2: `preset` is optional. When present, renderContractPrompt writes the
// "Design system" block instead of the legacy "Design tokens" block, and
// designTokens.js injects the CSS variables into /styles.css.
export interface DesignTokens {
  accent: string;
  font: string;
  radius: string;
  preset?: DesignPreset | null;
}

export interface ProjectContract {
  entryPath: string;
  needsTheme: boolean;
  themePath: string | null;
  files: FileContract[];
  // ids that nav/footer links may point to
  anchors: string[];
  facts: Record<string, string>;
  design: DesignTokens | null;
}

export const THEME_EXPORTS = [
  "ThemeContext",
  "ThemeProvider",
  "useTheme",
] as const;
export const THEME_VALUE_KEYS = [
  "theme",
  "isDark",
  "setTheme",
  "toggleTheme",
] as const;
const DEFAULT_THEME_PATH = "/context/ThemeContext.js";

// C4: defaults when the planner omits design (or leaves a field empty).
export const DEFAULT_DESIGN: DesignTokens = {
  accent: "indigo-600",
  font: "Inter",
  radius: "rounded-2xl",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const norm = (p: string): string => (p.startsWith("/") ? p : `/${p}`);
const isJs = (p: string): boolean => /\.(jsx?|tsx?)$/i.test(p);
const baseName = (p: string): string =>
  path.posix.basename(p).replace(/\.[^.]+$/, "");

export function relImport(from: string, to: string): string {
  const rel = path.posix
    .relative(path.posix.dirname(norm(from)), norm(to))
    .replace(/\.(jsx?|tsx?)$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

const kebab = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

// "default Header" | "named ThemeContext, useTheme" | "none" | "Header"
export function parseExports(
  spec: string | undefined,
  filePath: string,
): { defaultExport: string | null; namedExports: string[] } {
  const result = {
    defaultExport: null as string | null,
    namedExports: [] as string[],
  };
  if (!isJs(filePath)) return result;

  const text = String(spec ?? "").trim();
  if (text && !/^(none|n\/a|-)$/i.test(text)) {
    for (const rawToken of text.split(/[,;]|\band\b/i)) {
      const token = rawToken.trim();
      if (!token) continue;
      const def = token.match(
        /^(?:export\s+)?default(?:\s+(?:function|class|const))?(?:\s+([A-Za-z_$][\w$]*))?$/i,
      );
      if (def) {
        result.defaultExport = def[1] ?? baseName(filePath);
        continue;
      }
      const named = token.match(
        /^(?:named\s+|export\s+(?:const|function|class)\s+)?([A-Za-z_$][\w$]*)$/i,
      );
      if (named?.[1] && !/^(named|none)$/i.test(named[1])) {
        result.namedExports.push(named[1]);
      }
    }
  }

  // /App.js always needs a default export; so does every component
  if (!result.defaultExport && result.namedExports.length === 0) {
    if (
      /^\/App\.jsx?$/i.test(norm(filePath)) ||
      /\/components\//i.test(filePath)
    ) {
      result.defaultExport = baseName(filePath);
    }
  }
  return result;
}

// ── Theme detection ─────────────────────────────────────────────────────────

// Only a real dark/light TOGGLE needs shared theme state. "dark mode" alone means
// one dark design (the prompts already handle that).
//
// "dark" and "light" are also coffee roasts and colours ("dark dan light roast",
// "dark and light blue", "nuansa gelap dan terang"), so a dark/light pair only
// counts when what follows is a theme word or the end of the clause, and not when
// a colour word comes before it.
const DARK = "dark|gelap";
const LIGHT = "light|terang";
const DARK_OR_LIGHT = `${DARK}|${LIGHT}`;

// What may follow "dark" / "light" when they mean the theme: a theme word, the end
// of the clause, or punctuation. "light roast" and "dark blue" do not pass.
const THEME_TAIL = String.raw`(?=[ \t]*(?:$|[\n.,;:!?)\]/&-])|\s+(?:mode|theme|tema|version|variant|toggle|switch(?:er)?|support|option|opsi|and|dan|atau|or)\b)`;
const PAIR_SEP = String.raw`(?:\s*[/&-]\s*|\s+(?:and|dan|atau|or)\s+)`;
const pairRe = (a: string, b: string): RegExp =>
  new RegExp(
    String.raw`\b(?:mode\s+)?(?:${a})(?:\s+mode)?${PAIR_SEP}(?:mode\s+)?(?:${b})\b${THEME_TAIL}`,
    "gi",
  );
const PAIR_RES = [pairRe(DARK, LIGHT), pairRe(LIGHT, DARK)];
const COLOUR_BEFORE =
  /(?:nuansa|warna|palet(?:te)?|perpaduan|kombinasi|gradasi|campuran|shades?|tones?|colou?rs?)\s*$/i;

const TOGGLE_PATTERNS: RegExp[] = [
  // "theme toggle", "dark mode switch", "ThemeToggle", "dark/light toggle"
  /(?:dark|light|gelap|terang|theme|tema)[\s-]*(?:mode\s*)?(?:toggle|switch(?:er)?)\b/i,
  // "toggle theme", "switch the theme", "tombol tema", "tombol ganti tema"
  /\b(?:toggle|switch|tombol|button)\s+(?:(?:untuk|to|for)\s+)?(?:(?:ganti|ubah|tukar|change|switch|toggle)\s+)?(?:the\s+)?(?:theme|tema)\b/i,
  // "toggle dark mode", "ganti tema gelap terang", but not "ganti dark roast ke light roast"
  new RegExp(
    String.raw`\b(?:toggle|switch|ganti|ubah|tukar|tombol|button)\s+(?:(?:to|ke|between)\s+)?(?:the\s+)?(?:(?:theme|tema)\s+)?(?:mode\s+)?(?:${DARK_OR_LIGHT})(?:\s*[/&-]?\s*(?:${DARK_OR_LIGHT}))?\b${THEME_TAIL}`,
    "i",
  ),
  // "tema gelap terang" (no connector)
  new RegExp(
    String.raw`\b(?:theme|tema)\s+(?:${DARK})\s+(?:${LIGHT})\b${THEME_TAIL}`,
    "i",
  ),
];

function textWantsToggle(text: string): boolean {
  if (TOGGLE_PATTERNS.some((re) => re.test(text))) return true;
  return PAIR_RES.some((re) =>
    [...text.matchAll(re)].some(
      (m) => !COLOUR_BEFORE.test(text.slice(0, m.index ?? 0)),
    ),
  );
}

export function wantsThemeToggle(prompt: string, plan?: ProjectPlan): boolean {
  if (textWantsToggle(prompt)) return true;
  if (!plan) return false;
  return plan.files.some(
    (f) =>
      (isJs(f.path) && /^theme(context|provider)$/i.test(baseName(f.path))) ||
      // a plan description gets the same test as the prompt: "toggle between light
      // and dark roast" in a menu filter is not a theme toggle
      textWantsToggle(f.description),
  );
}

// ── Server-owned file: ThemeContext ─────────────────────────────────────────

// The model never writes this. It exposes everything a component could need, so
// "Header calls setTheme but the provider only has toggleTheme" cannot happen.
export const THEME_CONTEXT_SOURCE = `import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'theme';

function getInitialTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (e) {}
  return 'light';
}

export const ThemeContext = createContext({
  theme: 'light',
  isDark: false,
  setTheme: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {}
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      return value === 'dark' ? 'dark' : 'light';
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo(
    () => ({ theme, isDark: theme === 'dark', setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return React.createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme() {
  return useContext(ThemeContext);
}

export default ThemeProvider;
`;

// ── plan -> contract ────────────────────────────────────────────────────────

export const NAV_RE = /^(header|navbar|nav|navigation|topbar|menubar)$/i;
export const NON_SECTION_RE =
  /^(header|navbar|nav|navigation|topbar|menubar|footer|sidebar|modal|button|card|logo|themetoggle|themeprovider|themecontext)$/i;

function cleanFacts(facts: PlanFacts | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts ?? {})) {
    const text = String(value ?? "").trim();
    if (text) out[key] = text;
  }
  return out;
}

// C4: merge the planner's design (may be partial) with the defaults.
function cleanDesign(raw: PlanDesign | undefined): DesignTokens {
  const src = raw ?? {};
  const pick = (v: unknown, fallback: string): string => {
    const t = String(v ?? "").trim();
    return t.length > 0 ? t.slice(0, 60) : fallback;
  };
  return {
    accent: pick(src.accent, DEFAULT_DESIGN.accent),
    font: pick(src.font, DEFAULT_DESIGN.font),
    radius: pick(src.radius, DEFAULT_DESIGN.radius),
  };
}

export function applyContractToPlan(
  rawPlan: ProjectPlan,
  prompt: string,
): { plan: ProjectPlan; contract: ProjectContract } {
  const files: PlanFile[] = rawPlan.files.map((f) => ({
    ...f,
    path: norm(f.path),
    imports: [...(f.imports ?? [])],
  }));

  // 1. theme: the server owns the file
  const needsTheme = wantsThemeToggle(prompt, { ...rawPlan, files });
  let themePath: string | null = null;
  if (needsTheme) {
    const planned = files.find(
      (f) =>
        isJs(f.path) && /^theme(context|provider)$/i.test(baseName(f.path)),
    );
    themePath = planned?.path ?? DEFAULT_THEME_PATH;
    const entry = {
      path: themePath,
      description:
        "Theme context written by the server: ThemeProvider, ThemeContext, useTheme (theme, isDark, setTheme, toggleTheme)",
      // the file also has a default export, but it is deliberately not advertised:
      // one way to import it keeps the generated imports valid and uniform
      exports: "named ThemeContext, ThemeProvider, useTheme",
      imports: [],
    };
    if (planned) Object.assign(planned, entry);
    else files.push(entry);
  }

  // 2. which components are page sections that nav links can point to
  const hasNav = files.some(
    (f) => isJs(f.path) && NAV_RE.test(baseName(f.path)),
  );

  const dataSpec = isDynamicAppsEnabled() ? rawPlan.dataSpec : undefined;

  let sdkPath: string | null = null;
  if (dataSpec) {
    sdkPath = "/lib/renscraft.js";
    const sdkEntry = {
      path: sdkPath,
      description:
        "Database SDK written by the server. Import { db } from '../lib/renscraft'",
      exports: "named db",
      imports: [],
    };
    const planned = files.find((f) => f.path === sdkPath);
    if (planned) Object.assign(planned, sdkEntry);
    else files.push(sdkEntry);
  }

  const sectionFiles = files.filter(
    (f) =>
      hasNav &&
      isJs(f.path) &&
      /^\/components\//i.test(f.path) &&
      !NON_SECTION_RE.test(baseName(f.path)),
  );
  const sectionIds = new Map(
    sectionFiles.map((f) => [f.path, kebab(baseName(f.path))]),
  );

  // 3. per-file contract
  const contractFiles: FileContract[] = files.map((f) => {
    const exp = parseExports(f.exports, f.path);

    let serverContent = null;
    if (f.path === themePath) {
      serverContent = THEME_CONTEXT_SOURCE;
    } else if (f.path === sdkPath) {
      // ✅ SDK di-inject
      serverContent = generateRenstraftSdk("draft-slug", false);
    }

    return {
      path: f.path,
      defaultExport: exp.defaultExport,
      namedExports: exp.namedExports,
      serverContent,
      sectionId: sectionIds.get(f.path) ?? null,
    };
  });

  const entry =
    files.find((f) => /^\/App\.jsx?$/i.test(f.path))?.path ?? "/App.js";

  return {
    plan: { ...rawPlan, files, dataSpec },
    // Type 'PlanDataSpec | null' is not assignable to type 'PlanDataSpec | undefined'.
    // Type 'null' is not assignable to type 'PlanDataSpec | undefined'.
    contract: {
      entryPath: entry,
      needsTheme,
      themePath,
      files: contractFiles,
      anchors: [...sectionIds.values()],
      facts: cleanFacts(rawPlan.facts),
      design: cleanDesign(rawPlan.design),
    },
  };
}

// ── contract -> prompt text ─────────────────────────────────────────────────

function importLine(from: string, fc: FileContract): string | null {
  if (!fc.defaultExport && fc.namedExports.length === 0) return null;
  const src = relImport(from, fc.path);
  const named = fc.namedExports.length
    ? `{ ${fc.namedExports.join(", ")} }`
    : "";
  const parts = [fc.defaultExport ?? "", named].filter(Boolean).join(", ");
  return `import ${parts} from '${src}';`;
}

// Design V2: the prompt block that replaces the legacy "### Design tokens"
// section when a server-fixed preset is attached to the contract.
function renderDesignSystemBlock(preset: DesignPreset): string[] {
  const fonts = preset.fonts;
  const tokens = preset.tokens;

  const codePart = fonts.code ? `, code '${fonts.code.family}'` : "";
  const accent2Part = tokens.accent2 ? `, accent-2 ${tokens.accent2}` : "";
  const accent3Part = tokens.accent3 ? `, accent-3 ${tokens.accent3}` : "";
  const avoid = preset.avoid.join("; ");

  const block: string[] = [
    "### Design system (fixed by the server, use EXACTLY, it overrides any style default)",
    `- Style: ${preset.id}. ${preset.hint}`,
    `- Fonts: display '${fonts.display.family}', body '${fonts.body.family}'${codePart}. The server imports them in /styles.css.`,
    `- Radius: ${preset.radius}. Border: ${preset.border}. Shadow: ${preset.shadow}.`,
    `- Palette (already defined as CSS variables): bg ${tokens.bg}, surface ${tokens.surface}, ink ${tokens.ink}, muted ${tokens.muted}, line ${tokens.line}, accent ${tokens.accent} with text ${tokens.accentInk}${accent2Part}${accent3Part}.`,
    "- Semantic classes: bg-app bg-surface bg-tint bg-accent text-ink text-muted text-accent text-on-accent border-line border-accent font-display font-body font-code. For hover/focus/responsive states use typed values like hover:bg-[color:var(--c-accent)].",
    "- Colors from semantic classes switch by themselves in dark mode: no dark: counterpart needed.",
    `- Avoid: ${avoid}`,
  ];

  if (preset.note) {
    block.push(`- ${preset.note}`);
  }

  return block;
}

export function renderContractPrompt(
  contract: ProjectContract,
  filePath: string,
): string {
  const me = contract.files.find((f) => f.path === norm(filePath));
  const lines: string[] = [
    "## PROJECT CONTRACT (fixed by the server before any file was written, it OVERRIDES any conflicting rule above)",
    "All files are written in parallel by separate calls. These facts are the only thing that keeps them consistent. Follow them exactly.",
    "",
    "### Exports and how to import them",
  ];

  for (const fc of contract.files) {
    if (!isJs(fc.path)) continue;
    const exp = [
      fc.defaultExport ? `default ${fc.defaultExport}` : null,
      ...fc.namedExports.map((n) => `named ${n}`),
    ].filter(Boolean);
    const who = fc.serverContent
      ? " [written by the server, do NOT write it]"
      : "";
    const imp =
      fc.path === me?.path || fc.path === contract.entryPath
        ? null
        : importLine(filePath, fc);
    lines.push(
      `- ${fc.path}: exports ${exp.length ? exp.join(", ") : "nothing"}${who}${imp ? `\n    ${imp}` : ""}`,
    );
  }

  if (me && isJs(me.path)) {
    lines.push("", `### This file (${me.path})`);
    if (me.defaultExport) {
      lines.push(
        `- It MUST have exactly one default export named ${me.defaultExport}: \`export default function ${me.defaultExport}() { ... }\`.`,
      );
    }
    for (const n of me.namedExports) {
      lines.push(
        `- It MUST export \`${n}\` with the \`export\` keyword (\`export const ${n} = ...\`). A declaration without \`export\` breaks every file that imports it.`,
      );
    }
    lines.push(
      "- Import only names that other files really export (list above). Never import a name that is not listed.",
    );
  }

  if (contract.needsTheme && contract.themePath) {
    const themeImport = relImport(filePath, contract.themePath);
    lines.push("", "### Theme (dark/light toggle)");
    lines.push(
      `- ${contract.themePath} is written by the server. NEVER create your own ThemeContext, createContext, theme useState or theme useEffect, and never write that file.`,
    );
    if (norm(filePath) === contract.entryPath) {
      lines.push(
        `- Wrap everything App returns in <ThemeProvider> (\`import { ThemeProvider } from '${themeImport}';\`).`,
      );
    } else {
      lines.push(
        `- To read the theme: \`import { useTheme } from '${themeImport}'; const { theme, isDark, setTheme, toggleTheme } = useTheme();\`. Exactly these four values exist, nothing else.`,
        "- The toggle button (header/navbar) uses onClick={toggleTheme}, shows fa-sun when dark and fa-moon when light, and has an aria-label.",
        "- Components that only need colors use `dark:` classes and do not call useTheme at all.",
      );
    }
  }

  if (contract.anchors.length > 0) {
    lines.push("", "### Anchors");
    lines.push(
      `- Section ids that exist: ${contract.anchors.map((a) => `#${a}`).join(", ")}.`,
    );
    if (me?.sectionId) {
      lines.push(
        `- The root element of this file MUST be \`<section id='${me.sectionId}'>\` (keep that exact id).`,
      );
    }
    if (me && NAV_RE.test(baseName(me.path))) {
      lines.push(
        "- Navigation links (href='#...') may ONLY point to the ids above. Do not invent #home, #top or anything else that is not listed.",
      );
    }
  }

  const facts = Object.entries(contract.facts);
  if (facts.length > 0) {
    lines.push(
      "",
      "### Shared facts (use EXACTLY these values in every file, never invent different ones)",
    );
    for (const [k, v] of facts) lines.push(`- ${k}: ${v}`);
  }

  // C4: design tokens. Identical for every file of one generation, so the accent
  // and font cannot drift file to file. Omitted when the contract was derived
  // from existing files (revision): the project's current design is what its
  // files already contain.
  //
  // Design V2: when a preset is attached, its "Design system" block replaces the
  // legacy "Design tokens" block. Contracts without a preset still get exactly
  // the old block, byte-for-byte.
  if (contract.design) {
    if (contract.design.preset) {
      lines.push("", ...renderDesignSystemBlock(contract.design.preset));
    } else {
      lines.push(
        "",
        "### Design tokens (use EXACTLY these values in every file; do not pick another accent or font)",
        `- Accent: ${contract.design.accent} (use for every accent color: primary buttons, active states, gradient text stops, key highlights)`,
        `- Font: ${contract.design.font} (import from Google Fonts in /styles.css and set it on body)`,
        `- Radius: ${contract.design.radius} (use for cards, panels, buttons, inputs)`,
      );
    }
  }

  return lines.join("\n");
}
