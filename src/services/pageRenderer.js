// src/services/pageRenderer.js
// Fallback untuk halaman SPA: webReference.js cuma membaca HTML statis, jadi
// halaman yang isinya baru muncul setelah JavaScript jalan (mis. portfolio
// React/Vite) terbaca kosong. Di sini halaman dibuka di Chromium headless,
// ditunggu sampai render, lalu HTML hasilnya dikembalikan untuk diproses
// extractPage yang sama.
//
// Opsional: kalau `playwright-core` / Chromium tidak terpasang, renderPage()
// mengembalikan null dan builder berjalan seperti biasa.
//
// KEAMANAN: browser TIDAK pernah membuka koneksi sendiri. Setiap request
// (dokumen, script, XHR, redirect) dicegat dan dijalankan ulang lewat
// proxyFetch() milik webReference.js, yaitu SSRF guard yang sama dengan fetch
// halaman biasa (blok IP privat, validasi DNS saat koneksi), dan redirect
// diikuti di sini hop demi hop. WebSocket ditutup. Sebagai lapis terakhir,
// browser diarahkan ke proxy mati supaya request yang lolos dari interceptor
// (preconnect, dll.) gagal. Catatan: Chromium melewatkan proxy untuk alamat
// loopback, jadi proxy mati BUKAN pengganti interceptor di atas.
import { assertPublicUrl, BROWSER_UA, proxyFetch } from "./webReference.js";

// ── Timeout & limit ─────────────────────────────────────────────────────────
//
// Semua angka di sini di-set buat "adaptive wait": kita tunggu sampai DOM dan
// network beneran sepi, bukan sekadar tunggu X detik. Ini penting karena situs
// dengan serverless API (cold start 5-15s) atau lazy-load bertingkat butuh
// waktu yang sangat beda-beda — angka fixed selalu kalah di salah satu kasus.

const NAV_TIMEOUT_MS = 15000; // buat page.goto() dan waitForLoadState
const NETWORK_IDLE_MS = 6000; // networkidle pertama, setelah load
const STABILITY_MAX_MS = 15000; // maksimal nunggu DOM tenang
const STABILITY_QUIET_MS = 1200; // DOM + network harus sepi selama ini
const STABILITY_MIN_MS = 3000; // minimal nunggu ini setelah load
const TOTAL_TIMEOUT_MS = 45000; // batas keras per halaman
const MAX_REQUESTS = 200; // request per halaman (naik dari 80)
const MAX_REDIRECTS = 5;
const MAX_HTML_CHARS = 3 * 1024 * 1024;
const MAX_CONCURRENT_PAGES = 2;
const BROWSER_IDLE_MS = 60_000;

// Ukuran body dibedakan per resource type: bundle JS modern bisa 5-30MB,
// CSS Tailwind full ~5MB, tapi HTML / XHR / image biasanya < 3MB.
const MAX_BODY_BYTES_DEFAULT = 3 * 1024 * 1024;
const MAX_BODY_BYTES_SCRIPT = 25 * 1024 * 1024;
const MAX_BODY_BYTES_STYLE = 8 * 1024 * 1024;

// ── Resource yang di-block ──────────────────────────────────────────────────

// Gambar/media tidak perlu diunduh untuk baca DOM. <img src> tetap ada di DOM
// walau gambarnya tidak dimuat; assetMirror yang mengunduh gambarnya nanti.
const BLOCKED_RESOURCES = new Set([
  "image",
  "media",
  "font",
  "texttrack",
  "manifest",
  "eventsource",
  "websocket",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
]);

const withTimeout = (promise, ms, message) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

async function readCapped(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes)
      throw new Error(`response too large (> ${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const defaultLoadChromium = async () => {
  const mod = await import("playwright-core");
  return mod.chromium ?? mod.default?.chromium;
};

// ── Adaptive wait helpers ───────────────────────────────────────────────────
//
// Pasang MutationObserver di page context, catat timestamp mutasi terakhir.
// Di Node, cek tiap 200ms: apakah DOM udah sepi >= STABILITY_QUIET_MS DAN
// network udah sepi (nggak ada request in-flight) selama itu juga. Selesai
// kalau iya, atau maxWaitMs tercapai.

async function installMutationWatcher(page) {
  await page.evaluate(() => {
    window.__renscraftLastMutation = Date.now();
    if (window.__renscraftObserver) {
      try {
        window.__renscraftObserver.disconnect();
      } catch {}
    }
    window.__renscraftObserver = new MutationObserver(() => {
      window.__renscraftLastMutation = Date.now();
    });
    window.__renscraftObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  });
}

async function readLastMutation(page) {
  try {
    return await page.evaluate(() => window.__renscraftLastMutation ?? 0);
  } catch {
    // page navigated atau context closing — anggap "baru aja berubah" biar loop nunggu
    return Date.now();
  }
}

async function waitForQuiet(page, state, { maxWaitMs, quietMs, minWaitMs }) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(200);
    const lastMutation = await readLastMutation(page);
    const domQuiet = Date.now() - lastMutation;
    const netQuiet = Date.now() - (state.lastNetworkActivity ?? 0);
    const age = Date.now() - start;
    if (age >= minWaitMs && domQuiet >= quietMs && netQuiet >= quietMs) {
      return;
    }
  }
}

// Scroll pelan sampai bawah, trigger IntersectionObserver & lazy load.
async function scrollToBottom(page, maxHeight) {
  await page
    .evaluate(async (maxScroll) => {
      const max = Math.min(document.documentElement.scrollHeight, maxScroll);
      for (let y = 0; y < max; y += 400) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 180));
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    }, maxHeight)
    .catch(() => {});
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createPageRenderer({
  loadChromium = defaultLoadChromium,
  assertUrl = assertPublicUrl,
  fetchFn = proxyFetch,
  userAgent = BROWSER_UA,
  isEnabled = () => process.env.REFERENCE_RENDER !== "off",
  launchOptions = () => ({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--dns-prefetch-disable",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    ],
    proxy: { server: "per-context" },
  }),
} = {}) {
  let browserPromise = null;
  let idleTimer = null;
  let active = 0;
  let unavailable = false;
  const waiters = [];

  const acquire = () =>
    active < MAX_CONCURRENT_PAGES
      ? (active++, Promise.resolve())
      : new Promise((resolve) => waiters.push(resolve));

  const release = () => {
    const next = waiters.shift();
    if (next) return next();
    active--;
    if (active === 0) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(closeBrowser, BROWSER_IDLE_MS);
      idleTimer.unref?.();
    }
  };

  async function closeBrowser() {
    const pending = browserPromise;
    browserPromise = null;
    if (!pending) return;
    try {
      await (await pending).close();
    } catch {
      // sudah mati
    }
  }

  const getBrowser = () => {
    clearTimeout(idleTimer);
    if (!browserPromise) {
      browserPromise = (async () => {
        const chromium = await loadChromium();
        if (!chromium)
          throw new Error("playwright-core has no chromium export");
        const browser = await chromium.launch(launchOptions());
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })();
      browserPromise.catch(() => {
        browserPromise = null;
      });
    }
    return browserPromise;
  };

  // Semua request browser lewat sini. Update state.lastNetworkActivity supaya
  // waitForQuiet() tahu kapan network beneran udah sepi.
  const handleRoute = (state) => async (route) => {
    const req = route.request();
    const url = req.url();
    state.lastNetworkActivity = Date.now();
    state.inFlight = (state.inFlight ?? 0) + 1;
    try {
      if (/^(data|blob|about):/i.test(url)) return await route.continue();
      if (BLOCKED_RESOURCES.has(req.resourceType())) return await route.abort();
      if (++state.requests > MAX_REQUESTS) return await route.abort();

      let current = assertUrl(url).href;

      const headers = {};
      for (const [k, v] of Object.entries(await req.allHeaders())) {
        if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
      }
      let method = req.method();
      let body =
        method === "GET" || method === "HEAD"
          ? undefined
          : req.postDataBuffer();

      let res;
      for (let hop = 0; ; hop++) {
        res = await fetchFn(current, { method, headers, body });
        const location = res.headers.get("location");
        if (!(res.status >= 300 && res.status < 400 && location)) break;
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");

        const next = assertUrl(new URL(location, current).href);
        if (next.origin !== new URL(current).origin) {
          for (const k of Object.keys(headers)) {
            if (/^(cookie|authorization)$/i.test(k)) delete headers[k];
          }
        }
        if (
          [301, 302, 303].includes(res.status) &&
          method !== "GET" &&
          method !== "HEAD"
        ) {
          method = "GET";
          body = undefined;
        }
        current = next.href;
      }

      // Pilih limit berdasarkan resourceType — bundle JS modern bisa > 3MB
      const rt = req.resourceType();
      const maxBytes =
        rt === "script"
          ? MAX_BODY_BYTES_SCRIPT
          : rt === "stylesheet"
            ? MAX_BODY_BYTES_STYLE
            : MAX_BODY_BYTES_DEFAULT;

      const buffer = await readCapped(res.body ?? [], maxBytes);

      const out = {};
      res.headers.forEach((value, key) => {
        if (
          !STRIP_RESPONSE_HEADERS.has(key.toLowerCase()) &&
          key.toLowerCase() !== "set-cookie"
        ) {
          out[key] = value;
        }
      });
      const cookies = res.headers.getSetCookie?.() ?? [];
      if (cookies.length) out["set-cookie"] = cookies.join("\n");

      await route.fulfill({ status: res.status, headers: out, body: buffer });
    } catch (err) {
      state.blocked.push(`${url.slice(0, 80)} (${err.message})`);
      try {
        await route.abort();
      } catch {
        // halaman sudah ditutup
      }
    } finally {
      state.inFlight = Math.max(0, (state.inFlight ?? 1) - 1);
      state.lastNetworkActivity = Date.now();
    }
  };

  async function renderOnce(rawUrl) {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent,
      // Viewport lebih tinggi: banyak section langsung "kelihatan" tanpa scroll,
      // jadi IntersectionObserver langsung trigger.
      viewport: { width: 1440, height: 1200 },
      serviceWorkers: "block",
      acceptDownloads: false,
      proxy: { server: "http://127.0.0.1:9" },
    });
    const state = {
      requests: 0,
      blocked: [],
      inFlight: 0,
      lastNetworkActivity: Date.now(),
    };
    try {
      await context.route("**/*", handleRoute(state));
      await context.routeWebSocket?.(/.*/, (ws) => ws.close());
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);

      // 1. Tunggu load (bukan cuma DOMContentLoaded) supaya asset dasar selesai.
      //    Kalau `load` nggak pernah fire (resource hang), lanjut aja — nanti
      //    `waitForQuiet` yang nentuin kapan berhenti.
      try {
        await page.goto(rawUrl, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        if (!/Timeout/i.test(err.message)) throw err;
        console.warn(`[Render] load event timeout, continuing`);
      }

      // 2. Network idle awal — catch API call yang dipicu useEffect/mount.
      //    Serverless cold start bisa 5-15s, jadi timeout di sini besar.
      await page
        .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS })
        .catch(() => {});

      // 3. Pasang MutationObserver + tunggu DOM sepi (adaptive).
      await installMutationWatcher(page);
      await waitForQuiet(page, state, {
        maxWaitMs: STABILITY_MAX_MS,
        quietMs: STABILITY_QUIET_MS,
        minWaitMs: STABILITY_MIN_MS,
      });

      // 4. Scroll pass 1 — trigger lazy-load & section di bawah.
      const height1 = await page
        .evaluate(() => document.documentElement.scrollHeight)
        .catch(() => 0);
      await scrollToBottom(page, 12000);

      // 5. Tunggu network setelah scroll (gambar lazy, XHR infinite scroll).
      await page
        .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS })
        .catch(() => {});
      await waitForQuiet(page, state, {
        maxWaitMs: STABILITY_MAX_MS,
        quietMs: STABILITY_QUIET_MS,
        minWaitMs: 1000,
      });

      // 6. Kalau halaman jadi jauh lebih tinggi (infinite scroll / lazy section
      //    baru muncul), scroll sekali lagi. Cek pakai growth ratio biar nggak
      //    ke-trigger oleh perubahan 1-2px dari reflow.
      const height2 = await page
        .evaluate(() => document.documentElement.scrollHeight)
        .catch(() => 0);
      if (height2 > height1 * 1.15) {
        await scrollToBottom(page, 20000);
        await page
          .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS })
          .catch(() => {});
        await waitForQuiet(page, state, {
          maxWaitMs: STABILITY_MAX_MS,
          quietMs: STABILITY_QUIET_MS,
          minWaitMs: 1000,
        });
      }

      // 7. Balik ke atas — beberapa library (dropdown, tooltip) butuh ini
      //    buat reset state sebelum snapshot.
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

      const finalUrl = assertUrl(page.url()).href;
      const html = (await page.content()).slice(0, MAX_HTML_CHARS);
      if (state.blocked.length) {
        console.warn(
          `[Render] ${state.blocked.length} request(s) blocked: ${state.blocked.slice(0, 3).join("; ")}`,
        );
      }
      return { html, url: finalUrl };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function renderPage(rawUrl) {
    if (!isEnabled() || unavailable) return null;
    assertUrl(rawUrl);

    await acquire();
    try {
      return await withTimeout(
        renderOnce(rawUrl),
        TOTAL_TIMEOUT_MS,
        "render timed out",
      );
    } catch (err) {
      if (
        /Cannot find (package|module)|Executable doesn't exist|ERR_MODULE_NOT_FOUND/i.test(
          err.message,
        )
      ) {
        unavailable = true;
        console.warn(
          "[Render] Chromium not available, JS rendering disabled. Install: npm i playwright-core && npx playwright-core install chromium (or set CHROMIUM_PATH).",
        );
        return null;
      }
      throw err;
    } finally {
      release();
    }
  }

  renderPage.close = closeBrowser;
  return renderPage;
}

export const renderPage = createPageRenderer();
export const closeRenderer = () => renderPage.close();
