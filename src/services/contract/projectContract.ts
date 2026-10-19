// src/services/contract/projectContract.ts
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

export interface ProjectPlan {
  files: PlanFile[];
  projectName: string;
  projectDescription: string;
  facts?: PlanFacts;
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

export interface ProjectContract {
  entryPath: string;
  needsTheme: boolean;
  themePath: string | null;
  files: FileContract[];
  // ids that nav/footer links may point to
  anchors: string[];
  facts: Record<string, string>;
}

export const THEME_EXPORTS = ["ThemeContext", "ThemeProvider", "useTheme"] as const;
export const THEME_VALUE_KEYS = ["theme", "isDark", "setTheme", "toggleTheme"] as const;
const DEFAULT_THEME_PATH = "/context/ThemeContext.js";

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
  const result = { defaultExport: null as string | null, namedExports: [] as string[] };
  if (!isJs(filePath)) return result;

  const text = String(spec ?? "").trim();
  if (text && !/^(none|n\/a|-)$/i.test(text)) {
    for (const rawToken of text.split(/[,;]|\band\b/i)) {
      const token = rawToken.trim();
      if (!token) continue;
      const def = token.match(/^(?:export\s+)?default(?:\s+(?:function|class|const))?(?:\s+([A-Za-z_$][\w$]*))?$/i);
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
    if (/^\/App\.jsx?$/i.test(norm(filePath)) || /\/components\//i.test(filePath)) {
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
export const NON_SECTION_RE = /^(header|navbar|nav|navigation|topbar|menubar|footer|sidebar|modal|button|card|logo|themetoggle|themeprovider|themecontext)$/i;

function cleanFacts(facts: PlanFacts | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts ?? {})) {
    const text = String(value ?? "").trim();
    if (text) out[key] = text;
  }
  return out;
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
      (f) => isJs(f.path) && /^theme(context|provider)$/i.test(baseName(f.path)),
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
  const hasNav = files.some((f) => isJs(f.path) && NAV_RE.test(baseName(f.path)));
  const sectionFiles = files.filter(
    (f) =>
      hasNav &&
      isJs(f.path) &&
      /^\/components\//i.test(f.path) &&
      !NON_SECTION_RE.test(baseName(f.path)),
  );
  const sectionIds = new Map(sectionFiles.map((f) => [f.path, kebab(baseName(f.path))]));

  // 3. per-file contract
  const contractFiles: FileContract[] = files.map((f) => {
    const exp = parseExports(f.exports, f.path);
    return {
      path: f.path,
      defaultExport: exp.defaultExport,
      namedExports: exp.namedExports,
      serverContent: f.path === themePath ? THEME_CONTEXT_SOURCE : null,
      sectionId: sectionIds.get(f.path) ?? null,
    };
  });

  const entry = files.find((f) => /^\/App\.jsx?$/i.test(f.path))?.path ?? "/App.js";

  return {
    plan: { ...rawPlan, files },
    contract: {
      entryPath: entry,
      needsTheme,
      themePath,
      files: contractFiles,
      anchors: [...sectionIds.values()],
      facts: cleanFacts(rawPlan.facts),
    },
  };
}

// ── contract -> prompt text ─────────────────────────────────────────────────

function importLine(from: string, fc: FileContract): string | null {
  if (!fc.defaultExport && fc.namedExports.length === 0) return null;
  const src = relImport(from, fc.path);
  const named = fc.namedExports.length ? `{ ${fc.namedExports.join(", ")} }` : "";
  const parts = [fc.defaultExport ?? "", named].filter(Boolean).join(", ");
  return `import ${parts} from '${src}';`;
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
    const who = fc.serverContent ? " [written by the server, do NOT write it]" : "";
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
      lines.push(`- It MUST export \`${n}\` with the \`export\` keyword (\`export const ${n} = ...\`). A declaration without \`export\` breaks every file that imports it.`);
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
    lines.push(`- Section ids that exist: ${contract.anchors.map((a) => `#${a}`).join(", ")}.`);
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
    lines.push("", "### Shared facts (use EXACTLY these values in every file, never invent different ones)");
    for (const [k, v] of facts) lines.push(`- ${k}: ${v}`);
  }

  return lines.join("\n");
}
