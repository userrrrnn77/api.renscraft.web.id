// src/services/contract/revisionCheck.ts
//
// The same checks as at generation, for a chat revision.
//
// Generation fixes the contract once, but a revision rewrites files with a model
// that never saw it, so every revision could bring the old bugs back (a local
// ThemeProvider, a component without its export, an invented icon). Nothing is
// stored for that: the contract is derived from the files as they were BEFORE the
// revision, so it describes what the project promised and what the revision must
// not break. Older projects, generated before the contract existed, work too.
//
// Scope: only files the revision changed may be edited. The rest of the project
// is read, never rewritten, apart from the two fixes that have to land in another
// file (an export a touched file needs, a link a renamed id broke).
//
// C4: a derived contract has no design tokens. The project's current design is
// whatever its files already contain; the revision prompt keeps everything it
// does not need to touch, so no design block is rendered.
import path from "node:path";
import * as t from "@babel/types";
import {
  analyzeModule,
  findDefaultComponent,
  findReturnedJsx,
  jsxAttribute,
  parseModule,
} from "../../utils/astUtils.js";
import {
  REVISION_PASSES,
  checkContract,
  type ContractIssue,
} from "./contractChecker.js";
import { hashContent } from "../diff.js";
import { fixStylesheets } from "./cssFix.js";
import {
  NAV_RE,
  NON_SECTION_RE,
  THEME_EXPORTS,
  type FileContract,
  type ProjectContract,
} from "./projectContract.js";

export interface RevisionCheck {
  files: Record<string, string>;
  // path -> new code, only for files the check changed
  changed: Record<string, string>;
  issues: ContractIssue[];
  notes: string[];
}

const isJs = (p: string): boolean => /\.(jsx?|tsx?)$/i.test(p);
const isCss = (p: string): boolean => /\.css$/i.test(p);
const baseName = (p: string): string =>
  path.posix.basename(p).replace(/\.[^.]+$/, "");

function rootIdOf(code: string): string | null {
  const ast = parseModule(code);
  if (!ast) return null;
  const fn = findDefaultComponent(ast);
  const root = fn ? findReturnedJsx(fn) : null;
  if (!root || !t.isJSXElement(root)) return null;
  const attr = jsxAttribute(root, "id");
  const value = attr?.value;
  if (t.isStringLiteral(value)) return value.value;
  if (
    t.isJSXExpressionContainer(value) &&
    t.isStringLiteral(value.expression)
  ) {
    return value.expression.value;
  }
  return null;
}

// What the project looks like now, written as a contract.
export function deriveContract(files: Record<string, string>): ProjectContract {
  const jsPaths = Object.keys(files).filter(isJs);
  const hasNav = jsPaths.some((p) => NAV_RE.test(baseName(p)));

  let themePath: string | null = null;
  const fileContracts: FileContract[] = [];

  for (const p of jsPaths) {
    const code = files[p] ?? "";
    const ast = parseModule(code);
    const empty: FileContract = {
      path: p,
      defaultExport: null,
      namedExports: [],
      serverContent: null,
      sectionId: null,
    };
    if (!ast) {
      fileContracts.push(empty);
      continue;
    }
    const info = analyzeModule(ast);

    // the shared theme file: the one that exports the whole theme API
    if (
      themePath === null &&
      /^theme(context|provider)$/i.test(baseName(p)) &&
      THEME_EXPORTS.every((n) => info.named.has(n))
    ) {
      themePath = p;
    }

    const isSection =
      hasNav && /^\/components\//i.test(p) && !NON_SECTION_RE.test(baseName(p));
    fileContracts.push({
      ...empty,
      defaultExport: info.hasDefault ? (info.defaultName ?? baseName(p)) : null,
      namedExports: [...info.named],
      sectionId: isSection ? rootIdOf(code) : null,
    });
  }

  return {
    entryPath: jsPaths.find((p) => /^\/App\.jsx?$/i.test(p)) ?? "/App.js",
    needsTheme: themePath !== null,
    themePath,
    files: fileContracts,
    anchors: fileContracts.flatMap((f) => (f.sectionId ? [f.sectionId] : [])),
    // facts belong to the original plan; a revision may change them on purpose
    facts: {},
    // C4: no design block for a derived contract, the current design is
    // whatever the existing files already contain.
    design: null,
  };
}

// before / after: path -> code, as they were before and after the revision.
export async function checkRevision(
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<RevisionCheck> {
  const touched = new Set(
    Object.keys(after).filter((p) => after[p] !== before[p]),
  );
  const result: RevisionCheck = {
    files: after,
    changed: {},
    issues: [],
    notes: [],
  };
  if (touched.size === 0) return result;

  const contract = deriveContract(before);
  // the revision removed the theme file: there is nothing left to wire to
  if (contract.themePath && !Object.hasOwn(after, contract.themePath)) {
    contract.needsTheme = false;
    contract.themePath = null;
  }

  const check = checkContract(after, contract, {
    passes: REVISION_PASSES,
    scope: touched,
  });
  result.files = check.files;
  result.changed = { ...check.fixed };
  result.issues = check.issues;

  // Tailwind @apply / @layer in a stylesheet the revision touched: the preview
  // runs Tailwind from the CDN, which leaves such a rule empty (see cssFix.ts)
  const touchedCss: Record<string, string> = {};
  for (const [p, code] of Object.entries(check.files)) {
    if (touched.has(p) && isCss(p)) touchedCss[p] = code;
  }
  if (Object.keys(touchedCss).length > 0) {
    try {
      const style = await fixStylesheets(touchedCss);
      for (const [p, code] of Object.entries(style.fixed)) {
        result.files[p] = code;
        result.changed[p] = code;
      }
      result.notes.push(...style.notes);
    } catch (err) {
      // a stylesheet pass must never lose a revision
      result.notes.push(
        `stylesheet pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

// ── project.files adapter ───────────────────────────────────────────────────
// Stored files are { content, hash } entries. Returns the entries with the
// checker's fixes applied (new objects for the changed files only) and a short
// list of what was fixed, for the log and the API response.

export type FileEntry = { content: string; hash: string };

const contentsOf = (
  entries: Record<string, unknown>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [p, entry] of Object.entries(entries ?? {})) {
    const content = (entry as { content?: unknown } | null)?.content;
    if (typeof content === "string") out[p] = content;
  }
  return out;
};

export async function repairRevisionEntries<T extends Record<string, unknown>>(
  beforeEntries: Record<string, unknown>,
  afterEntries: T,
): Promise<{
  entries: T | Record<string, unknown>;
  autoFixes: string[];
  notes: string[];
}> {
  const check = await checkRevision(
    contentsOf(beforeEntries),
    contentsOf(afterEntries),
  );
  const changedPaths = Object.keys(check.changed);
  const autoFixes = check.issues
    .filter((i) => i.fixed)
    .map((i) => `${i.path}: ${i.message}`);
  for (const p of changedPaths) {
    if (!autoFixes.some((f) => f.startsWith(`${p}:`)))
      autoFixes.push(`${p}: stylesheet expanded`);
  }
  if (changedPaths.length === 0)
    return { entries: afterEntries, autoFixes, notes: check.notes };

  const entries: Record<string, unknown> = { ...afterEntries };
  for (const [p, code] of Object.entries(check.changed)) {
    entries[p] = { content: code, hash: hashContent(code) };
  }
  return { entries, autoFixes, notes: check.notes };
}
