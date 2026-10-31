// src/services/finalize.js
//
// F3: finalize step. Setelah semua mutasi file selesai (contract fix, image
// reconcile, Fact Guard regen, stylesheet), jalankan SATU kali lagi:
//   - checkContract (GENERATION_PASSES: theme, exports, anchors, icons, facts)
//   - import gate (semua file, bukan cuma yang di-generate model)
//   - parse gate (Babel + PostCSS, seluruh project)
//
// Kenapa: Fact Guard me-regen file SATU PER SATU setelah contract pass
// pertama selesai. File hasil regen bisa kehilangan named export yang
// dimiliki file aslinya — dan itu bikin file lain yang nge-import crash.
// Ini titik terakhir buat nangkep sebelum masuk DB.
//
// checkContract sudah punya parse gate internal (per-pass), jadi file yang
// tadinya parse tapi jadi rusak karena satu fix akan di-revert otomatis.

import {
  checkContract,
  GENERATION_PASSES,
} from "./contract/contractChecker.js";
import { fixUnresolvedImports } from "./importGuard.js";
import { findSyntaxError } from "./codeValidator.js";

const JS_RE = /\.(jsx?|tsx?)$/i;

export async function finalizeProject(files, contract) {
  const issues = [];
  let current = { ...files };

  // 1. Contract passes — set yang sama dengan generation awal.
  try {
    const check = checkContract(current, contract, {
      passes: GENERATION_PASSES,
    });
    current = check.files;

    for (const i of check.issues) {
      issues.push({
        code: i.fixed ? "FINALIZE_FIXED" : "FINALIZE_OPEN",
        // Fixed = sudah beres → warning. Unfixed = ikutin severity pass-nya.
        severity: i.fixed ? "warning" : (i.severity ?? "blocking"),
        stage: "contract",
        path: i.path,
        message: i.message,
        autoFixed: !!i.fixed,
      });
    }
  } catch (err) {
    // Pass crash jangan sampai membuang project. Laporkan sebagai warning.
    issues.push({
      code: "FINALIZE_CONTRACT_CRASH",
      severity: "warning",
      stage: "contract",
      message: err?.message ?? String(err),
    });
  }

  // 2. Import gate — file yang import file lokal yang gak ada = crash di
  //    preview ("Could not find module"). Per-file gate jalan di generation,
  //    tapi regen bisa balikin import basi.
  const plannedPaths = Object.keys(current);
  for (const [path, code] of Object.entries(current)) {
    if (!JS_RE.test(path)) continue;
    if (typeof code !== "string") continue;

    try {
      const check = fixUnresolvedImports(code, path, plannedPaths);
      if (check.missing.length > 0) {
        issues.push({
          code: "FINALIZE_MISSING_IMPORT",
          severity: "blocking",
          stage: "imports",
          path,
          message: `imports file(s) that do not exist: ${check.missing.join(", ")}`,
        });
      }
    } catch (err) {
      issues.push({
        code: "FINALIZE_IMPORT_CRASH",
        severity: "warning",
        stage: "imports",
        path,
        message: err?.message ?? String(err),
      });
    }
  }

  // 3. Whole-project parse gate.
  for (const [path, code] of Object.entries(current)) {
    if (typeof code !== "string") continue;

    const err = findSyntaxError(code, path);
    if (err) {
      issues.push({
        code: "FINALIZE_PARSE_ERROR",
        severity: "blocking",
        stage: "parse",
        path,
        message: err.slice(0, 300),
      });
    }
  }

  const blocking = issues.filter((i) => i.severity === "blocking").length;
  return { files: current, issues, blocking };
}
