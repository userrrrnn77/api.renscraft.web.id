// FILE: src/services/exportZip.js
//
// Fase 4: port apa adanya dari client `utils/exportProject.js`.
// Fase R6: tambah elemen watermark statis untuk project remake (di luar root
// React, supaya tetap muncul walau app dihidrasi ulang).

import JSZip from "jszip";
import {
  detectDependencies,
  PREVIEW_EXTERNAL_RESOURCES,
} from "./sandpackDeps.js";

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

export const exportFileName = (name) =>
  `${(name || "website").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zip`;

// Elemen kecil di index.html untuk project remake. Disimpan statis (di luar
// root React) supaya tetap muncul meski app dihidrasi ulang. Teks badge
// mengikuti versi EN (ZIP selalu EN, sama seperti title/package).
function buildRemakeWatermarkHtml(remakeOf, projectId) {
  if (!Array.isArray(remakeOf) || remakeOf.length === 0) return "";
  const SITE_URL = process.env.SITE_URL || "https://renscraft.cyou";
  const reportHref = projectId
    ? `${SITE_URL}/contact?report=${encodeURIComponent(String(projectId))}`
    : `${SITE_URL}/contact`;
  const more = remakeOf.length > 1 ? ` +${remakeOf.length - 1}` : "";
  const domain = escapeHtml(remakeOf[0]);

  return `  <div id="renscraft-remake-badge" style="position:fixed;bottom:12px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(255,255,255,0.95);border:1px solid #e4e4e7;border-radius:9999px;font:11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#52525b;box-shadow:0 4px 12px rgba(0,0,0,0.08);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);">
    <span>Remade from ${domain}${more}</span>
    <span style="color:#a1a1aa;">&middot;</span>
    <span>made with Renscraft</span>
    <span style="color:#a1a1aa;">&middot;</span>
    <a href="${escapeHtml(reportHref)}" target="_blank" rel="noopener noreferrer" style="color:#dc2626;text-decoration:none;font-weight:600;">Report</a>
  </div>
`;
}

/**
 * @param {{ name?: string, _id?: any, remakeOf?: string[], files: Record<string, string> }} project
 * @returns {Promise<Buffer>}
 */
export async function buildExportZip(project) {
  const zip = new JSZip();

  const fileMap = {};
  for (const [path, content] of Object.entries(project.files || {})) {
    const fileCode =
      typeof content === "string" ? content : content?.content || "";
    fileMap[path] = fileCode;
  }
  const detectedDeps = detectDependencies(fileMap);

  zip.file(
    "package.json",
    JSON.stringify(
      {
        name: (project.name || "my-website")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-"),
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: {
          dev: "vite",
          build: "vite build",
          preview: "vite preview",
        },
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
          ...detectedDeps,
        },
        devDependencies: {
          "@vitejs/plugin-react": "^4.2.0",
          vite: "^5.0.0",
          tailwindcss: "^3.4.0",
          autoprefixer: "^10.4.0",
          postcss: "^8.4.0",
        },
      },
      null,
      2,
    ),
  );

  zip.file(
    "vite.config.js",
    `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  esbuild: {
    loader: 'jsx',
    include: /src\\/.*\\.jsx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        '.js': 'jsx',
      },
    },
  },
});
`,
  );

  const watermarkHtml = buildRemakeWatermarkHtml(project.remakeOf, project._id);

  zip.file(
    "index.html",
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(project.name || "My Website")}</title>
${PREVIEW_EXTERNAL_RESOURCES.map((href) => `  <link rel="stylesheet" href="${href}" />`).join("\n")}
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { darkMode: "class" };</script>
</head>
<body>
  <div id="root"></div>
${watermarkHtml}  <script type="module" src="/src/index.jsx"></script>
</body>
</html>
`,
  );

  zip.file(
    "src/index.jsx",
    `import React from 'react';
import { createRoot } from 'react-dom/client';
${Object.hasOwn(fileMap, "/styles.css") ? "import './styles.css';\n" : ""}import App from './App';

createRoot(document.getElementById('root')).render(<App />);
`,
  );

  for (const [path, content] of Object.entries(fileMap)) {
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    zip.file(`src/${cleanPath}`, content);
  }

  return zip.generateAsync({ type: "nodebuffer" });
}
