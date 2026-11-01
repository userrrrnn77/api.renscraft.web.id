// src/services/promptsV2.js
// Prompt V2 (design system) untuk brief-mode. Dipakai hanya bila
// process.env.PROMPT_V2 === "1" dan hasBrief (lihat promptV2() di prompts.js).
// Blok "verbatim" selalu diambil dari BASE_SYSTEM_LEGACY lewat sliceBetween /
// sliceFrom, jadi kalau legacy berubah, import ini gagal keras (bukan diam-diam).

// --- Helpers --------------------------------------------------------------

export function sliceBetween(src, start, end) {
  if (typeof src !== "string")
    throw new Error("[prompts] source is not a string");
  const startIdx = src.indexOf(start);
  if (startIdx === -1) throw new Error(`[prompts] marker not found: ${start}`);
  const endIdx = src.indexOf(end, startIdx + start.length);
  if (endIdx === -1) throw new Error(`[prompts] marker not found: ${end}`);
  return src.slice(startIdx, endIdx);
}

// Dari marker `start` sampai akhir string.
export function sliceFrom(src, start) {
  if (typeof src !== "string")
    throw new Error("[prompts] source is not a string");
  const startIdx = src.indexOf(start);
  if (startIdx === -1) throw new Error(`[prompts] marker not found: ${start}`);
  return src.slice(startIdx);
}

export function replaceOrThrow(src, from, to) {
  if (typeof src !== "string")
    throw new Error("[prompts] source is not a string");
  if (from instanceof RegExp) {
    from.lastIndex = 0;
    if (!from.test(src)) throw new Error(`[prompts] marker not found: ${from}`);
    from.lastIndex = 0;
    return src.replace(from, () => to);
  }
  if (typeof from === "string") {
    if (!src.includes(from))
      throw new Error(`[prompts] marker not found: ${from}`);
    return src.replace(from, () => to);
  }
  throw new Error("[prompts] `from` must be a string or RegExp");
}

// --- Blok baru (teks dari PRD 5.6 C) ---------------------------------------

const ROLE =
  "You are a senior frontend developer and designer building a website for a real small business or person. You follow the Design system in PROJECT CONTRACT exactly.";

const SECTION_DISCIPLINE = `## SECTION DISCIPLINE

- Sections come only from the plan. Never add a section that is not in the plan.
- Pricing, Testimonials, Team and Stats exist only when the plan lists them.`;

const DESIGN_SYSTEM = `## DESIGN SYSTEM
- Colors, fonts, radius, border and shadow come ONLY from the 'Design system' block in PROJECT CONTRACT. The server writes them as CSS variables into /styles.css.
- Use the semantic classes for brand colors: bg-app, bg-surface, bg-tint, bg-accent, text-ink, text-muted, text-accent, text-on-accent, border-line, border-accent, font-display, font-body, font-code. For hover/focus/responsive states use typed arbitrary values, e.g. hover:bg-[color:var(--c-accent)].
- Never hardcode zinc/gray/indigo/violet or hex values for backgrounds, text or accents.
- Do not add a font @import or :root variables to /styles.css. The server does it.
- No gradient text, gradient buttons, blobs, glows or a badge/chip above the headline, unless the Design system 'Style' line requires them.
- No uppercase tracked label above every section title. Use one only when it carries information.
- Spend boldness in one place: one signature element (usually the hero). Everything else stays quiet.
- Do not make all cards identical: vary size or layout at most once per page, keep the rest consistent.
- H1 max 8 words. Headings use font-display, text uses font-body. Body line length max 70ch.`;

const THEME_EXTRA =
  "Semantic classes already switch through html.dark variables; every other color utility still needs its dark: counterpart.";

const COMPONENTS = `## COMPONENTS
- Hero: follow the 'Arahan hero' line of the brief. No fixed 100vh. One primary CTA.
- Navigation: sticky, bg-app with border-line, logo left, links, one CTA. Mobile hamburger.
- Sections: only those in the plan. Lists (menu, products, services, projects) use cards with the Design system radius, border and shadow.
- Footer: bg-surface, contact data from the brief only.`;

const MOTION = `## MOTION
- One page-load sequence only: stagger the hero elements with .animate-fade-up and style={{animationDelay}}.
- Everything else moves only in response to user action (hover, press, open, expand). No fadeInUp on every section or card, no looping float.
- Keep the keyframes and .animate-* classes defined in /styles.css.`;

const COPY = `## COPY
- Write in the language of the user's prompt (default Indonesian). Be specific and local, not generic marketing.
- Never use: Elevate, Unlock, Seamless, Revolutionize, Next-level, Welcome to, Solusi terbaik, Your journey.
- A CTA is verb + object that says what happens: 'Pesan via WhatsApp', 'Lihat menu', 'Hubungi kami'. Never 'Submit' or 'Click here'. Same action, same name everywhere.
- Facts come only from the brief. The brief rules win.`;

const QUALITY_FLOOR = `## QUALITY FLOOR
- Text contrast 4.5:1. Interactive targets at least 44x44px. cursor-pointer on every clickable non-button. alt on every img. label or aria-label on every input and icon-only button.
- No horizontal scroll at 375px width. Hover must not shift layout. Use z-index steps 10, 20, 30, 50 only.
- Focus-visible, reduced-motion and selection styles come from the server. Do not override them.`;

// --- IMAGES: legacy (placeholder gradient abu-abu) -> V2 (bg-tint) ----------

const LEGACY_PLACEHOLDER_JSX = `<div className='relative aspect-[4/3] grid place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900'>
  <i className='fa-solid fa-mug-hot text-4xl text-zinc-400 dark:text-zinc-500' aria-hidden='true'></i>
</div>`;

const V2_PLACEHOLDER_JSX = `<div className='relative aspect-[4/3] grid place-items-center overflow-hidden bg-tint border border-line'><i className='fa-solid fa-mug-hot text-4xl text-muted' aria-hidden='true'></i></div>`;

function toV2Images(images) {
  let s = images;

  // JSX placeholder
  s = replaceOrThrow(s, LEGACY_PLACEHOLDER_JSX, V2_PLACEHOLDER_JSX);

  // Kalimat yang menyebut gray / gradient untuk placeholder
  s = replaceOrThrow(
    s,
    "use a **gradient card** — a neutral gray block with a Font Awesome icon centered. This is the premium, intentional look.",
    "use a **placeholder card** — a `bg-tint` block with a `border-line` border, the Design system radius and a Font Awesome icon centered.",
  );
  s = replaceOrThrow(
    s,
    "That's it. No blur, no glow, no dot grid, no white box around the icon, no text inside the card, no colored gradient. The card is a plain gray square with one icon.",
    "That's it. Add the Design system radius class to the outer div. No blur, no glow, no dot grid, no white box around the icon, no text inside the card, no gradient. The card is a plain tinted square with one icon.",
  );
  s = replaceOrThrow(
    s,
    "### THE DEFAULT: gradient + icon cards",
    "### THE DEFAULT: placeholder + icon cards",
  );
  s = replaceOrThrow(
    s,
    "### GRADIENT CARDS ARE MANDATORY FOR",
    "### PLACEHOLDER CARDS ARE MANDATORY FOR",
  );

  // HARD RULE 4 dan 5
  s = replaceOrThrow(
    s,
    "4. NO decorations on the gradient card.",
    "4. NO decorations on the placeholder card.",
  );
  s = replaceOrThrow(
    s,
    /5\. NO colored gradients\.[^\n]*\n/,
    "5. NO gradients and NO hardcoded zinc/gray/accent colors on placeholders. Always `bg-tint border border-line` with a `text-muted` icon; semantic classes switch by themselves in dark mode.\n",
  );

  // Sisa penyebutan lama: toleran (tidak throw), supaya model tidak
  // menggambar ulang gradient zinc dari ingatan.
  s = s
    .replaceAll("gradient + `fa-user`", "placeholder + `fa-user`")
    .replaceAll("Gradient + `fa-print`", "Placeholder + `fa-print`")
    .replaceAll("gradient circle + initials", "`bg-tint` circle + initials")
    .replaceAll("gradient-card", "placeholder-card")
    .replaceAll("gradient card", "placeholder card")
    .replaceAll("gradient default", "placeholder default")
    .replaceAll("swap the gradient block", "swap the placeholder block")
    .replaceAll("gradient + icon card", "placeholder + icon card")
    .replaceAll(
      "style it with a gradient + large typography",
      "style it with `bg-tint` + large typography",
    )
    .replaceAll(
      "style it with a gradient + typography",
      "style it with `bg-tint` + typography",
    )
    .replaceAll(
      "overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-900",
      "overflow-hidden bg-tint",
    )
    .replaceAll("bg-zinc-100 dark:bg-zinc-900", "bg-tint")
    .replaceAll("text-zinc-400", "text-muted");

  return s;
}

// --- V2 base builder ------------------------------------------------------

export function buildBaseSystemV2(legacy) {
  if (typeof legacy !== "string" || legacy.length === 0) {
    throw new Error("[prompts] legacy base must be a non-empty string");
  }

  const intent =
    sliceBetween(
      legacy,
      "## INTENT RECOGNITION",
      "2. **Marketing / Corporate / SaaS Websites**",
    ).trimEnd() + "\nAnything else: build the website described by the plan.";

  const theme =
    sliceBetween(legacy, "### THEME TOGGLE", "- **Light Mode**").trimEnd() +
    "\n" +
    THEME_EXTRA;

  const icons = sliceBetween(legacy, "## 6. ICONS", "## 7. IMAGES")
    .trimEnd()
    .replace(/\n+---$/, "");

  const images = toV2Images(
    sliceBetween(legacy, "## 7. IMAGES", "## 8. COPY WRITING STANDARDS")
      .trimEnd()
      .replace(/\n+---$/, ""),
  );

  const technical = sliceFrom(legacy, "## TECHNICAL RULES").trimEnd();

  return (
    [
      ROLE,
      intent,
      SECTION_DISCIPLINE,
      DESIGN_SYSTEM,
      theme,
      COMPONENTS,
      MOTION,
      icons,
      images,
      COPY,
      QUALITY_FLOOR,
      technical,
    ].join("\n\n---\n\n") + "\n"
  );
}

// --- Revise note (V2) -----------------------------------------------------

export const REVISE_V2_NOTE =
  "\n\nMatch the existing look of the project: reuse the semantic classes (bg-app, bg-surface, text-ink, text-muted, border-line, font-display) already used in the files. Do not introduce other colors or fonts.";

// --- Per-file code rules (V2) --------------------------------------------

export const FILE_CODE_V2 = {
  designRule: "Apply the Design system from PROJECT CONTRACT.",
  stylesRule:
    "The /styles.css file MUST include @keyframes float/fadeInUp/fadeIn and the .animate-* classes. Do NOT write a font @import or :root color variables; the server adds them.",
};
