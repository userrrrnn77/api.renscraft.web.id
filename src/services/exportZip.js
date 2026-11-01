// FILE: src/services/exportZip.js
//
// Fase 4: port apa adanya dari client `utils/exportProject.js`.
// Isi zip (package.json, vite.config.js, index.html, src/index.jsx, src/<file>)
// dan urutannya sama persis dengan versi client. Yang pindah cuma tempat
// membangunnya: sekarang di server, hasilnya Buffer.
//
// PENTING: `./sandpackDeps.js` HARUS berisi salinan verbatim dari dua export di
// client `utils/sandpackUtils`: `detectDependencies` dan
// `PREVIEW_EXTERNAL_RESOURCES`. Jangan diubah supaya hasil zip tetap sama.

import JSZip from "jszip";
import {
  detectDependencies,
  PREVIEW_EXTERNAL_RESOURCES,
} from "./sandpackDeps.js";

// Project names come from the model: never put them in HTML unescaped
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

// Nama file zip. Dipakai controller (Content-Disposition); client menghitung
// dengan rumus yang sama untuk saveAs().
export const exportFileName = (name) =>
  `${(name || "website").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zip`;

/**
 * @param {{ name?: string, files: Record<string, string> }} project
 *   `files` = { "/App.js": "<kode>" } (hasil filesToObject).
 * @returns {Promise<Buffer>}
 */
export async function buildExportZip(project) {
  const zip = new JSZip();

  // Normalize files and detect dependencies from import statements
  const fileMap = {};
  for (const [path, content] of Object.entries(project.files || {})) {
    const fileCode =
      typeof content === "string" ? content : content?.content || "";
    fileMap[path] = fileCode;
  }
  const detectedDeps = detectDependencies(fileMap);

  // Add package.json
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

  // Add vite.config.js configured for JSX parsing in both .js and .jsx files
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

  // Add index.html
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
  <script type="module" src="/src/index.jsx"></script>
</body>
</html>
`,
  );

  // Add index.jsx entry
  zip.file(
    "src/index.jsx",
    `import React from 'react';
import { createRoot } from 'react-dom/client';
${Object.hasOwn(fileMap, "/styles.css") ? "import './styles.css';\n" : ""}import App from './App';

createRoot(document.getElementById('root')).render(<App />);
`,
  );

  // Add project files
  for (const [path, content] of Object.entries(fileMap)) {
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    zip.file(`src/${cleanPath}`, content);
  }

  // Default JSZip (STORE, tanpa kompresi) sama seperti versi client.
  return zip.generateAsync({ type: "nodebuffer" });
}
