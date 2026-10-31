// src/services/qa/bundle.js
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const QA_ENTRY_PATH = "/__qa_entry__.js";
const JS_LOADER = { ".js": "jsx", ".jsx": "jsx", ".mjs": "jsx" };
const CANDIDATES = ["", ".js", ".jsx", ".mjs", "/index.js", "/index.jsx"];

// React's own index.js does require('./cjs/react.production.min.js').
// Kalau folder cjs/ benar-benar hilang dari disk, esbuild throw error yang
// sama bentuknya. Regex ini jadi sinyal "coba UMD fallback".
const INFRA_BUNDLE_RE =
  /Cannot resolve "\.\/cjs\/(?:react|react-dom|react-jsx-runtime|scheduler)/i;

export const isInfraBundleError = (message) =>
  typeof message === "string" && INFRA_BUNDLE_RE.test(message);

function readUmd(relPath) {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
  } catch {
    return null;
  }
}

function findReactUmd() {
  const react = readUmd("node_modules/react/umd/react.production.min.js");
  const reactDom = readUmd(
    "node_modules/react-dom/umd/react-dom.production.min.js",
  );
  if (!react || !reactDom) return null;
  return { react, reactDom };
}

function resolveVirtual(fromPath, spec, files) {
  const dir = fromPath ? path.posix.dirname(fromPath) : "/";
  const base = spec.startsWith("/") ? spec : path.posix.resolve(dir, spec);
  for (const suffix of CANDIDATES) {
    if (base + suffix in files) return base + suffix;
  }
  return null;
}

const REACT_SHIM = "module.exports = window.React;";
const REACT_DOM_SHIM = "module.exports = window.ReactDOM;";
const REACT_DOM_CLIENT_SHIM = "module.exports = window.ReactDOM;";
const JSX_RUNTIME_SHIM = `var React = window.React;
function jsx(type, props, key) {
  if (key !== undefined) {
    props = Object.assign({}, props, { key: key });
  }
  return React.createElement(type, props);
}
module.exports = {
  Fragment: React.Fragment,
  jsx: jsx,
  jsxs: jsx,
};
`;

const SHIMS = {
  react: REACT_SHIM,
  "react-dom": REACT_DOM_SHIM,
  "react-dom/client": REACT_DOM_CLIENT_SHIM,
  "react/jsx-runtime": JSX_RUNTIME_SHIM,
  "react/jsx-dev-runtime": JSX_RUNTIME_SHIM,
};

// Fallback terakhir: kalau node_modules/react/cjs/* hilang dari disk
// (install rusak), react/react-dom di-shim dari UMD yang di-inject ke HTML shell.
function reactShimPlugin() {
  return {
    name: "renscraft-react-shim",
    setup(build) {
      build.onResolve(
        {
          filter:
            /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime)$/,
        },
        (args) => ({ path: args.path, namespace: "react-shim" }),
      );
      build.onLoad({ filter: /.*/, namespace: "react-shim" }, (args) => ({
        contents: SHIMS[args.path] || "module.exports = {};",
        loader: "js",
      }));
    },
  };
}

function virtualFsPlugin(files, serverCwd) {
  const project = { ...files };
  project[QA_ENTRY_PATH] = `
import React from "react";
import { createRoot } from "react-dom/client";
import App from "/App.js";
createRoot(document.getElementById("root")).render(React.createElement(App));
`;
  return {
    name: "renscraft-vfs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: "vfs" };
        }

        // ⚠️ KUNCI: cuma intercept import yang berasal dari file VFS.
        // Import dari file node_modules (react/index.js → ./cjs/...) harus
        // dibiarin esbuild resolve sendiri. Tanpa guard ini, plugin nyangkut
        // require internal React dan ngelempar "Cannot resolve ./cjs/...".
        if (args.namespace !== "vfs") return null;

        if (
          !args.path.startsWith(".") &&
          !args.path.startsWith("/") &&
          !args.path.startsWith("@/")
        ) {
          return null;
        }
        const spec = args.path.startsWith("@/")
          ? args.path.slice(2)
          : args.path;
        const resolved = resolveVirtual(args.importer, spec, project);
        if (!resolved) {
          return {
            errors: [
              {
                text: `Cannot resolve "${args.path}" from "${args.importer || "entry"}"`,
              },
            ],
          };
        }
        return { path: resolved, namespace: "vfs" };
      });
      build.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => {
        const ext = path.posix.extname(args.path).toLowerCase();
        if (ext === ".css") {
          return { contents: "", loader: "empty", resolveDir: serverCwd };
        }
        const code = project[args.path];
        if (typeof code !== "string") return null;
        return { contents: code, loader: "jsx", resolveDir: serverCwd };
      });
    },
  };
}

export function collectCss(files) {
  return Object.entries(files || {})
    .filter(([p]) => p.toLowerCase().endsWith(".css"))
    .map(([, code]) => (typeof code === "string" ? code : ""))
    .join("\n\n");
}

function formatError(err) {
  const msgs =
    err?.errors
      ?.map((e) => {
        const loc = e.location
          ? ` (${e.location.file}:${e.location.line})`
          : "";
        return e.text + loc;
      })
      .join("; ") || err?.message;
  return String(msgs).slice(0, 800);
}

export async function bundleProject(files) {
  if (!files || typeof files !== "object") {
    return { ok: false, error: "No files provided" };
  }
  if (!("/App.js" in files)) {
    return { ok: false, error: "Missing /App.js" };
  }

  const serverCwd = process.cwd();

  // Attempt 1: normal — biarkan esbuild resolve react dari node_modules.
  try {
    const result = await esbuild.build({
      entryPoints: [QA_ENTRY_PATH],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      target: ["es2020"],
      jsx: "automatic",
      loader: JS_LOADER,
      plugins: [virtualFsPlugin(files, serverCwd)],
      logLevel: "silent",
      absWorkingDir: serverCwd,
      sourcemap: false,
      mainFields: ["browser", "module", "main"],
      conditions: ["browser", "import", "default"],
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const code = result.outputFiles?.[0]?.text;
    if (!code) return { ok: false, error: "esbuild produced no output" };
    return { ok: true, code };
  } catch (err) {
    const errorText = formatError(err);

    // Attempt 2: react cjs hilang dari disk (install beneran rusak). Pakai UMD.
    if (isInfraBundleError(errorText)) {
      const umd = findReactUmd();
      if (umd) {
        // INFO, bukan WARN: jalur ini normalnya gak kejadian lagi setelah
        // guard `namespace !== "vfs"` dipasang. Warn di sini bikin lo nyangka
        // ada masalah terus tiap run.
        console.info(
          "[QA] React cjs not resolvable, using UMD fallback. " +
            'This should not happen on a healthy install; run "bun install --force" if it persists.',
        );
        try {
          const result = await esbuild.build({
            entryPoints: [QA_ENTRY_PATH],
            bundle: true,
            write: false,
            platform: "browser",
            format: "iife",
            target: ["es2020"],
            jsx: "automatic",
            loader: JS_LOADER,
            plugins: [reactShimPlugin(), virtualFsPlugin(files, serverCwd)],
            logLevel: "silent",
            absWorkingDir: serverCwd,
            sourcemap: false,
            define: { "process.env.NODE_ENV": '"production"' },
          });
          const code = result.outputFiles?.[0]?.text;
          if (code) {
            return {
              ok: true,
              code,
              reactUmd: umd.react,
              reactDomUmd: umd.reactDom,
            };
          }
        } catch (err2) {
          console.warn(
            `[QA] UMD fallback also failed: ${formatError(err2).slice(0, 300)}`,
          );
        }
      }
    }

    return { ok: false, error: errorText };
  }
}
