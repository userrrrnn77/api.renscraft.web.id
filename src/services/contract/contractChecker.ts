// src/services/contract/contractChecker.ts
//
// Checks the files against each other and the contract, and fixes what can be
// fixed safely. Fixes are text edits at AST positions (see astUtils.ts), so the
// model's formatting is left untouched.
//
// Used twice:
//   - after generation (every file, every pass)
//   - after a chat revision (revisionCheck.ts): only the files the revision
//     touched may be edited, see `scope`
//
// Passes, in order:
//   1. theme    shared ThemeProvider/useTheme wiring
//   2. exports  missing `export` / default export, imports of names that don't exist
//   3. anchors  section ids and #links that point nowhere
//   4. icons    Font Awesome classes that don't exist in the loaded FA version
//   5. facts    founded year / city that disagree with the plan (factsFix.ts)
//
// Safety nets, so the checker can never make a project worse:
//   - a pass that throws is rolled back
//   - parse gate: after every pass, a file that parsed before and no longer parses
//     is reverted, and the fixes it claimed are reported as NOT applied
//   - a file that does not parse to begin with is skipped (the per-file syntax
//     gate in ai.js already retries those)
import path from "node:path";
import * as t from "@babel/types";
import {
  analyzeModule,
  applyEdits,
  findDefaultComponent,
  findReturnedJsx,
  importInsertion,
  jsxAttribute,
  parseModule,
  range,
  referencedNames,
  walk,
  type Edit,
  type ModuleInfo,
} from "../../utils/astUtils.js";
import { FA_BRANDS, FA_REGULAR, FA_SOLID, FA_TERMS } from "./faIcons.js";
import { fixFacts } from "./factsFix.js";
import {
  THEME_EXPORTS,
  THEME_VALUE_KEYS,
  relImport,
  type ProjectContract,
} from "./projectContract.js";

export interface ContractIssue {
  path: string;
  message: string;
  fixed: boolean;
  severity: string;
}

export interface CheckResult {
  files: Record<string, string>;
  // only the files whose content changed (path -> new code)
  fixed: Record<string, string>;
  issues: ContractIssue[];
}

export interface Ctx {
  files: Record<string, string>;
  contract: ProjectContract;
  issues: ContractIssue[];
  // Files a pass may edit. null = all of them. A revision only edits the files it
  // touched; the rest of the project is read, never rewritten (apart from an
  // export a touched file needs, see exportPass).
  scope: ReadonlySet<string> | null;
}

export type Pass = (ctx: Ctx) => void;
export type NamedPass = readonly [name: string, pass: Pass];

export interface CheckOptions {
  passes?: readonly NamedPass[];
  scope?: ReadonlySet<string> | null;
}

const isJs = (p: string): boolean => /\.(jsx?|tsx?)$/i.test(p);
const SUFFIXES = ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.jsx"];

const inScope = (ctx: Ctx, p: string): boolean =>
  ctx.scope === null || ctx.scope.has(p);

function note(
  ctx: Ctx,
  p: string,
  message: string,
  fixed: boolean,
  severity = "blocking",
): void {
  ctx.issues.push({ path: p, message, fixed, severity });
}

function resolveImport(
  from: string,
  spec: string,
  paths: Set<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.resolve(path.posix.dirname(from), spec);
  for (const s of SUFFIXES) if (paths.has(base + s)) return base + s;
  return null;
}

const importedName = (spec: t.ImportSpecifier): string =>
  t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;

const jsFiles = (ctx: Ctx): string[] => Object.keys(ctx.files).filter(isJs);

const stringValue = (
  node: t.Node | null | undefined,
): t.StringLiteral | null => {
  if (!node) return null;
  if (t.isStringLiteral(node)) return node;
  if (t.isJSXExpressionContainer(node) && t.isStringLiteral(node.expression)) {
    return node.expression;
  }
  return null;
};

// ── 1. Theme ────────────────────────────────────────────────────────────────

type ThemeName = (typeof THEME_EXPORTS)[number];
const THEME_NAMES: readonly ThemeName[] = THEME_EXPORTS;
const isThemeName = (n: string): n is ThemeName =>
  (THEME_NAMES as readonly string[]).includes(n);

function mapThemeExport(name: string): ThemeName | null {
  if (/^use/i.test(name)) return "useTheme";
  if (/provider/i.test(name)) return "ThemeProvider";
  if (/context|ctx/i.test(name)) return "ThemeContext";
  return null;
}

function mapThemeKey(key: string): string | null {
  if (/toggle|switch/i.test(key)) return "toggleTheme";
  if (/^set/i.test(key)) return "setTheme";
  if (/dark|light/i.test(key)) return "isDark";
  if (/theme|mode/i.test(key)) return "theme";
  return null;
}

function isThemeHookCall(node: t.Node): boolean {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return false;
  if (node.callee.name === "useTheme") return true;
  return (
    node.callee.name === "useContext" &&
    t.isIdentifier(node.arguments[0], { name: "ThemeContext" })
  );
}

// `const a = 1, ThemeContext = ...;` and `export const ...` both declare variables
function variableDeclarationOf(stmt: t.Node): t.VariableDeclaration | null {
  if (t.isVariableDeclaration(stmt)) return stmt;
  if (
    t.isExportNamedDeclaration(stmt) &&
    t.isVariableDeclaration(stmt.declaration)
  ) {
    return stmt.declaration;
  }
  return null;
}

// Text for a `const` after some of its declarators are gone. The separators the
// model wrote (", " or ",\n  ") are kept, so only the removed variables disappear.
function declarationsWithout(
  code: string,
  decls: t.VariableDeclarator[],
  gone: ReadonlySet<t.VariableDeclarator>,
): Edit | null {
  const first = decls[0];
  const last = decls[decls.length - 1];
  if (!first || !last) return null;
  let text = "";
  const kept = decls.filter((d) => !gone.has(d));
  for (const d of kept) {
    const r = range(d);
    text += code.slice(r.start, r.end);
    const next = decls[decls.indexOf(d) + 1];
    if (d !== kept[kept.length - 1] && next)
      text += code.slice(r.end, range(next).start);
  }
  return { start: range(first).start, end: range(last).end, text };
}

function themePass(ctx: Ctx): void {
  const { themePath, needsTheme, entryPath } = ctx.contract;
  if (!needsTheme || !themePath) return;
  const paths = new Set(Object.keys(ctx.files));
  const themeRel = (p: string) => relImport(p, themePath);

  for (const p of jsFiles(ctx)) {
    if (p === themePath || !inScope(ctx, p)) continue;
    const code = ctx.files[p] ?? "";
    const ast = parseModule(code);
    if (!ast) continue;
    const info = analyzeModule(ast);
    const edits: Edit[] = [];
    const messages: string[] = [];

    // a) local copies of the theme plumbing are replaced by the shared one
    const removedNodes = new Set<t.Node>(); // what referencedNames must not look into
    const removedNames = new Set<string>();
    const partial = new Map<
      t.VariableDeclaration,
      { stmt: t.Node; gone: Set<t.VariableDeclarator> }
    >();
    const reexport: string[] = [];
    for (const name of THEME_NAMES) {
      const stmt = info.decls.get(name);
      if (!stmt) continue;
      if (t.isExportDefaultDeclaration(stmt)) {
        note(
          ctx,
          p,
          `defines its own default-exported ${name}; could not replace it with ${themePath}`,
          false,
          "warning",
        );
        continue;
      }

      const vd = variableDeclarationOf(stmt);
      if (vd) {
        // only this variable goes, not the others declared in the same `const`
        const declarator = vd.declarations.find((d) =>
          t.isIdentifier(d.id, { name }),
        );
        if (!declarator) continue;
        const entry = partial.get(vd) ?? {
          stmt,
          gone: new Set<t.VariableDeclarator>(),
        };
        entry.gone.add(declarator);
        partial.set(vd, entry);
        removedNodes.add(declarator);
      } else {
        if (removedNodes.has(stmt)) continue;
        removedNodes.add(stmt);
        const r = range(stmt);
        edits.push({ start: r.start, end: r.end, text: "" });
      }
      removedNames.add(name);
      // only an `export const X` / `export function X` has to be re-exported; a
      // separate `export { X }` keeps working through the import added below
      if (t.isExportNamedDeclaration(stmt)) reexport.push(name);
      messages.push(`removed local ${name}, using ${themePath}`);
    }
    for (const [vd, { stmt, gone }] of partial) {
      if (gone.size >= vd.declarations.length) {
        const r = range(stmt);
        edits.push({ start: r.start, end: r.end, text: "" });
        continue;
      }
      const edit = declarationsWithout(code, vd.declarations, gone);
      if (edit) edits.push(edit);
    }

    // b) imports that already point at the theme file: repair wrong names
    const bound = new Set<string>();
    for (const imp of info.imports) {
      for (const spec of imp.specifiers) bound.add(spec.local.name);
      const target = resolveImport(p, imp.source.value, paths);

      // theme names imported from some other file (or a theme file that was never
      // planned): point the whole import at the shared theme file
      if (
        target !== themePath &&
        imp.specifiers.length > 0 &&
        imp.specifiers.every(
          (s) => t.isImportSpecifier(s) && isThemeName(importedName(s)),
        ) &&
        (target !== null || /theme/i.test(imp.source.value))
      ) {
        const r = range(imp.source);
        const quote = code.charAt(r.start) || "'";
        edits.push({
          start: r.start,
          end: r.end,
          text: `${quote}${themeRel(p)}${quote}`,
        });
        messages.push(`theme import from ${imp.source.value} -> ${themePath}`);
        continue;
      }
      if (target !== themePath) continue;

      for (const spec of imp.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) {
          const local = spec.local.name;
          if (imp.specifiers.length !== 1) continue;
          const mapped = mapThemeExport(local);
          if (mapped && mapped !== "ThemeProvider") {
            const r = range(spec);
            edits.push({
              start: r.start,
              end: r.end,
              text: `{ ${mapped}${local === mapped ? "" : ` as ${local}`} }`,
            });
            messages.push(`default import ${local} -> { ${mapped} }`);
          }
        } else if (t.isImportSpecifier(spec)) {
          const name = importedName(spec);
          if (isThemeName(name)) continue;
          const mapped = mapThemeExport(name);
          const r = range(spec);
          if (mapped) {
            const local = spec.local.name;
            edits.push({
              start: r.start,
              end: r.end,
              text: local === mapped ? mapped : `${mapped} as ${local}`,
            });
            messages.push(`import ${name} -> ${mapped}`);
          } else {
            note(
              ctx,
              p,
              `imports { ${name} } from the theme file, which only exports ${THEME_NAMES.join(", ")}`,
              false,
              "warning",
            );
          }
        }
      }
    }

    // c) names used but never imported
    const refs = referencedNames(ast, (n) => removedNodes.has(n));
    const needed = THEME_NAMES.filter((n) => {
      if (!refs.has(n) || bound.has(n)) return false;
      return !info.decls.has(n) || removedNames.has(n);
    });

    // d) App must render the provider
    if (p === entryPath && !refs.has("ThemeProvider")) {
      const fn = findDefaultComponent(ast);
      const jsx = fn ? findReturnedJsx(fn) : null;
      if (jsx) {
        const r = range(jsx);
        edits.push({ start: r.start, end: r.start, text: "<ThemeProvider>\n" });
        edits.push({ start: r.end, end: r.end, text: "\n</ThemeProvider>" });
        if (!needed.includes("ThemeProvider")) needed.push("ThemeProvider");
        messages.push("wrapped App in <ThemeProvider>");
      } else {
        note(
          ctx,
          p,
          "App does not render <ThemeProvider> and its returned JSX is not a plain element",
          false,
          "warning",
        );
      }
    }

    // e) destructuring keys the provider does not have (toggleDarkMode -> toggleTheme)
    walk(ast.program, (node) => {
      if (
        !t.isVariableDeclarator(node) ||
        !t.isObjectPattern(node.id) ||
        !node.init ||
        !isThemeHookCall(node.init)
      ) {
        return;
      }
      for (const prop of node.id.properties) {
        if (
          !t.isObjectProperty(prop) ||
          prop.computed ||
          !t.isIdentifier(prop.key)
        )
          continue;
        const key = prop.key.name;
        if ((THEME_VALUE_KEYS as readonly string[]).includes(key)) continue;
        const mapped = mapThemeKey(key);
        if (mapped && t.isIdentifier(prop.value)) {
          const r = range(prop);
          edits.push({
            start: r.start,
            end: r.end,
            text: `${mapped}: ${prop.value.name}`,
          });
          messages.push(`theme value ${key} -> ${mapped}`);
        } else {
          note(
            ctx,
            p,
            `reads "${key}" from the theme, which only provides ${THEME_VALUE_KEYS.join(", ")}`,
            false,
            "warning",
          );
        }
      }
    });

    if (needed.length > 0) {
      const ins = importInsertion(ast);
      edits.push({
        start: ins.pos,
        end: ins.pos,
        text: `${ins.prefix}import { ${needed.join(", ")} } from '${themeRel(p)}';${ins.suffix}`,
      });
      messages.push(`added import { ${needed.join(", ")} } from theme`);
    }
    if (reexport.length > 0) {
      edits.push({
        start: code.length,
        end: code.length,
        text: `\nexport { ${reexport.join(", ")} } from '${themeRel(p)}';\n`,
      });
    }

    if (edits.length > 0) {
      ctx.files[p] = applyEdits(code, edits);
      for (const m of messages) note(ctx, p, m, true);
    }
  }
}

// ── 2. Exports / imports ────────────────────────────────────────────────────

interface Parsed {
  code: string;
  ast: t.File;
  info: ModuleInfo;
}

function pickDefaultCandidate(
  info: ModuleInfo,
  filePath: string,
): string | null {
  const base = path.posix
    .basename(filePath)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  const names = [...info.decls.keys()].filter((n) => /^[A-Z]/.test(n));
  const byName = names.find((n) => n.toLowerCase() === base);
  if (byName) return byName;
  return names.length === 1 ? (names[0] ?? null) : null;
}

function exportPass(ctx: Ctx): void {
  const paths = new Set(Object.keys(ctx.files));
  const parsed = new Map<string, Parsed>();
  for (const p of jsFiles(ctx)) {
    const code = ctx.files[p] ?? "";
    const ast = parseModule(code);
    if (ast) parsed.set(p, { code, ast, info: analyzeModule(ast) });
  }

  const edits = new Map<string, Edit[]>();
  const messages = new Map<string, string[]>();
  const seen = new Set<string>();
  const added = new Set<string>(); // "default@/x.js" | "Name@/x.js"

  const push = (p: string, edit: Edit, message: string): void => {
    const key = `${p}:${edit.start}:${edit.end}:${edit.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const list = edits.get(p) ?? [];
    list.push(edit);
    edits.set(p, list);
    const msgs = messages.get(p) ?? [];
    msgs.push(message);
    messages.set(p, msgs);
  };

  const addNamedExport = (p: string, name: string): boolean => {
    const f = parsed.get(p);
    const stmt = f?.info.decls.get(name);
    if (!f || !stmt) return false;
    if (t.isExportNamedDeclaration(stmt)) return true;
    if (t.isExportDefaultDeclaration(stmt)) {
      push(
        p,
        {
          start: f.code.length,
          end: f.code.length,
          text: `\nexport { ${name} };\n`,
        },
        `exported ${name}`,
      );
    } else {
      const { start } = range(stmt);
      push(p, { start, end: start, text: "export " }, `exported ${name}`);
    }
    added.add(`${name}@${p}`);
    return true;
  };

  const addDefaultExport = (p: string, name: string): void => {
    const f = parsed.get(p);
    if (!f) return;
    push(
      p,
      {
        start: f.code.length,
        end: f.code.length,
        text: `\nexport default ${name};\n`,
      },
      `added default export ${name}`,
    );
    added.add(`default@${p}`);
  };

  // a) what the contract promised
  for (const fc of ctx.contract.files) {
    const f = parsed.get(fc.path);
    if (!f || fc.serverContent || !inScope(ctx, fc.path)) continue;

    if (
      fc.defaultExport &&
      !f.info.hasDefault &&
      !added.has(`default@${fc.path}`)
    ) {
      const name = f.info.decls.has(fc.defaultExport)
        ? fc.defaultExport
        : pickDefaultCandidate(f.info, fc.path);
      if (name) addDefaultExport(fc.path, name);
      else
        note(
          ctx,
          fc.path,
          `has no default export (contract: ${fc.defaultExport})`,
          false,
          "warning",
        );
    }

    if (!f.info.exportsAll) {
      for (const name of fc.namedExports) {
        if (f.info.named.has(name) || added.has(`${name}@${fc.path}`)) continue;
        if (!addNamedExport(fc.path, name)) {
          note(
            ctx,
            fc.path,
            `does not export ${name} (contract)`,
            false,
            "warning",
          );
        }
      }
    }
  }

  // b) what other files actually import. The fix lands in the imported file, so
  // it is checked when EITHER side is in scope: a touched file may need an export
  // from one that was not touched, and an untouched file may import something a
  // touched file just stopped exporting.
  for (const [from, f] of parsed) {
    for (const imp of f.info.imports) {
      const target = resolveImport(from, imp.source.value, paths);
      const tf = target ? parsed.get(target) : undefined;
      if (!target || !tf) continue;
      if (!inScope(ctx, from) && !inScope(ctx, target)) continue;

      for (const spec of imp.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) {
          if (tf.info.hasDefault || added.has(`default@${target}`)) continue;
          const name = pickDefaultCandidate(tf.info, target);
          if (name) addDefaultExport(target, name);
          else
            note(
              ctx,
              from,
              `imports default from ${target}, which has no default export`,
              false,
              "warning",
            );
        } else if (t.isImportSpecifier(spec)) {
          const name = importedName(spec);
          if (name === "default" || tf.info.exportsAll) continue;
          if (tf.info.named.has(name) || added.has(`${name}@${target}`))
            continue;
          if (!addNamedExport(target, name)) {
            note(
              ctx,
              from,
              `imports { ${name} } from ${target}, which does not define it`,
              false,
              "warning",
            );
          }
        }
      }
    }
  }

  for (const [p, list] of edits) {
    const f = parsed.get(p);
    if (!f) continue;
    ctx.files[p] = applyEdits(f.code, list);
    for (const m of messages.get(p) ?? []) note(ctx, p, m, true);
  }
}

// ── 3. Anchors ──────────────────────────────────────────────────────────────

const HREF_KEYS = new Set(["href", "to", "link", "url", "path"]);
const ANCHOR_RE = /^#[A-Za-z][\w-]*$/;
const SYNONYMS: string[][] = [
  ["home", "hero", "beranda", "top", "banner", "welcome", "utama"],
  [
    "about",
    "aboutus",
    "tentang",
    "tentangkami",
    "story",
    "ourstory",
    "whoweare",
  ],
  ["menu", "menus", "ourmenu", "daftarmenu", "produk", "products"],
  [
    "contact",
    "contactus",
    "kontak",
    "kontakkami",
    "hubungi",
    "location",
    "lokasi",
    "findus",
    "visit",
  ],
  ["services", "service", "layanan", "features", "fitur"],
  ["gallery", "galeri", "portfolio", "photos"],
  ["testimonials", "testimonial", "testimoni", "reviews", "ulasan"],
  ["pricing", "price", "harga", "plans", "paket"],
  ["team", "tim", "ourteam"],
  ["faq", "faqs"],
];
const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");

function findAnchorMatch(target: string, ids: Set<string>): string | null {
  const nt = letters(target);
  for (const id of ids) if (letters(id) === nt) return id;
  const group = SYNONYMS.find((g) => g.includes(nt));
  if (!group) return null;
  for (const id of ids) if (group.includes(letters(id))) return id;
  return null;
}

function collectIds(ast: t.File): Set<string> {
  const ids = new Set<string>();
  walk(ast.program, (node) => {
    if (
      t.isJSXAttribute(node) &&
      t.isJSXIdentifier(node.name, { name: "id" })
    ) {
      const lit = stringValue(node.value);
      if (lit) ids.add(lit.value);
      else if (
        t.isJSXExpressionContainer(node.value) &&
        t.isTemplateLiteral(node.value.expression) &&
        node.value.expression.expressions.length === 0
      ) {
        ids.add(
          node.value.expression.quasis
            .map((q) => q.value.cooked ?? "")
            .join(""),
        );
      }
    }
  });
  return ids;
}

function collectAnchorLinks(ast: t.File): t.StringLiteral[] {
  const out: t.StringLiteral[] = [];
  walk(ast.program, (node) => {
    if (
      t.isJSXAttribute(node) &&
      t.isJSXIdentifier(node.name, { name: "href" })
    ) {
      const lit = stringValue(node.value);
      if (lit && ANCHOR_RE.test(lit.value)) out.push(lit);
    } else if (
      t.isObjectProperty(node) &&
      !node.computed &&
      t.isStringLiteral(node.value)
    ) {
      const key = t.isIdentifier(node.key)
        ? node.key.name
        : t.isStringLiteral(node.key)
          ? node.key.value
          : "";
      if (HREF_KEYS.has(key) && ANCHOR_RE.test(node.value.value))
        out.push(node.value);
    }
  });
  return out;
}

interface AnchorScan {
  parsed: Map<string, { code: string; ast: t.File }>;
  ids: Set<string>;
  // id -> the files that carry it
  owners: Map<string, Set<string>>;
  // "#x" link targets used anywhere in the project (without the #)
  linked: Set<string>;
}

function scanAnchors(ctx: Ctx): AnchorScan {
  const scan: AnchorScan = {
    parsed: new Map(),
    ids: new Set(),
    owners: new Map(),
    linked: new Set(),
  };
  for (const p of jsFiles(ctx)) {
    const code = ctx.files[p] ?? "";
    const ast = parseModule(code);
    if (!ast) continue;
    scan.parsed.set(p, { code, ast });
    for (const id of collectIds(ast)) {
      scan.ids.add(id);
      const set = scan.owners.get(id) ?? new Set<string>();
      set.add(p);
      scan.owners.set(id, set);
    }
    for (const lit of collectAnchorLinks(ast))
      scan.linked.add(lit.value.slice(1));
  }
  return scan;
}

function rootOf(ast: t.File): t.JSXElement | null {
  const fn = findDefaultComponent(ast);
  const jsx = fn ? findReturnedJsx(fn) : null;
  return jsx && t.isJSXElement(jsx) ? jsx : null;
}

function anchorPass(ctx: Ctx): void {
  // a) the root element of a section carries the contract id
  const first = scanAnchors(ctx);
  for (const fc of ctx.contract.files) {
    const want = fc.sectionId;
    if (!want || !isJs(fc.path) || !inScope(ctx, fc.path)) continue;
    const entry = first.parsed.get(fc.path);
    if (!entry) continue;
    const { code, ast } = entry;

    // the id exists in this file (on the root or deeper): the anchor works
    if (collectIds(ast).has(want)) continue;

    const root = rootOf(ast);
    if (!root) {
      note(
        ctx,
        fc.path,
        `cannot add id='${want}': the returned JSX is not a plain element`,
        false,
        "warning",
      );
      continue;
    }

    const attr = jsxAttribute(root, "id");
    const current = attr ? stringValue(attr.value) : null;
    const taken = [...(first.owners.get(want) ?? [])].some(
      (o) => o !== fc.path,
    );

    if (attr) {
      if (!current) {
        note(
          ctx,
          fc.path,
          `root id is not a plain string, cannot set it to '${want}'`,
          false,
          "warning",
        );
      } else if (first.linked.has(current.value)) {
        // somebody links to it, so it was renamed on purpose (or the link is right)
        note(
          ctx,
          fc.path,
          `root id is '${current.value}', the contract wants '${want}' (kept: #${current.value} is linked)`,
          false,
          "warning",
        );
      } else if (taken) {
        note(
          ctx,
          fc.path,
          `root id is '${current.value}', the contract wants '${want}' but another file already uses it`,
          false,
          "warning",
        );
      } else {
        // an id nobody links to: back to the contract id, so the links that do
        // exist (nav, footer) keep working
        const r = range(attr);
        ctx.files[fc.path] = applyEdits(code, [
          { start: r.start, end: r.end, text: `id='${want}'` },
        ]);
        note(ctx, fc.path, `root id '${current.value}' -> '${want}'`, true);
      }
      continue;
    }

    if (taken) {
      note(
        ctx,
        fc.path,
        `cannot add id='${want}': another file already uses that id`,
        false,
        "warning",
      );
      continue;
    }
    if (
      !t.isJSXIdentifier(root.openingElement.name) ||
      !/^[a-z]/.test(root.openingElement.name.name)
    ) {
      note(
        ctx,
        fc.path,
        `cannot add id='${want}': the root is a component, not a plain element`,
        false,
        "warning",
      );
      continue;
    }
    const pos = range(root.openingElement.name).end;
    ctx.files[fc.path] = applyEdits(code, [
      { start: pos, end: pos, text: ` id='${want}'` },
    ]);
    note(ctx, fc.path, `added id='${want}' to the root element`, true);
  }

  // b) links to ids that do not exist are pointed at the closest real id
  const scan = scanAnchors(ctx);
  if (scan.ids.size === 0) return;

  for (const [p, { code, ast }] of scan.parsed) {
    if (!inScope(ctx, p)) continue;
    const edits: Edit[] = [];
    for (const lit of collectAnchorLinks(ast)) {
      const target = lit.value.slice(1);
      if (scan.ids.has(target)) continue;
      const match = findAnchorMatch(target, scan.ids);
      const r = range(lit);
      if (match) {
        const quote = code.charAt(r.start) || "'";
        edits.push({
          start: r.start,
          end: r.end,
          text: `${quote}#${match}${quote}`,
        });
        note(ctx, p, `link #${target} -> #${match}`, true);
      } else {
        note(
          ctx,
          p,
          `link #${target} points to an id that does not exist`,
          false,
          "warning",
        );
      }
    }
    if (edits.length > 0) ctx.files[p] = applyEdits(code, edits);
  }
}

// ── 4. Font Awesome icons ───────────────────────────────────────────────────

const SOLID = new Set(FA_SOLID);
const REGULAR = new Set(FA_REGULAR);
const BRANDS = new Set(FA_BRANDS);
const ANY_ICON = new Set([...FA_SOLID, ...FA_REGULAR, ...FA_BRANDS]);

type IconStyle = "solid" | "regular" | "brands";

const MODIFIER_RE =
  /^fa-(solid|regular|brands|light|thin|duotone|sharp|fw|lg|xs|sm|2xs|xl|2xl|[1-9]x|10x|spin|pulse|spin-pulse|spin-reverse|beat|beat-fade|fade|bounce|flip|flip-horizontal|flip-vertical|flip-both|shake|rotate-\d+|rotate-by|border|inverse|stack|stack-[12]x|li|ul|pull-left|pull-right|layers|layers-text|layers-counter|swap-opacity)$/;
const STYLE_TOKENS: Record<string, IconStyle> = {
  "fa-solid": "solid",
  fas: "solid",
  "fa-regular": "regular",
  far: "regular",
  "fa-brands": "brands",
  fab: "brands",
};
const PRO_STYLES = new Set([
  "fa-light",
  "fa-thin",
  "fa-duotone",
  "fa-sharp",
  "fal",
  "fat",
  "fad",
]);

// own keys only: a class string can contain any word, "constructor" included
const styleOf = (token: string): IconStyle | null =>
  Object.hasOwn(STYLE_TOKENS, token) ? (STYLE_TOKENS[token] ?? null) : null;

// names the model likes to invent -> a real icon
const ICON_ALIASES: Record<string, string> = {
  "coffee-beans": "mug-hot",
  "coffee-bean": "mug-hot",
  "google-maps": "location-dot",
  "map-marker": "location-dot",
  "x-twitter": "twitter",
  "bowl-food": "bowl-rice",
  "tiktok-alt": "tiktok",
};

const STOP_WORDS = new Set([
  "fa",
  "icon",
  "alt",
  "outline",
  "solid",
  "regular",
  "brands",
]);

function bestIcon(bad: string, family: Set<string>): string | null {
  const words = bad
    .split("-")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  if (words.length === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const name of family) {
    const terms = FA_TERMS[name] ?? name.split("-");
    let score = words.filter((w) => terms.includes(w)).length;
    if (score === 0) continue;
    if (name.split("-").some((n) => words.includes(n))) score += 0.5;
    if (
      score > bestScore ||
      (score === bestScore && best !== null && name.length < best.length)
    ) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

interface IconFix {
  from: string;
  // null: nothing can be changed safely, `message` is only reported
  to: string | null;
  message: string;
}

// tokens of one class string -> replacements (token text -> new token text).
//
// `forced` is the style the icon is RENDERED with, for an icon name that lives in
// a data object (`{ icon: 'fa-google-maps' }` rendered as `fa-brands ${x.icon}`).
// The data string has no style token to switch, so the fix has to stay inside that
// style: a brand icon becomes another brand icon, never a solid one.
function fixIconClasses(
  value: string,
  forced: IconStyle | null = null,
): IconFix[] {
  const tokens = value.split(/\s+/).filter(Boolean);
  const fixes: IconFix[] = [];

  let style: IconStyle | null = forced;
  let styleToken: string | null = null;
  for (const tk of tokens) {
    const own = styleOf(tk);
    if (own) {
      style = own;
      styleToken = tk;
    } else if (PRO_STYLES.has(tk)) {
      // Pro styles are not in the free CDN build
      fixes.push({
        from: tk,
        to: "fa-solid",
        message: `${tk} is Font Awesome Pro -> fa-solid`,
      });
      style = "solid";
    }
  }
  if (
    !style &&
    !(tokens.length === 1 && /^fa-[a-z0-9-]+$/.test(tokens[0] ?? ""))
  )
    return fixes;

  const iconToken = tokens.find(
    (tk) => tk.startsWith("fa-") && !MODIFIER_RE.test(tk),
  );
  if (!iconToken) return fixes;
  const name = iconToken.slice(3);
  const family =
    style === "regular" ? REGULAR : style === "brands" ? BRANDS : SOLID;
  if (style ? family.has(name) : ANY_ICON.has(name)) return fixes;

  const strict = forced !== null && styleToken === null;

  // exists, but in another style: switch the style token
  if (style && styleToken) {
    const other: Array<[IconStyle, Set<string>]> = [
      ["solid", SOLID],
      ["brands", BRANDS],
      ["regular", REGULAR],
    ];
    for (const [s, set] of other) {
      if (s !== style && set.has(name)) {
        fixes.push({
          from: styleToken,
          to: `fa-${s}`,
          message: `fa-${name} is not in ${style}, switched to ${s}`,
        });
        return fixes;
      }
    }
  }

  if (strict && style) {
    // a real icon that the rendering style does not have: replacing it with a
    // "similar" one would be a guess, so it is only reported
    if (ANY_ICON.has(name)) {
      fixes.push({
        from: iconToken,
        to: null,
        message: `fa-${name} does not exist in fa-${style}, but the data is rendered with fa-${style}`,
      });
      return fixes;
    }
    const aliased = Object.hasOwn(ICON_ALIASES, name)
      ? ICON_ALIASES[name]
      : undefined;
    const candidate =
      (aliased && family.has(aliased) ? aliased : null) ??
      bestIcon(name, family) ??
      (style === "brands" ? null : "circle");
    fixes.push(
      candidate
        ? {
            from: iconToken,
            to: `fa-${candidate}`,
            message: `unknown icon fa-${name} -> fa-${candidate} (${style})`,
          }
        : {
            from: iconToken,
            to: null,
            message: `unknown icon fa-${name}, no close match in fa-${style}`,
          },
    );
    return fixes;
  }

  const aliased = Object.hasOwn(ICON_ALIASES, name)
    ? ICON_ALIASES[name]
    : undefined;
  const candidate =
    (aliased && ANY_ICON.has(aliased) ? aliased : null) ??
    bestIcon(name, style ? family : SOLID) ??
    (style === "brands" ? null : "circle");

  if (candidate) {
    if (style === "brands" && !BRANDS.has(candidate) && styleToken) {
      fixes.push({
        from: styleToken,
        to: "fa-solid",
        message: `brand icon ${name} does not exist, using solid`,
      });
    }
    fixes.push({
      from: iconToken,
      to: `fa-${candidate}`,
      message: `unknown icon fa-${name} -> fa-${candidate}`,
    });
  } else if (styleToken) {
    fixes.push({
      from: iconToken,
      to: "fa-link",
      message: `unknown icon fa-${name} -> fa-link`,
    });
    fixes.push({
      from: styleToken,
      to: "fa-solid",
      message: "brand fallback uses solid",
    });
  }
  return fixes;
}

// ── where an icon name is rendered ──
//
// `{ icon: 'fa-google-maps' }` says nothing about its style; the style is in the
// JSX that renders it: className={`fa-brands ${social.icon}`}. This reads those
// render sites (in ANY file) and returns property name -> the styles it is
// rendered with. A property rendered with one style only is "forced" to it.

const CLASS_HELPERS = new Set([
  "clsx",
  "cn",
  "classNames",
  "classnames",
  "twMerge",
  "cx",
]);

function flattenClass(node: t.Node): Array<string | t.Node> {
  if (t.isStringLiteral(node)) return [node.value];
  if (t.isTemplateLiteral(node)) {
    const out: Array<string | t.Node> = [];
    node.quasis.forEach((q, i) => {
      out.push(q.value.cooked ?? "");
      const e = node.expressions[i];
      if (e) out.push(e);
    });
    return out;
  }
  if (t.isBinaryExpression(node, { operator: "+" })) {
    return [...flattenClass(node.left), ...flattenClass(node.right)];
  }
  if (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    CLASS_HELPERS.has(node.callee.name)
  ) {
    return node.arguments.flatMap((a) => flattenClass(a));
  }
  return [node];
}

function propertyKeyOf(node: t.Node): string | null {
  if (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    !node.computed &&
    t.isIdentifier(node.property)
  ) {
    return node.property.name;
  }
  return t.isIdentifier(node) ? node.name : null;
}

function collectIconStyles(
  parsed: Iterable<t.File>,
): Map<string, Set<IconStyle>> {
  const result = new Map<string, Set<IconStyle>>();
  for (const ast of parsed) {
    walk(ast.program, (node) => {
      const isSite =
        t.isTemplateLiteral(node) ||
        t.isBinaryExpression(node, { operator: "+" }) ||
        (t.isCallExpression(node) &&
          t.isIdentifier(node.callee) &&
          CLASS_HELPERS.has(node.callee.name));
      if (!isSite) return;

      const pieces = flattenClass(node);
      const styles = new Set<IconStyle>();
      for (const piece of pieces) {
        if (typeof piece !== "string") continue;
        for (const tk of piece.split(/\s+/)) {
          const s = styleOf(tk) ?? (PRO_STYLES.has(tk) ? "solid" : null);
          if (s) styles.add(s);
        }
      }
      if (styles.size !== 1) return;
      const style = [...styles][0];
      if (!style) return;

      pieces.forEach((piece, i) => {
        if (typeof piece === "string") return;
        const key = propertyKeyOf(piece);
        if (!key) return;
        // `fa-${x.icon}`: the data holds the bare name, not an `fa-` token
        const prev = pieces[i - 1];
        if (typeof prev === "string" && /fa-$/.test(prev)) return;
        const set = result.get(key) ?? new Set<IconStyle>();
        set.add(style);
        result.set(key, set);
      });
    });
  }
  return result;
}

function forcedStyleFor(
  node: t.Node,
  parent: t.Node | null,
  value: string,
  iconStyles: Map<string, Set<IconStyle>>,
): IconStyle | null {
  if (!t.isObjectProperty(parent) || parent.value !== node || parent.computed)
    return null;
  const key = t.isIdentifier(parent.key)
    ? parent.key.name
    : t.isStringLiteral(parent.key)
      ? parent.key.value
      : null;
  const styles = key ? iconStyles.get(key) : undefined;
  if (!styles || styles.size !== 1) return null;

  // only a bare icon name: a string with its own style token decides for itself
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (
    !tokens.every(
      (tk) => tk.startsWith("fa-") && !styleOf(tk) && !PRO_STYLES.has(tk),
    )
  )
    return null;
  return [...styles][0] ?? null;
}

function iconPass(ctx: Ctx): void {
  // render sites are read from every file, even the ones that may not be edited
  const asts = new Map<string, t.File>();
  for (const p of jsFiles(ctx)) {
    const ast = parseModule(ctx.files[p] ?? "");
    if (ast) asts.set(p, ast);
  }
  const iconStyles = collectIconStyles(asts.values());

  for (const [p, ast] of asts) {
    if (!inScope(ctx, p)) continue;
    const code = ctx.files[p] ?? "";
    if (!/\bfa[sbrl]?-|\bfa\b/.test(code)) continue;

    const edits: Edit[] = [];
    const messages: string[] = [];
    const consider = (
      node: t.Node,
      parent: t.Node | null,
      value: string,
    ): void => {
      if (!/(^|\s)fa-|(^|\s)(fas|far|fab)(\s|$)/.test(value)) return;
      const fixes = fixIconClasses(
        value,
        forcedStyleFor(node, parent, value, iconStyles),
      );
      if (fixes.length === 0) return;

      const real = fixes.filter(
        (f): f is IconFix & { to: string } => f.to !== null,
      );
      for (const f of fixes)
        if (f.to === null) note(ctx, p, f.message, false, "warning");
      if (real.length === 0) return;

      const r = range(node);
      let text = code.slice(r.start, r.end);
      for (const f of real) {
        const re = new RegExp(
          `(?<![\\w-])${f.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
        );
        text = text.replace(re, f.to);
        messages.push(f.message);
      }
      edits.push({ start: r.start, end: r.end, text });
    };

    walk(ast.program, (node, parent) => {
      if (t.isStringLiteral(node)) consider(node, parent, node.value);
      else if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
        consider(
          node,
          parent,
          node.quasis.map((q) => q.value.cooked ?? "").join(""),
        );
      }
    });

    if (edits.length > 0) {
      ctx.files[p] = applyEdits(code, edits);
      for (const m of messages) note(ctx, p, m, true);
    }
  }
}

// ── 5. Facts ────────────────────────────────────────────────────────────────

// The plan's facts (founded year, city) are a prompt rule; a file can still say
// something else. factsFix.ts corrects only what is unambiguous and reports the rest.
function factsPass(ctx: Ctx): void {
  if (Object.keys(ctx.contract.facts).length === 0) return;
  for (const p of jsFiles(ctx)) {
    if (!inScope(ctx, p)) continue;
    const code = ctx.files[p] ?? "";
    const ast = parseModule(code);
    if (!ast) continue;
    const result = fixFacts(code, ast, ctx.contract.facts);
    if (result.edits.length > 0) {
      ctx.files[p] = applyEdits(code, result.edits);
      for (const m of result.fixed) note(ctx, p, m, true);
    }
    for (const m of result.open) note(ctx, p, m, false, "warning");
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

export const GENERATION_PASSES: readonly NamedPass[] = [
  ["theme", themePass],
  ["exports", exportPass],
  ["anchors", anchorPass],
  ["icons", iconPass],
  ["facts", factsPass],
];

// Facts belong to the first generation: a revision may change the year or the
// city on purpose, so it never gets the facts pass.
export const REVISION_PASSES: readonly NamedPass[] = GENERATION_PASSES.filter(
  ([name]) => name !== "facts",
);

// Fixes a pass reported from `fromIndex` on are marked as NOT applied.
function revertClaims(
  ctx: Ctx,
  fromIndex: number,
  paths: ReadonlySet<string> | null,
  reason: string,
): void {
  for (let i = fromIndex; i < ctx.issues.length; i++) {
    const issue = ctx.issues[i];
    if (!issue || !issue.fixed || (paths && !paths.has(issue.path))) continue;
    issue.fixed = false;
    issue.message = `${issue.message} (reverted: ${reason})`;
  }
}

// One pass, isolated: a bug in a pass, or an edit that breaks a file, must never
// lose the generated project.
function runPass(ctx: Ctx, name: string, pass: Pass): void {
  const snapshot = { ...ctx.files };
  const mark = ctx.issues.length;

  try {
    pass(ctx);
  } catch (err) {
    ctx.files = snapshot;
    revertClaims(ctx, mark, null, `${name} pass crashed`);
    note(
      ctx,
      "*",
      `${name} pass crashed: ${err instanceof Error ? err.message : String(err)}`,
      false,
      "warning",
    );
    return;
  }

  // parse gate: a file that parsed before this pass has to parse after it
  const broken = new Set<string>();
  for (const [p, code] of Object.entries(ctx.files)) {
    const before = snapshot[p];
    if (before === undefined || before === code || !isJs(p)) continue;
    if (parseModule(code) || !parseModule(before)) continue;
    ctx.files[p] = before;
    broken.add(p);
  }
  if (broken.size > 0) {
    revertClaims(ctx, mark, broken, "the file no longer parses");
    for (const p of broken) {
      note(
        ctx,
        p,
        `${name} pass: the file does not parse after the fix, change reverted`,
        false,
        "warning",
      );
    }
  }
}

export function checkContract(
  input: Record<string, string>,
  contract: ProjectContract,
  options: CheckOptions = {},
): CheckResult {
  const ctx: Ctx = {
    files: { ...input },
    contract,
    issues: [],
    scope: options.scope ?? null,
  };

  for (const [name, pass] of options.passes ?? GENERATION_PASSES) {
    runPass(ctx, name, pass);
  }

  const fixed: Record<string, string> = {};
  for (const [p, code] of Object.entries(ctx.files)) {
    if (input[p] !== code) fixed[p] = code;
  }
  return { files: ctx.files, fixed, issues: ctx.issues };
}
