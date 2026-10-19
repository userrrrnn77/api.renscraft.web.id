// src/services/importGuard.js

// Jaring pengaman: AI kadang menulis `import './CV.css'` padahal file itu tidak
// ada di plan, lalu Sandpack error "Could not find module in path".
// Dicek per file SEBELUM disimpan, jadi file yang sudah masuk DB selalu bersih.
import path from "node:path";

const RESOLVE_SUFFIXES = [
  "",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  "/index.js",
  "/index.jsx",
];
const STYLE_RE = /\.(css|scss|sass|less)$/i;

// Hanya import relatif ('./x', '../x'). Import paket ('react', 'lucide-react')
// sengaja tidak disentuh. Mendukung import multi-baris dan side-effect import.
const RELATIVE_IMPORT_RE =
  /^[ \t]*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?(["'])(\.{1,2}(?:\/[^"'\n]*)?)\1[ \t]*;?[ \t]*\r?$/gm;

const norm = (p) => (p.startsWith("/") ? p : `/${p}`);

// - import stylesheet yang tidak ada  -> baris import dihapus (styling global
//   sudah ada di /styles.css + Tailwind), dicatat di `warnings`
// - import file lain yang tidak ada   -> dicatat di `missing` (caller yang
//   memutuskan: di ai.js dilempar sebagai error supaya file di-generate ulang)
export function fixUnresolvedImports(code, filePath, plannedPaths) {
  const planned = new Set(plannedPaths.map(norm));
  const dir = path.posix.dirname(norm(filePath));
  const warnings = [];
  const missing = [];

  const fixed = code.replace(RELATIVE_IMPORT_RE, (stmt, _quote, spec) => {
    const target = path.posix.resolve(dir, spec);
    if (RESOLVE_SUFFIXES.some((s) => planned.has(target + s))) return stmt;

    if (STYLE_RE.test(spec)) {
      warnings.push(`Removed import of missing stylesheet ${spec}`);
      return "";
    }

    missing.push(spec);
    return stmt;
  });

  return { code: fixed, warnings, missing };
}