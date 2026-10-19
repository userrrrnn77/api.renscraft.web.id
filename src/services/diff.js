// src/services/diff.js

import crypto from "crypto";
import { findSyntaxError } from "./codeValidator.js";

export function hashContent(content) {
  return crypto.createHash("md5").update(content).digest("hex").slice(0, 12);
}

// Apply AI file operations (create, update, delete) to project files
export function applyOperations(currentFiles, operations) {
  const files = { ...currentFiles };
  const applied = [];
  const errors = [];
  // Paths where at least one operation failed. A file is never left
  // half-edited: if one op for it fails, ALL of its ops are rolled back
  // (a half-applied revision is what produced the broken Stories.js).
  const failedPaths = new Set();

  const fail = (op, message) => {
    failedPaths.add(op.path);
    errors.push(`${op.op} ${op.path}: ${message}`);
  };

  for (const op of operations) {
    try {
      switch (op.op) {
        case "create": {
          if (!op.content) {
            fail(op, "missing content");
            break;
          }
          files[op.path] = {
            content: op.content,
            hash: hashContent(op.content),
          };
          applied.push(`created ${op.path}`);
          break;
        }

        case "update": {
          const existing = files[op.path];
          if (!existing) {
            fail(op, "file not found");
            break;
          }
          if (!op.search || op.replace == null) {
            fail(op, "missing search/replace");
            break;
          }

          let res = searchReplace(existing.content, op.search, op.replace);

          // The model often points `path` at the wrong file (e.g. JS code with
          // path /styles.css). If the search text exists verbatim in exactly
          // ONE other file, apply the edit there instead of failing.
          if (res.error === "search string not found") {
            const owners = Object.keys(files).filter(
              (p) => p !== op.path && files[p].content.includes(op.search),
            );
            if (owners.length === 1) {
              const target = owners[0];
              const r2 = searchReplace(files[target].content, op.search, op.replace);
              if (!r2.error) {
                console.warn(`[Diff] ${op.path}: search not found, retargeted to ${target}`);
                files[target] = { content: r2.content, hash: hashContent(r2.content) };
                applied.push(`updated ${target} (retargeted from ${op.path})`);
                break;
              }
            }
          }

          if (res.error) {
            // Log what the model actually sent, so a "not found" can be
            // diagnosed from the server log instead of guessed at.
            console.warn(
              `[Diff] ${op.path}: ${res.error}\n  search (${op.search.length} chars): ${JSON.stringify(op.search.slice(0, 240))}`,
            );
            fail(op, res.error);
            break;
          }

          files[op.path] = {
            content: res.content,
            hash: hashContent(res.content),
          };
          applied.push(
            res.how === "exact"
              ? `updated ${op.path}`
              : `updated ${op.path} (fuzzy match: ${res.how})`,
          );
          break;
        }

        case "delete": {
          if (files[op.path]) {
            delete files[op.path];
            applied.push(`deleted ${op.path}`);
          } else {
            fail(op, "file not found");
          }
          break;
        }

        default:
          errors.push(`unknown op: ${op.op}`);
      }
    } catch (err) {
      fail(op, err.message);
    }
  }

  // Syntax gate: never save a JS/CSS file that Babel/PostCSS cannot parse
  // (the preview would crash with "Something went wrong"). A file that was
  // already broken before this revision is let through so it can be repaired.
  for (const [path, entry] of Object.entries(files)) {
    if (failedPaths.has(path) || entry === currentFiles[path]) continue;
    const err = findSyntaxError(entry.content, path);
    if (!err) continue;
    const before = currentFiles[path];
    if (before && findSyntaxError(before.content, path)) continue;
    failedPaths.add(path);
    errors.push(`update ${path}: result has a syntax error (${err.slice(0, 120)})`);

    // Show exactly what the model tried, so "AI or prompt?" can be answered
    // from the log instead of guessed.
    const pos = /\((\d+):(\d+)\)/.exec(err);
    const badLine = pos ? (entry.content.split("\n")[Number(pos[1]) - 1] ?? "") : "";
    const tried = operations
      .filter((o) => o.path === path)
      .map(
        (o) =>
          `${o.op} search=${JSON.stringify(String(o.search ?? "").slice(0, 100))} ` +
          `replace=${JSON.stringify(String(o.replace ?? o.content ?? "").slice(0, 160))}`,
      );
    console.warn(
      `[Diff] ${path}: rejected, syntax error ${err}\n` +
        (badLine ? `  offending line: ${badLine.trim().slice(0, 160)}\n` : "") +
        tried.map((t) => `  - ${t}`).join("\n"),
    );
  }

  // Roll back every file that had a failed op
  for (const path of failedPaths) {
    if (currentFiles[path]) files[path] = currentFiles[path];
    else delete files[path];
  }
  const kept = applied.filter(
    (a) => !failedPaths.has(a.replace(/^(created|updated|deleted) (\S+).*$/, "$2")),
  );

  return { files, applied: kept, errors, failedPaths: [...failedPaths] };
}

// Content the model wanted for files that do not exist yet (op "create").
// When such a file is rejected (usually: line breaks lost inside the JSON, so
// the syntax gate fails) there is no "current" file to rewrite, but the
// rejected draft is just as good a starting point for a plain-text rewrite.
export function newFileDrafts(currentFiles, operations) {
  const drafts = {};
  for (const op of operations || []) {
    if (op?.op !== "create" || typeof op.path !== "string") continue;
    if (typeof op.content !== "string" || !op.content.trim()) continue;
    if (currentFiles?.[op.path]) continue;
    drafts[op.path] = op.content;
  }
  return drafts;
}

// Find `search` inside `content` while ignoring whitespace (and optionally
// quote style). Returns {start, end} in the ORIGINAL content, or an error.
// The model often returns code inside JSON with line breaks dropped or
// indentation changed, so a line-by-line comparison is not enough.
function findFuzzy(content, search, foldQuotes) {
  const fold = (ch) => (foldQuotes && (ch === '"' || ch === "`") ? "'" : ch);

  let compact = "";
  const map = []; // compact index -> index in content
  for (let i = 0; i < content.length; i++) {
    if (/\s/.test(content[i])) continue;
    compact += fold(content[i]);
    map.push(i);
  }

  let needle = "";
  for (const ch of search) if (!/\s/.test(ch)) needle += fold(ch);
  if (!needle) return { error: "search string is empty" };

  const first = compact.indexOf(needle);
  if (first === -1) return { notFound: true };

  const second = compact.indexOf(needle, first + 1);
  if (second !== -1) {
    return {
      error:
        "search string matches more than one place (ambiguous), make it longer",
    };
  }

  return { start: map[first], end: map[first + needle.length - 1] + 1 };
}

// The model (JSON mode) sometimes writes quotes as HTML entities (&quot;), so
// `search` never matches the real file. Only quote entities are decoded:
// &amp; / &lt; / &ldquo; are legitimate in JSX text and must stay untouched.
const decodeQuoteEntities = (text) =>
  String(text ?? "").replace(/&(quot|apos|#0*34|#0*39|#x0*22|#x0*27);/gi, (_, e) =>
    /^(quot|#0*34|#x0*22)$/i.test(e) ? '"' : "'",
  );

// Returns {content, how} on success or {error} on failure.
function searchReplace(content, search, replace) {
  const variants = [{ search, replace, how: "" }];
  const decoded = decodeQuoteEntities(search);
  if (decoded !== search) {
    variants.push({ search: decoded, replace: decodeQuoteEntities(replace), how: "quote entities" });
  }

  // 1. Exact match
  for (const v of variants) {
    if (content.includes(v.search)) {
      return {
        content: content.replace(v.search, () => v.replace),
        how: v.how || "exact",
      };
    }
  }

  // 2. Ignore all whitespace (handles dropped newlines / changed indentation)
  // 3. Also ignore quote style (' vs " vs `)
  for (const [foldQuotes, how] of [
    [false, "whitespace"],
    [true, "whitespace+quotes"],
  ]) {
    for (const v of variants) {
      const r = findFuzzy(content, v.search, foldQuotes);
      if (r.error) return { error: r.error };
      if (!r.notFound) {
        return {
          content: content.slice(0, r.start) + v.replace + content.slice(r.end),
          how: v.how ? `${how}, ${v.how}` : how,
        };
      }
    }
  }

  return { error: "search string not found" };
}