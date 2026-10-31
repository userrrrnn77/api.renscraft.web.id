// src/services/qa/render.js
import { chromium } from "playwright-core";
import { proxyFetch } from "../webReference.js";

const VIEWPORT = { width: 390, height: 800 };
const NAV_TIMEOUT_MS = 10_000;
const QUIET_AFTER_LOAD_MS = 500;
const IMAGE_HEAD_TIMEOUT_MS = 3_000;
const MAX_IMAGES_CHECKED = 10;
const IMAGE_CHECK_CONCURRENCY = 3;

const HTML_SHELL = (
  bundleCode,
  cssText,
  reactUmd = null,
  reactDomUmd = null,
) => {
  const umdScripts = [];
  if (reactUmd) umdScripts.push(`<script>${reactUmd}</script>`);
  if (reactDomUmd) umdScripts.push(`<script>${reactDomUmd}</script>`);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>${cssText || ""}</style>
<style>html,body{margin:0;padding:0;background:#fff;color:#111;font-family:system-ui,sans-serif}</style>
</head><body><div id="root"></div>
${umdScripts.join("\n")}
<script>${bundleCode}</script>
</body></html>`;
};

const isAllowed = (url) => /^(data|about|blob):/i.test(url);

// F5.4: HEAD check tiap <img src> non-data-URI via proxyFetch (SSRF-safe).
// Berjalan di Node, BUKAN di dalam Chromium. Gagal = warning IMAGE_BROKEN.
async function checkImages(imgSrcs) {
  const broken = [];
  const queue = [...imgSrcs];
  const workers = Array.from({ length: IMAGE_CHECK_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const src = queue.shift();
      if (!src) break;
      try {
        const res = await proxyFetch(src, {
          method: "HEAD",
          signal: AbortSignal.timeout(IMAGE_HEAD_TIMEOUT_MS),
        });
        if (res.status >= 400) broken.push(src);
      } catch {
        broken.push(src);
      }
    }
  });
  await Promise.all(workers);
  return broken;
}

export async function renderAndSmoke(
  bundleCode,
  cssText = "",
  { reactUmd = null, reactDomUmd = null } = {},
) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      ],
    });
  } catch (err) {
    const msg = String(err?.message || err);
    const unavailable =
      /Executable doesn't exist|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(
        msg,
      );
    return { ok: false, error: msg.slice(0, 400), unavailable };
  }

  const context = await browser.newContext({
    viewport: VIEWPORT,
    serviceWorkers: "block",
    acceptDownloads: false,
  });

  try {
    const blocked = new Set();
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (isAllowed(url)) return route.continue();
      blocked.add(url);
      return route.abort();
    });
    await context.routeWebSocket?.(/.*/, (ws) => ws.close());

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const loc = m.location()?.url;
      if (loc && blocked.has(loc)) return;
      consoleErrors.push(m.text().slice(0, 400));
    });
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));

    await page.setContent(
      HTML_SHELL(bundleCode, cssText, reactUmd, reactDomUmd),
      {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      },
    );

    await page.waitForTimeout(QUIET_AFTER_LOAD_MS);

    const smoke = await page.evaluate(() => {
      const root = document.getElementById("root");
      const rootChildren = root ? root.children.length : 0;

      const missingAnchors = [];
      for (const a of document.querySelectorAll('a[href^="#"]')) {
        const id = a.getAttribute("href").slice(1);
        if (id && !document.getElementById(id)) missingAnchors.push(id);
      }

      const overflow =
        document.documentElement.scrollWidth > window.innerWidth + 1;

      // F5.4: kumpulkan src gambar (non-data-URI) untuk HEAD check di Node.
      const imgSrcs = [];
      for (const img of document.querySelectorAll("img[src]")) {
        const src = img.getAttribute("src") || "";
        if (/^https?:\/\//i.test(src)) imgSrcs.push(src);
        if (imgSrcs.length >= 10) break;
      }

      return { rootChildren, missingAnchors, overflow, imgSrcs };
    });

    const brokenImages = await checkImages(
      (smoke.imgSrcs || []).slice(0, MAX_IMAGES_CHECKED),
    );

    return {
      ok: true,
      smoke: {
        consoleErrors,
        pageErrors,
        rootChildren: smoke.rootChildren,
        missingAnchors: smoke.missingAnchors,
        overflow: smoke.overflow,
        brokenImages,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 400) };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
