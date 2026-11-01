// FILE: src/services/contract/designTokens.js

import postcss from "postcss";

const SERVER_START = "/* @server-design:start */";
const SERVER_END = "/* @server-design:end */";

const FALLBACKS = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  "sans-serif":
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  monospace:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

const cssFontFamily = (family) =>
  `"${String(family).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const fontVar = (font, fallbackKind) => {
  const kind = font?.kind || fallbackKind;
  const fallback = FALLBACKS[kind] || FALLBACKS["sans-serif"];
  const family = String(font?.family ?? "").trim();
  return family ? `${cssFontFamily(family)}, ${fallback}` : fallback;
};

const fontImportFamily = (family) =>
  String(family)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("+");

export function buildFontImport(preset) {
  const fonts = preset?.fonts ?? {};
  const ordered = [fonts.display, fonts.body, fonts.code].filter(Boolean);
  const families = new Map();

  for (const font of ordered) {
    const family = String(font?.family ?? "").trim();
    if (!family) continue;

    const key = family.toLowerCase();
    if (!families.has(key)) {
      families.set(key, { family, weights: new Set() });
    }

    const entry = families.get(key);
    for (const raw of String(font?.weights ?? "").split(";")) {
      const weight = raw.trim();
      if (weight) entry.weights.add(weight);
    }
  }

  if (families.size === 0) return "";

  const parts = [];
  for (const { family, weights } of families.values()) {
    const encoded = fontImportFamily(family);
    const list = [...weights];
    parts.push(
      list.length > 0
        ? `family=${encoded}:wght@${list.join(";")}`
        : `family=${encoded}`,
    );
  }

  return `@import url('https://fonts.googleapis.com/css2?${parts.join("&")}&display=swap');`;
}

function rootVars(tokens, fonts) {
  const vars = [
    `--c-bg:${tokens.bg};`,
    `--c-surface:${tokens.surface};`,
    `--c-tint:color-mix(in srgb, var(--c-ink) 6%, var(--c-surface));`,
    `--c-ink:${tokens.ink};`,
    `--c-muted:${tokens.muted};`,
    `--c-line:${tokens.line};`,
    `--c-accent:${tokens.accent};`,
    `--c-accent-ink:${tokens.accentInk};`,
  ];

  if (tokens.accent2) vars.push(`--c-accent-2:${tokens.accent2};`);
  if (tokens.accent3) vars.push(`--c-accent-3:${tokens.accent3};`);

  vars.push(
    `--f-display:${fontVar(fonts.display, "sans-serif")};`,
    `--f-body:${fontVar(fonts.body, "sans-serif")};`,
    `--f-code:${
      fonts.code ? fontVar(fonts.code, "monospace") : FALLBACKS.monospace
    };`,
  );

  return vars.join("");
}

export function buildTokenCss(preset, { needsTheme } = {}) {
  if (!preset || typeof preset !== "object") {
    return `${SERVER_START}\n${SERVER_END}\n`;
  }

  const tokens = preset.tokens ?? {};
  const fonts = preset.fonts ?? {};
  const chunks = [];

  chunks.push(`:root{${rootVars(tokens, fonts)}}`);

  if (needsTheme && preset.dark) {
    const dark = preset.dark;
    const value = (key) => dark[key] ?? tokens[key];
    const darkVars = [
      `--c-bg:${value("bg")};`,
      `--c-surface:${value("surface")};`,
      `--c-tint:color-mix(in srgb, var(--c-ink) 6%, var(--c-surface));`,
      `--c-ink:${value("ink")};`,
      `--c-muted:${value("muted")};`,
      `--c-line:${value("line")};`,
      `--c-accent:${value("accent")};`,
      `--c-accent-ink:${value("accentInk")};`,
    ];

    if (dark.accent2) darkVars.push(`--c-accent-2:${dark.accent2};`);
    if (dark.accent3) darkVars.push(`--c-accent-3:${dark.accent3};`);

    chunks.push(`html.dark{${darkVars.join("")}}`);
  }

  chunks.push(
    [
      ".bg-app{background-color:var(--c-bg)}",
      ".bg-surface{background-color:var(--c-surface)}",
      ".bg-tint{background-color:var(--c-tint)}",
      ".bg-accent{background-color:var(--c-accent);color:var(--c-accent-ink)}",
      ".bg-accent-2{background-color:var(--c-accent-2)}",
      ".text-ink{color:var(--c-ink)}",
      ".text-muted{color:var(--c-muted)}",
      ".text-accent{color:var(--c-accent)}",
      ".text-on-accent{color:var(--c-accent-ink)}",
      ".border-line{border-color:var(--c-line)}",
      ".border-accent{border-color:var(--c-accent)}",
      ".font-display{font-family:var(--f-display)}",
      ".font-body{font-family:var(--f-body)}",
      ".font-code{font-family:var(--f-code)}",
    ].join(""),
  );

  const bodyExtras = tokens.bgImage
    ? `background-image:${tokens.bgImage};background-attachment:fixed;`
    : "";

  chunks.push(
    [
      `body{background-color:var(--c-bg);color:var(--c-ink);font-family:var(--f-body);${bodyExtras}}`,
      "h1,h2,h3,h4{font-family:var(--f-display)}",
      ":focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}",
      "::selection{background:var(--c-accent);color:var(--c-accent-ink)}",
      "@media (prefers-reduced-motion: no-preference){html{scroll-behavior:smooth}}",
      "@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}}",
    ].join(""),
  );

  return `${SERVER_START}\n${chunks.join("\n")}\n${SERVER_END}\n`;
}

function removeOldServerDesign(css) {
  const source = String(css ?? "");
  const start = source.indexOf(SERVER_START);
  if (start === -1) return source;

  const end = source.indexOf(SERVER_END, start + SERVER_START.length);
  if (end === -1) return source;

  let cutStart = start;
  const before = source.slice(0, start);
  const fontRe =
    /@import\s+url\(['"]https:\/\/fonts\.googleapis\.com\/css2\?[^'"]+['"]\);\s*$/;
  const match = before.match(fontRe);
  if (match) cutStart = start - match[0].length;

  let cutEnd = end + SERVER_END.length;
  while (cutEnd < source.length && /\s/.test(source[cutEnd])) cutEnd += 1;

  return source.slice(0, cutStart) + source.slice(cutEnd);
}

export function injectDesignTokens(files, contract) {
  const preset = contract?.design?.preset;
  if (!preset || !files || typeof files !== "object") return files;

  const stylesPath = "/styles.css";
  if (
    !Object.hasOwn(files, stylesPath) ||
    typeof files[stylesPath] !== "string"
  ) {
    return files;
  }

  const css = removeOldServerDesign(files[stylesPath]);
  const fontImport = buildFontImport(preset);
  const tokenCss = buildTokenCss(preset, {
    needsTheme: Boolean(contract?.needsTheme),
  });

  let root;
  try {
    root = postcss.parse(css);
  } catch {
    let next = css.replace(/\s+$/, "");
    if (next) next += "\n\n";
    next += tokenCss;
    return { ...files, [stylesPath]: next };
  }

  const hasFontImport = Boolean(fontImport) && css.includes(fontImport);
  const block = `${hasFontImport || !fontImport ? "" : `${fontImport}\n`}${tokenCss}\n`;

  // Cari offset node pertama yang BUKAN @charset/@import/komentar. Sisipkan
  // block di string asli (bukan lewat root.toString()) supaya byte CSS lain
  // tidak berubah dan hasilnya idempoten.
  let offset = css.length;
  for (const node of root.nodes) {
    if (node.type === "comment") continue;
    if (
      node.type === "atrule" &&
      (node.name === "charset" || node.name === "import")
    ) {
      continue;
    }
    offset = node.source?.start?.offset ?? css.length;
    break;
  }

  let head = css.slice(0, offset);
  const tail = css.slice(offset);
  if (head && !head.endsWith("\n")) head += "\n";

  return { ...files, [stylesPath]: head + block + tail };
}
