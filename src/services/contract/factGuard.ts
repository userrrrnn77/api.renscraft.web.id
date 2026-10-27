// src/services/contract/factGuard.ts
//
// C1: detect invented facts in generated React code.
//
// A fact is a phone number, email, price, stat, rating, year or handle that
// does not appear anywhere in the project's sources (prompt, brief answers,
// contract facts, slot placeholders). Everything else is allowed.
//
// The AST walk skips code-shaped strings: import/export sources, className and
// other non-content attributes, svg attributes, and strings that start with a
// path or a "#". URLs are only inspected for wa.me, tel: and mailto: targets.
//
// Numbers are compared by digits only: "15.000", "15rb" and "15000" all
// canonicalize to "15000". Phones compare by their last 9 digits. Emails and
// handles are case-insensitive.

import * as t from "@babel/types";
import { parseModule, range, walk } from "../../utils/astUtils.js";

export type FactKind =
  | "phone"
  | "email"
  | "price"
  | "stat"
  | "rating"
  | "year"
  | "handle";

export interface InventedFact {
  kind: FactKind;
  value: string;
  line: number;
}

export interface FactAllow {
  phones: Set<string>;
  emails: Set<string>;
  numbers: Set<string>;
  handles: Set<string>;
  years: Set<string>;
}

export interface FactGuardOpts {
  includeHandles?: boolean;
}

// ── Allowlist builders ─────────────────────────────────────────────────────

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HANDLE_RE = /(?<![\w@])@[a-z0-9._]{2,30}/gi;
const DIGIT_RUN_RE = /\d+/g;

function normalizePhoneTail(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

// Indonesian price normalizer: "Rp 15.000" -> 15000, "15rb" -> 15000,
// "1.5jt" -> 1500000, "15.000" -> 15000, "15,5rb" -> 15500.
function parseIdrNumber(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const m = /^(?:rp\.?\s*)?([\d.,]+)\s*(rb|ribu|k|jt|juta)?$/.exec(s);
  if (!m) return null;

  let numStr = m[1] ?? "";
  const lastDot = numStr.lastIndexOf(".");
  const lastComma = numStr.lastIndexOf(",");
  if (lastComma > -1) {
    numStr = numStr.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > -1) {
    const after = numStr.length - lastDot - 1;
    if (after === 3) numStr = numStr.replace(/\./g, "");
  }

  const n = parseFloat(numStr);
  if (!Number.isFinite(n)) return null;

  const suffix = m[2] ?? "";
  if (suffix === "rb" || suffix === "ribu" || suffix === "k") return n * 1000;
  if (suffix === "jt" || suffix === "juta") return n * 1_000_000;
  return n;
}

const digitsOf = (raw: string): string => raw.replace(/\D/g, "");

export function buildAllowlist(sources: string[]): FactAllow {
  const allow: FactAllow = {
    phones: new Set(),
    emails: new Set(),
    numbers: new Set(),
    handles: new Set(),
    years: new Set(),
  };
  const text = sources.filter(Boolean).join("\n");

  for (const m of text.matchAll(EMAIL_RE)) {
    allow.emails.add((m[0] ?? "").toLowerCase());
  }

  for (const m of text.matchAll(HANDLE_RE)) {
    allow.handles.add((m[0] ?? "").slice(1).toLowerCase());
  }

  for (const m of text.matchAll(DIGIT_RUN_RE)) {
    const run = m[0] ?? "";
    allow.numbers.add(run);
    if (run.length >= 10) allow.phones.add(run.slice(-9));
    if (/^(?:19|20)\d{2}$/.test(run)) allow.years.add(run);
  }

  // Canonical price forms
  const PRICE_TOKEN_RE = /(?:rp\.?\s*)?\d[\d.,]*\s*(?:rb|ribu|k|jt|juta)\b/gi;
  for (const m of text.matchAll(PRICE_TOKEN_RE)) {
    const n = parseIdrNumber(m[0] ?? "");
    if (n !== null) allow.numbers.add(String(n));
  }

  const RP_TOKEN_RE = /rp\.?\s*\d[\d.,]*/gi;
  for (const m of text.matchAll(RP_TOKEN_RE)) {
    const n = parseIdrNumber(m[0] ?? "");
    if (n !== null) allow.numbers.add(String(n));
  }

  return allow;
}

// ── Text extraction from AST ───────────────────────────────────────────────

interface TextCandidate {
  text: string;
  line: number;
}

const SKIP_ATTRS = new Set([
  "className",
  "id",
  "key",
  "style",
  "type",
  "rel",
  "target",
  "role",
]);

const SVG_ONLY_ATTRS = new Set([
  "xmlns",
  "viewBox",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "x2",
  "y1",
  "y2",
  "points",
  "preserveAspectRatio",
  "fillRule",
  "clipRule",
  "strokeWidth",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeDasharray",
  "strokeDashoffset",
  "fill",
  "stroke",
]);

const shouldSkipAttr = (name: string): boolean => {
  if (SKIP_ATTRS.has(name)) return true;
  if (SVG_ONLY_ATTRS.has(name)) return true;
  if (name.startsWith("aria-")) return true;
  if (name.startsWith("data-")) return true;
  return false;
};

function lineOf(source: string, index: number): number {
  let line = 1;
  const cap = Math.min(index, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function collectTextCandidates(code: string, ast: t.File): TextCandidate[] {
  const out: TextCandidate[] = [];

  walk(ast.program, (node, parent) => {
    // 1. Skip import/export sources
    if (
      (t.isStringLiteral(node) || t.isTemplateLiteral(node)) &&
      parent &&
      (t.isImportDeclaration(parent) ||
        t.isExportNamedDeclaration(parent) ||
        t.isExportAllDeclaration(parent))
    ) {
      return;
    }

    // 2. Skip JSX attribute values with code-shaped names
    if (t.isJSXAttribute(parent)) {
      const nameNode = parent.name;
      if (t.isJSXIdentifier(nameNode) && shouldSkipAttr(nameNode.name)) {
        return;
      }
    }

    if (t.isJSXText(node)) {
      out.push({
        text: node.value,
        line: lineOf(code, node.start ?? 0),
      });
      return;
    }

    if (t.isStringLiteral(node)) {
      const r = range(node);
      out.push({ text: node.value, line: lineOf(code, r.start) });
      return;
    }

    if (t.isTemplateLiteral(node)) {
      if (node.expressions.length > 0) return;
      const cooked = node.quasis.map((q) => q.value.cooked ?? "").join("");
      const r = range(node);
      out.push({ text: cooked, line: lineOf(code, r.start) });
    }
  });

  return out;
}

// ── Fact detection ─────────────────────────────────────────────────────────

interface FactMatch {
  kind: FactKind;
  value: string;
}

const WA_LINK_RE = /(?:https?:\/\/wa\.me\/|tel:)\+?(\d{8,15})/gi;
const MAILTO_LINK_RE = /mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;
const EMAIL_IN_TEXT_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_CANDIDATE_RE = /(?:\+?62|0)8[1-9]\d{6,11}/g;
const GENERIC_PHONE_RE = /\b\d{9,15}\b/g;
const PRICE_IN_TEXT_RE =
  /(?:rp\.?\s*\d[\d.,]*\s*(?:rb|ribu|k|jt|juta)?|\b\d[\d.,]*\s*(?:rb|ribu|k|jt|juta)\b)/gi;
const STAT_RE = /\b\d{2,}\+/g;
const RATING_RE = /\b([1-5](?:\.\d)?)\s*\/\s*5\b/g;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const HANDLE_IN_TEXT_RE = /(?<![\w@])@[a-z0-9._]{2,30}/gi;

function detectFactsInText(text: string): FactMatch[] {
  const out: FactMatch[] = [];

  // URLs: only wa.me / tel: / mailto:
  for (const m of text.matchAll(WA_LINK_RE)) {
    const val = m[1];
    if (val) out.push({ kind: "phone", value: val });
  }
  for (const m of text.matchAll(MAILTO_LINK_RE)) {
    const val = m[1];
    if (val) out.push({ kind: "email", value: val.toLowerCase() });
  }

  for (const m of text.matchAll(EMAIL_IN_TEXT_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "email", value: val.toLowerCase() });
  }

  for (const m of text.matchAll(PHONE_CANDIDATE_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "phone", value: val });
  }
  for (const m of text.matchAll(GENERIC_PHONE_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "phone", value: val });
  }

  for (const m of text.matchAll(PRICE_IN_TEXT_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "price", value: val });
  }
  for (const m of text.matchAll(STAT_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "stat", value: val });
  }
  for (const m of text.matchAll(RATING_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "rating", value: val });
  }
  for (const m of text.matchAll(YEAR_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "year", value: val });
  }
  for (const m of text.matchAll(HANDLE_IN_TEXT_RE)) {
    const val = m[0];
    if (val) out.push({ kind: "handle", value: val.slice(1).toLowerCase() });
  }

  return out;
}

function isAllowed(match: FactMatch, allow: FactAllow): boolean {
  switch (match.kind) {
    case "phone": {
      const tail = normalizePhoneTail(match.value);
      if (!tail) return true;
      return allow.phones.has(tail);
    }
    case "email":
      return allow.emails.has(match.value.toLowerCase());
    case "price": {
      const n = parseIdrNumber(match.value);
      if (n === null) return true;
      return allow.numbers.has(String(n));
    }
    case "stat": {
      return allow.numbers.has(digitsOf(match.value));
    }
    case "rating": {
      return allow.numbers.has(digitsOf(match.value));
    }
    case "year": {
      if (allow.years.has(match.value)) return true;
      const currentYear = String(new Date().getFullYear());
      return match.value === currentYear;
    }
    case "handle":
      return allow.handles.has(match.value.toLowerCase());
    default:
      return true;
  }
}

function shouldSkipText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("/")) return true;
  if (/^\.{1,2}\//.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed)) {
    return !/^https?:\/\/(?:wa\.me\/|mailto:)/i.test(trimmed);
  }
  return false;
}

export function findInventedFacts(
  code: string,
  allow: FactAllow,
  opts: FactGuardOpts = {},
): InventedFact[] {
  const ast = parseModule(code);
  if (!ast) return [];

  const includeHandles = opts.includeHandles !== false;
  const candidates = collectTextCandidates(code, ast);
  const out: InventedFact[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (shouldSkipText(candidate.text)) continue;
    for (const match of detectFactsInText(candidate.text)) {
      if (!includeHandles && match.kind === "handle") continue;
      if (isAllowed(match, allow)) continue;
      const key = `${match.kind}:${match.value}:${candidate.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: match.kind,
        value: match.value,
        line: candidate.line,
      });
    }
  }

  return out;
}
