// src/services/codeValidator.js

// Post-generation code validator and auto-fixer
// Repairs common AI code generation errors before saving to DB using regex checks

import { parse as parseJS } from "@babel/parser";
import postcss from "postcss";

// Void HTML elements that must be self-closed in JSX
const VOID_ELEMENTS = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
];

const VOID_SET = new Set(VOID_ELEMENTS);

// Self-close void elements (<br>, <img ...>, <input ...>) that are missing the "/".
//
// The tag is scanned the way a JSX parser reads it: a ">" inside a quoted
// attribute or inside a {...} expression (arrow functions "=>", comparisons
// "a > b") does NOT end the tag. Only lowercase names count: <Link>, <Input>,
// <Source> are React components that may have children and must stay untouched.
export function selfCloseVoidElements(code) {
  const fixed = new Set();
  const n = code.length;
  let out = "";
  let i = 0;

  while (i < n) {
    const lt = code.indexOf("<", i);
    if (lt === -1) {
      out += code.slice(i);
      break;
    }
    out += code.slice(i, lt);

    const name = /^<([a-z][a-z0-9]*)(?=[\s/>])/.exec(code.slice(lt, lt + 24))?.[1];
    if (!name || !VOID_SET.has(name)) {
      out += "<";
      i = lt + 1;
      continue;
    }

    let depth = 0; // {...} nesting
    let quote = null; // inside "..." / '...' / `...`
    let end = -1;
    for (let j = lt + 1 + name.length; j < n; j++) {
      const ch = code[j];
      if (quote) {
        if (ch === "\\" && depth > 0) j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || (ch === "`" && depth > 0)) quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === ">" && depth === 0) {
        end = j;
        break;
      }
    }

    if (end === -1) {
      // unterminated tag: leave the rest alone, the syntax gate will report it
      out += code.slice(lt);
      break;
    }

    const body = code.slice(lt, end);
    if (/\/\s*$/.test(body)) {
      out += code.slice(lt, end + 1); // already self-closed
    } else {
      out += `${body.replace(/\s+$/, "")} />`;
      fixed.add(name);
    }
    i = end + 1;
  }

  return { code: out, fixed: [...fixed] };
}

// Real syntax check (same parsers the Sandpack preview uses: Babel + PostCSS).
// Returns an error message, or null when the file parses fine.
export function findSyntaxError(code, filePath) {
  try {
    if (filePath.endsWith(".css")) {
      postcss.parse(code);
    } else if (/\.(jsx?|mjs)$/.test(filePath)) {
      parseJS(code, { sourceType: "module", plugins: ["jsx"] });
    }
    return null;
  } catch (err) {
    return err?.message || String(err);
  }
}

// Validate and auto-fix common AI-generated code issues
export function validateAndFixCode(code, filePath, context) {
  const warnings = [];
  const isCSS = filePath.endsWith(".css");
  const isJS = filePath.endsWith(".js") || filePath.endsWith(".jsx");

  // 1. Strip markdown code fences that some models wrap around code
  const fencePattern =
    /^```(?:jsx?|javascript|css|html|tsx?|react)?\s*\n([\s\S]*?)\n```\s*$/;
  const fenceMatch = code.match(fencePattern);
  if (fenceMatch) {
    code = fenceMatch[1];
    warnings.push(`${filePath}: Stripped markdown code fences`);
  }

  // Also handle cases where fences appear at the very start/end with other content
  code = code.replace(/^```(?:jsx?|javascript|css|html|tsx?|react)?\s*\n/, "");
  code = code.replace(/\n```\s*$/, "");

  if (isCSS) {
    // CSS-specific fixes — minimal, just trim and return
    return { code: code.trim() + "\n", warnings };
  }

  if (!isJS) {
    return { code, warnings };
  }

  // --- JS/JSX-specific fixes ---
  //
  // Most of these are regex repairs, so each one runs through `attempt`: when
  // the code parses before a repair but no longer parses after it, the repair
  // is dropped. Valid code can therefore never be made worse by an auto-fix.
  let valid = !findSyntaxError(code, filePath);

  const attempt = (label, transform) => {
    const after = transform(code);
    if (after === code) return false;

    const error = findSyntaxError(after, filePath);
    if (valid && error) {
      warnings.push(
        `${filePath}: Skipped auto-fix "${label}" (it would have broken valid code)`,
      );
      return false;
    }

    code = after;
    valid = !error;
    return true;
  };

  // 2. Fix `class=` → `className=` in JSX
  if (
    attempt("class → className", (c) =>
      c.replace(/(<[a-zA-Z][^>]*?)\bclass=/g, "$1className="),
    )
  ) {
    warnings.push(`${filePath}: Fixed 'class=' → 'className='`);
  }

  // 3. Fix `for=` → `htmlFor=` in JSX labels
  if (
    attempt("for → htmlFor", (c) =>
      c.replace(/(<label[^>]*?)\bfor=/gi, "$1htmlFor="),
    )
  ) {
    warnings.push(`${filePath}: Fixed 'for=' → 'htmlFor='`);
  }

  // 4. Self-close void elements that aren't self-closed
  let selfClosed = [];
  if (
    attempt("self-close void elements", (c) => {
      const result = selfCloseVoidElements(c);
      selfClosed = result.fixed;
      return result.code;
    })
  ) {
    for (const tag of selfClosed) {
      warnings.push(`${filePath}: Self-closed <${tag}> elements`);
    }
  }

  // 5. Ensure exactly one default export exists
  const defaultExportCount = (code.match(/export\s+default\s+/g) || []).length;
  if (defaultExportCount === 0 && !filePath.endsWith(".css")) {
    // Try to find the main function/component and add default export
    const funcMatch = code.match(/^function\s+([A-Z]\w*)\s*\(/m);
    const constMatch = code.match(/^const\s+([A-Z]\w*)\s*=\s*(?:\(|function)/m);
    const componentName = funcMatch?.[1] || constMatch?.[1];

    if (componentName) {
      // Check if there's already a named export
      const namedExportRegex = new RegExp(
        `export\\s+(function|const)\\s+${componentName}`,
      );
      if (namedExportRegex.test(code)) {
        // Convert `export function X` → `export default function X`
        code = code.replace(
          new RegExp(`export\\s+(function|const)\\s+${componentName}`),
          `export default $1 ${componentName}`,
        );
      } else {
        // Add default export at the end
        code = code.trimEnd() + `\n\nexport default ${componentName};\n`;
      }
      valid = !findSyntaxError(code, filePath);
      warnings.push(
        `${filePath}: Added missing default export for '${componentName}'`,
      );
    }
  }

  // 6. Remove stray HTML comments (<!-- ... -->), invalid in JSX
  if (attempt("HTML comments", (c) => c.replace(/<!--[\s\S]*?-->/g, ""))) {
    warnings.push(`${filePath}: Removed HTML comments (invalid in JSX)`);
  }

  // 7. Fix common TypeScript syntax that slips in
  if (
    attempt("React.FC annotation", (c) =>
      c.replace(/:\s*React\.FC(?:<[^>]*>)?\s*=/g, " ="),
    )
  ) {
    warnings.push(`${filePath}: Removed TypeScript React.FC annotation`);
  }

  // Simple parameter annotations like (props: any)
  if (
    attempt("type annotations", (c) =>
      c.replace(
        /(\([^)]*?)\s*:\s*(?:string|number|boolean|any|object|void)\s*([,)])/g,
        "$1$2",
      ),
    )
  ) {
    warnings.push(`${filePath}: Removed TypeScript type annotation`);
  }

  // 8. Ensure React import exists if JSX is used
  // (`import * as React from 'react'` counts, a second import would clash)
  const hasJSX = /<[A-Za-z]/.test(code);
  const hasReactImport = /import\s+(?:\*\s+as\s+)?React\b/.test(code);
  if (
    hasJSX &&
    !hasReactImport &&
    attempt("React import", (c) => `import React from 'react';\n${c}`)
  ) {
    warnings.push(`${filePath}: Added missing React import`);
  }

  // 9. Fix import paths that point to incorrect folders/paths compared to what was planned
  if (context?.allPlannedFiles) {
    const fixResult = fixImportPaths(code, filePath, context.allPlannedFiles);
    if (attempt("import paths", () => fixResult.code)) {
      warnings.push(...fixResult.warnings);
    }
  }

  return { code: code.trim() + "\n", warnings };
}

// Validate and fix code specifically for revision operations
export function validateRevisionContent(content, filePath, op) {
  if (op === "delete") return { content, warnings: [] };

  if (op === "create") {
    const result = validateAndFixCode(content, filePath);
    return { content: result.code, warnings: result.warnings };
  }

  // For update ops (search/replace content), only apply safe fixes
  // that won't break the partial context
  const warnings = [];

  // Fix class → className
  const classFixRegex = /(<[a-zA-Z][^>]*?)\bclass=/g;
  if (classFixRegex.test(content)) {
    content = content.replace(/(<[a-zA-Z][^>]*?)\bclass=/g, "$1className=");
    warnings.push(`${filePath}: Fixed 'class=' → 'className=' in replacement`);
  }

  // Fix for → htmlFor
  const forFixRegex = /(<label[^>]*?)\bfor=/gi;
  if (forFixRegex.test(content)) {
    content = content.replace(/(<label[^>]*?)\bfor=/gi, "$1htmlFor=");
    warnings.push(`${filePath}: Fixed 'for=' → 'htmlFor=' in replacement`);
  }

  // Self-close void elements. A fragment cannot be parsed on its own, so this
  // relies on the scanner: "=>" or ">" inside an attribute never ends a tag.
  const voids = selfCloseVoidElements(content);
  if (voids.fixed.length > 0) {
    content = voids.code;
    for (const tag of voids.fixed) {
      warnings.push(`${filePath}: Self-closed <${tag}> in replacement`);
    }
  }

  return { content, warnings };
}

// --- Import Path Resolution Helpers ---

function getDir(p) {
  const parts = p.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function resolvePath(baseDir, relativePath) {
  const baseParts = baseDir.split("/").filter(Boolean);
  const relParts = relativePath.split("/").filter(Boolean);

  for (const part of relParts) {
    if (part === ".") {
      continue;
    } else if (part === "..") {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return "/" + baseParts.join("/");
}

function getRelativePath(fromDir, toPath) {
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toPath.split("/").filter(Boolean);

  let commonLength = 0;
  while (
    commonLength < fromParts.length &&
    commonLength < toParts.length &&
    fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++;
  }

  const upCount = fromParts.length - commonLength;
  const remainingTo = toParts.slice(commonLength);

  const relParts = [];
  for (let i = 0; i < upCount; i++) {
    relParts.push("..");
  }
  if (relParts.length === 0) {
    relParts.push(".");
  }
  relParts.push(...remainingTo);
  return relParts.join("/");
}

function cleanExtension(p) {
  return p.replace(/\.(js|jsx|css|ts|tsx)$/, "");
}

function fixImportPaths(code, filePath, allPlannedFiles) {
  const warnings = [];
  if (!allPlannedFiles || allPlannedFiles.length === 0) {
    return { code, warnings };
  }

  const currentDir = getDir(filePath);
  const plannedPaths = allPlannedFiles.map((f) =>
    f.path.startsWith("/") ? f.path : "/" + f.path,
  );

  // Matches lines like: import Header from './components/Header';
  // or import '../styles.css'; or require('./components/Header')
  const importRegex = /(from\s+['"]|import\s+['"])([^'"]+)(['"])/g;

  const newCode = code.replace(
    importRegex,
    (match, prefix, importTarget, suffix) => {
      // Skip absolute imports (non-relative packages like 'react')
      if (!importTarget.startsWith(".")) {
        return match;
      }

      // 1. Resolve relative import target path
      const resolvedTarget = resolvePath(currentDir, importTarget);
      const resolvedClean = cleanExtension(resolvedTarget);

      // Check if it already matches a planned file path exactly (with or without extension)
      const exactExists = plannedPaths.some(
        (p) => cleanExtension(p) === resolvedClean,
      );
      if (exactExists) {
        return match;
      }

      // 2. Mismatch! Try to find a planned file with the same filename
      const importFilename = resolvedClean.split("/").pop();
      if (!importFilename) {
        return match;
      }

      const foundPlannedPath = plannedPaths.find((p) => {
        const plannedClean = cleanExtension(p);
        const plannedFilename = plannedClean.split("/").pop();
        return plannedFilename === importFilename;
      });

      if (foundPlannedPath) {
        // Calculate relative path from current directory to actual planned file path
        const newRelative = getRelativePath(currentDir, foundPlannedPath);
        // Prefix relative prefix if missing
        const finalRelative = newRelative.startsWith(".")
          ? newRelative
          : "./" + newRelative;

        // Retain file extension if the original import target had it
        const hasExt = /\.(js|jsx|css|ts|tsx)$/.test(importTarget);
        const ext = hasExt ? "." + importTarget.split(".").pop() : "";

        const rewrittenTarget = cleanExtension(finalRelative) + ext;
        if (rewrittenTarget !== importTarget) {
          warnings.push(
            `${filePath}: Corrected import '${importTarget}' to '${rewrittenTarget}' (file planned at '${foundPlannedPath}')`,
          );
          return `${prefix}${rewrittenTarget}${suffix}`;
        }
      }

      return match;
    },
  );

  return { code: newCode, warnings };
}