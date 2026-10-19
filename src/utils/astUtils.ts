// src/utils/astUtils.ts

// Small AST toolkit for the contract checker.
//
// Fixes are applied as text edits at node positions (never by re-printing the
// AST), so the formatting the model wrote is left exactly as it was.
import { parse } from "@babel/parser";
import * as t from "@babel/types";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function parseModule(code: string): t.File | null {
  try {
    return parse(code, { sourceType: "module", plugins: ["jsx"] });
  } catch {
    return null;
  }
}

const isNode = (value: unknown): value is t.Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

// Return false from the visitor to skip the children of a node.
export type Visitor = (node: t.Node, parent: t.Node | null) => boolean | void;

export function walk(
  node: t.Node,
  visit: Visitor,
  parent: t.Node | null = null,
): void {
  if (visit(node, parent) === false) return;
  const keys = t.VISITOR_KEYS[node.type];
  if (!keys) return;
  const record = node as unknown as Record<string, unknown>;
  for (const key of keys) {
    const child = record[key];
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visit, node);
    } else if (isNode(child)) {
      walk(child, visit, node);
    }
  }
}

export function range(node: t.Node): { start: number; end: number } {
  if (typeof node.start !== "number" || typeof node.end !== "number") {
    throw new Error(`AST node ${node.type} has no position`);
  }
  return { start: node.start, end: node.end };
}

export function sourceOf(code: string, node: t.Node): string {
  const { start, end } = range(node);
  return code.slice(start, end);
}

// Applies edits from the end of the file to the start. An edit that overlaps an
// edit further down is dropped, so two fixes can never garble the same text.
export function applyEdits(code: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = code;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) continue;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

// ── Top-level module shape ──────────────────────────────────────────────────

export interface ModuleInfo {
  hasDefault: boolean;
  defaultName: string | null;
  // names exported with `export const X` / `export function X` / `export { X }`
  named: Set<string>;
  // `export * from ...`: the exported names are unknown, so checks must not guess
  exportsAll: boolean;
  // top-level function / class / variable declarations, by name
  decls: Map<string, t.Node>;
  imports: t.ImportDeclaration[];
}

function declaredNames(node: t.Node): string[] {
  if (
    (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) &&
    node.id
  ) {
    return [node.id.name];
  }
  if (t.isVariableDeclaration(node)) {
    return node.declarations.flatMap((d) =>
      t.isIdentifier(d.id) ? [d.id.name] : [],
    );
  }
  return [];
}

export function analyzeModule(file: t.File): ModuleInfo {
  const info: ModuleInfo = {
    hasDefault: false,
    defaultName: null,
    named: new Set(),
    exportsAll: false,
    decls: new Map(),
    imports: [],
  };

  for (const stmt of file.program.body) {
    if (t.isImportDeclaration(stmt)) {
      info.imports.push(stmt);
    } else if (t.isExportDefaultDeclaration(stmt)) {
      info.hasDefault = true;
      const d = stmt.declaration;
      if ((t.isFunctionDeclaration(d) || t.isClassDeclaration(d)) && d.id) {
        info.defaultName = d.id.name;
        info.decls.set(d.id.name, stmt);
      } else if (t.isIdentifier(d)) {
        info.defaultName = d.name;
      }
    } else if (t.isExportAllDeclaration(stmt)) {
      info.exportsAll = true;
    } else if (t.isExportNamedDeclaration(stmt)) {
      if (stmt.declaration) {
        for (const name of declaredNames(stmt.declaration)) {
          info.named.add(name);
          info.decls.set(name, stmt);
        }
      }
      for (const spec of stmt.specifiers) {
        if (t.isExportSpecifier(spec)) {
          const exported = t.isIdentifier(spec.exported)
            ? spec.exported.name
            : spec.exported.value;
          if (exported === "default") {
            info.hasDefault = true;
            if (t.isIdentifier(spec.local)) info.defaultName = spec.local.name;
          } else {
            info.named.add(exported);
          }
        } else if (t.isExportNamespaceSpecifier(spec)) {
          info.named.add(
            t.isIdentifier(spec.exported)
              ? spec.exported.name
              : spec.exported.value,
          );
        } else if (t.isExportDefaultSpecifier(spec)) {
          info.hasDefault = true;
        }
      }
    } else {
      for (const name of declaredNames(stmt)) info.decls.set(name, stmt);
    }
  }

  return info;
}

// ── Components & JSX ────────────────────────────────────────────────────────

export type FnNode =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

function findLocalFunction(file: t.File, name: string): FnNode | null {
  for (const stmt of file.program.body) {
    const s =
      t.isExportNamedDeclaration(stmt) && stmt.declaration
        ? stmt.declaration
        : stmt;
    if (t.isFunctionDeclaration(s) && s.id?.name === name) return s;
    if (t.isVariableDeclaration(s)) {
      for (const d of s.declarations) {
        if (
          t.isIdentifier(d.id, { name }) &&
          d.init &&
          (t.isArrowFunctionExpression(d.init) ||
            t.isFunctionExpression(d.init))
        ) {
          return d.init;
        }
      }
    }
  }
  return null;
}

// The function behind `export default`: a component declared inline, or a
// local function / arrow function that is exported by name.
export function findDefaultComponent(file: t.File): FnNode | null {
  for (const stmt of file.program.body) {
    if (!t.isExportDefaultDeclaration(stmt)) continue;
    const d = stmt.declaration;
    if (
      t.isFunctionDeclaration(d) ||
      t.isFunctionExpression(d) ||
      t.isArrowFunctionExpression(d)
    ) {
      return d;
    }
    if (t.isIdentifier(d)) return findLocalFunction(file, d.name);
    return null;
  }
  return null;
}

// The JSX a component returns at the top level of its body (not from nested
// callbacks). Null when it is conditional or built some other way.
export function findReturnedJsx(
  fn: FnNode,
): t.JSXElement | t.JSXFragment | null {
  const body = fn.body;
  if (t.isJSXElement(body) || t.isJSXFragment(body)) return body;
  if (t.isBlockStatement(body)) {
    for (const stmt of body.body) {
      if (
        t.isReturnStatement(stmt) &&
        stmt.argument &&
        (t.isJSXElement(stmt.argument) || t.isJSXFragment(stmt.argument))
      ) {
        return stmt.argument;
      }
    }
  }
  return null;
}

export function jsxAttribute(
  el: t.JSXElement,
  name: string,
): t.JSXAttribute | null {
  for (const attr of el.openingElement.attributes) {
    if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name }))
      return attr;
  }
  return null;
}

// Names that are USED in the file: not declarations, not property names, not
// import bindings. `skip` lets a caller ignore nodes it is about to delete.
export function referencedNames(
  file: t.File,
  skip?: (node: t.Node) => boolean,
): Set<string> {
  const names = new Set<string>();

  walk(file.program, (node, parent) => {
    if (skip?.(node)) return false;

    if (t.isIdentifier(node)) {
      if (
        t.isImportSpecifier(parent) ||
        t.isImportDefaultSpecifier(parent) ||
        t.isImportNamespaceSpecifier(parent)
      ) {
        return;
      }
      if (
        (t.isMemberExpression(parent) ||
          t.isOptionalMemberExpression(parent)) &&
        parent.property === node &&
        !parent.computed
      ) {
        return;
      }
      if (t.isObjectProperty(parent) && parent.key === node && !parent.computed)
        return;
      if (
        (t.isFunctionDeclaration(parent) ||
          t.isClassDeclaration(parent) ||
          t.isVariableDeclarator(parent)) &&
        parent.id === node
      ) {
        return;
      }
      names.add(node.name);
    } else if (t.isJSXIdentifier(node)) {
      if (t.isJSXAttribute(parent) && parent.name === node) return;
      if (t.isJSXMemberExpression(parent) && parent.property === node) return;
      names.add(node.name);
    }
  });

  return names;
}

// Where a new import line goes: right after the last existing import.
export function importInsertion(file: t.File): {
  pos: number;
  prefix: string;
  suffix: string;
} {
  let last: t.ImportDeclaration | null = null;
  for (const stmt of file.program.body)
    if (t.isImportDeclaration(stmt)) last = stmt;
  if (last) return { pos: range(last).end, prefix: "\n", suffix: "" };
  return { pos: 0, prefix: "", suffix: "\n" };
}
