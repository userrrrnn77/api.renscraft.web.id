// src/services/siteCrawler.js
//
// Crawler minimal untuk mode "remake": kumpulkan URL halaman dari root URL
// (sitemap → robots → link homepage → render JS kalau perlu). Semua fetch
// lewat fetchText/proxyFetch dari webReference.js sehingga SSRF guard yang
// sama tetap berlaku. Tidak pernah throw: kalau semua gagal, caller fallback
// ke satu halaman (root URL).

import * as cheerio from "cheerio";
import {
  assertPublicUrl,
  extractPage,
  fetchText,
  BROWSER_UA,
} from "./webReference.js";

const DEFAULT_MAX_PAGES = Number(process.env.REFERENCE_CRAWL_MAX_PAGES) || 5;
const DEFAULT_TIMEOUT_MS =
  Number(process.env.REFERENCE_CRAWL_TIMEOUT_MS) || 60000;

const SITEMAP_MAX_BYTES = 2 * 1024 * 1024;
const SITEMAP_MAX_HOPS = 3;
const SITEMAP_MAX_LOCS = 500;
const ROBOTS_MAX_BYTES = 200 * 1024;
const HOMEPAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const MIN_TEXT_CHARS = 200;
const MIN_HOMEPAGE_LINKS = 3;

// Buang URL yang ekstensinya file biner / gambar / arsip / sumber non-halaman.
const SKIP_EXT_RE =
  /\.(pdf|zip|rar|7z|tar|gz|tgz|jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|mp3|mp4|mov|avi|mkv|webm|wav|flac|doc|docx|xls|xlsx|ppt|pptx|csv|txt|json|xml|rss|atom|js|mjs|css|woff2?|ttf|otf|eot)$/i;

// Buang pola login/admin/commerce/CDN.
const SKIP_PATH_RE =
  /\/(login|signin|sign-in|signup|sign-up|register|admin|wp-admin|wp-login|cart|checkout|account|my-account|cdn-cgi|logout|signout|auth)(\/|$)/i;

// Prioritas kata kunci path. Index 0 = paling tinggi.
const KEYWORD_PRIORITY = [
  /(^|\/)(about|tentang)(\/|$)/i,
  /(^|\/)(contact|kontak)(\/|$)/i,
  /(^|\/)(services|layanan)(\/|$)/i,
  /(^|\/)(product|produk)(\/|$)/i,
  /(^|\/)(pricing|harga)(\/|$)/i,
  /(^|\/)(menu)(\/|$)/i,
  /(^|\/)(gallery|galeri)(\/|$)/i,
  /(^|\/)(portfolio)(\/|$)/i,
  /(^|\/)(faq)(\/|$)/i,
];

const normalizeHost = (hostname) =>
  hostname.toLowerCase().replace(/^www\./, "");

const logCrawl = (msg) => {
  if (process.env.NODE_ENV !== "test") console.log(`[Crawl] ${msg}`);
};

export async function discoverPages(rootUrl, opts = {}) {
  const maxPages = Math.max(1, Number(opts.maxPages) || DEFAULT_MAX_PAGES);
  const timeoutMs = Math.max(
    1000,
    Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS,
  );
  const render = typeof opts.render === "function" ? opts.render : null;
  const deadline = Date.now() + timeoutMs;

  let rootHref;
  let rootHostKey;
  let rootOrigin;
  try {
    const root = assertPublicUrl(rootUrl);
    root.pathname = "/";
    root.search = "";
    root.hash = "";
    rootHref = root.href;
    rootOrigin = root.origin;
    rootHostKey = normalizeHost(root.hostname);
  } catch {
    return [];
  }

  const results = [{ url: rootHref, source: "root" }];

  try {
    // ── Normalisasi kandidat URL ─────────────────────────────────────────
    const normalize = (raw) => {
      let u;
      try {
        u = new URL(raw, rootHref);
      } catch {
        return null;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (normalizeHost(u.hostname) !== rootHostKey) return null;
      if (SKIP_EXT_RE.test(u.pathname)) return null;
      if (SKIP_PATH_RE.test(u.pathname)) return null;
      u.search = "";
      u.hash = "";
      return `${rootOrigin}${u.pathname}`;
    };

    const fetchSafe = async (url, o) => {
      if (Date.now() >= deadline) return null;
      try {
        return await fetchText(url, o);
      } catch {
        return null;
      }
    };

    // ── Sitemap (index + url) ────────────────────────────────────────────
    const sitemapLocs = [];
    const seenSitemaps = new Set();

    const walkSitemap = async (sitemapUrl, hop) => {
      if (hop > SITEMAP_MAX_HOPS) return;
      if (Date.now() >= deadline) return;

      let su;
      try {
        su = new URL(sitemapUrl, rootHref);
      } catch {
        return;
      }
      if (normalizeHost(su.hostname) !== rootHostKey) return;
      const key = su.href;
      if (seenSitemaps.has(key)) return;
      seenSitemaps.add(key);

      const r = await fetchSafe(key, {
        maxBytes: SITEMAP_MAX_BYTES,
        types: /xml/i,
        accept: "application/xml,text/xml,*/*;q=0.5",
      });
      if (!r) return;

      let $;
      try {
        $ = cheerio.load(r.text, { xmlMode: true });
      } catch {
        return;
      }

      const isIndex = $("sitemapindex").length > 0;
      if (isIndex) {
        const subSitemaps = $("sitemap")
          .map((_, el) => $(el).find("loc").first().text().trim())
          .get()
          .filter(Boolean)
          .slice(0, SITEMAP_MAX_LOCS);
        for (const loc of subSitemaps) {
          if (Date.now() >= deadline) return;
          await walkSitemap(loc, hop + 1);
        }
        return;
      }

      const pageLocs = $("url")
        .map((_, el) => $(el).find("loc").first().text().trim())
        .get()
        .filter(Boolean)
        .slice(0, SITEMAP_MAX_LOCS);
      for (const loc of pageLocs) sitemapLocs.push(loc);
    };

    await walkSitemap(`${rootOrigin}/sitemap.xml`, 0);

    // ── robots.txt ───────────────────────────────────────────────────────
    const disallow = [];
    const robotsSitemaps = [];
    const robots = await fetchSafe(`${rootOrigin}/robots.txt`, {
      maxBytes: ROBOTS_MAX_BYTES,
      types: /text\/plain|text\/html/i,
      accept: "text/plain,*/*;q=0.5",
    });
    if (robots) {
      for (const line of robots.text.split(/\r?\n/)) {
        const d = /^\s*Disallow\s*:\s*(\S+)/i.exec(line);
        if (d && d[1] && d[1] !== "/") disallow.push(d[1]);
        const s = /^\s*Sitemap\s*:\s*(\S+)/i.exec(line);
        if (s && s[1]) robotsSitemaps.push(s[1].trim());
      }
    }
    for (const sm of robotsSitemaps) {
      if (Date.now() >= deadline) break;
      await walkSitemap(sm, 0);
    }

    // ── Homepage HTML + link ─────────────────────────────────────────────
    const extractLinks = (html, base) => {
      const $ = cheerio.load(html);
      const navSet = new Set();
      const list = [];

      const push = (target, href) => {
        if (!href) return;
        if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
        try {
          const norm = normalize(new URL(href, base).href);
          if (norm) target === "nav" ? navSet.add(norm) : list.push(norm);
        } catch {
          // ignore
        }
      };

      $("header a[href], nav a[href], footer a[href]").each((_, el) =>
        push("nav", $(el).attr("href")),
      );
      $("a[href]").each((_, el) => push("list", $(el).attr("href")));
      return { navSet, list };
    };

    let homepageHtml = null;
    const hp = await fetchSafe(rootHref, {
      maxBytes: HOMEPAGE_MAX_BYTES,
      types: /text\/html|application\/xhtml\+xml/i,
      accept: "text/html,application/xhtml+xml,*/*;q=0.5",
      userAgent: BROWSER_UA,
    });
    if (hp) homepageHtml = hp.text;

    let linkSet = { navSet: new Set(), list: [] };
    if (homepageHtml) {
      let textLen = 0;
      try {
        textLen = extractPage(homepageHtml, rootHref).text.length;
      } catch {
        textLen = 0;
      }
      linkSet = extractLinks(homepageHtml, rootHref);

      if (
        (textLen < MIN_TEXT_CHARS ||
          linkSet.list.length < MIN_HOMEPAGE_LINKS) &&
        render &&
        Date.now() < deadline
      ) {
        try {
          const r = await render(rootHref);
          if (r?.html) {
            homepageHtml = r.html;
            linkSet = extractLinks(r.html, r.url || rootHref);
          }
        } catch {
          // ignore
        }
      }
    } else if (render && Date.now() < deadline) {
      try {
        const r = await render(rootHref);
        if (r?.html) {
          homepageHtml = r.html;
          linkSet = extractLinks(r.html, r.url || rootHref);
        }
      } catch {
        // ignore
      }
    }

    // ── Kandidat + ranking ──────────────────────────────────────────────
    const candidates = new Map();

    const addCandidate = (raw, source, isNav) => {
      const norm = normalize(raw);
      if (!norm) return;
      if (norm === rootHref) return;
      const path = new URL(norm).pathname;
      if (path === "/" || path === "") return;

      let kw = 0;
      for (let i = 0; i < KEYWORD_PRIORITY.length; i++) {
        if (KEYWORD_PRIORITY[i].test(path)) {
          kw = KEYWORD_PRIORITY.length - i;
          break;
        }
      }

      const prev = candidates.get(norm);
      if (prev) {
        if (isNav) prev.nav = true;
        if (kw > prev.keywordScore) prev.keywordScore = kw;
        return;
      }
      candidates.set(norm, {
        url: norm,
        source,
        keywordScore: kw,
        nav: isNav,
        pathLen: path.length,
      });
    };

    for (const loc of sitemapLocs) addCandidate(loc, "sitemap", false);
    for (const u of linkSet.navSet) addCandidate(u, "nav", true);
    for (const u of linkSet.list) addCandidate(u, "link", false);

    const isDisallowed = (url) => {
      if (disallow.length === 0) return false;
      try {
        const p = new URL(url).pathname;
        return disallow.some((d) => p.startsWith(d));
      } catch {
        return false;
      }
    };

    const ranked = [...candidates.values()]
      .filter((c) => !isDisallowed(c.url))
      .sort((a, b) => {
        if (a.keywordScore !== b.keywordScore)
          return b.keywordScore - a.keywordScore;
        if (a.nav !== b.nav) return (b.nav ? 1 : 0) - (a.nav ? 1 : 0);
        if (a.pathLen !== b.pathLen) return a.pathLen - b.pathLen;
        return a.url.localeCompare(b.url);
      });

    const seen = new Set([rootHref]);
    for (const c of ranked) {
      if (results.length >= maxPages) break;
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      results.push({ url: c.url, source: c.source });
    }

    logCrawl(
      `${rootHref} → ${results.length} page(s): ${results
        .map((r) => r.source)
        .join(",")}`,
    );

    return results;
  } catch (err) {
    logCrawl(`discovery failed for ${rootHref}: ${err?.message ?? err}`);
    return results;
  }
}
