// src/services/semaphore.js
//
// F4: proses-wide semaphore yang membungkus SEMUA panggilan LLM, lintas user
// dan project. MAX_CONCURRENCY (p-map di ai.js) tetap berlaku per project;
// semaphore ini membatasi total lintas project.
//
// Env: AI_GLOBAL_CONCURRENCY (default 10),
//      AI_SEMAPHORE_TIMEOUT_MS  (default 240000 = 4 menit).
//
// Kalau acquire timeout, throw error dengan code "SEMAPHORE_TIMEOUT" — retry
// loop di ai.js memperlakukan ini sebagai fatal (nggak retry lagi).

const DEFAULT_MAX = 10;
const DEFAULT_TIMEOUT_MS = 240_000;

export function createSemaphore(maxConcurrency, acquireTimeoutMs) {
  let active = 0;
  const queue = [];

  function release() {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      // Slot diserahkan langsung ke waiter; jangan lepas dulu.
      next.resolve(release);
    } else {
      active = Math.max(0, active - 1);
    }
  }

  async function acquire() {
    if (active < maxConcurrency) {
      active++;
      return release;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = queue.findIndex((w) => w.reject === reject);
        if (idx !== -1) queue.splice(idx, 1);
        const err = new Error(
          `LLM slot acquire timed out after ${acquireTimeoutMs}ms (max=${maxConcurrency})`,
        );
        err.code = "SEMAPHORE_TIMEOUT";
        reject(err);
      }, acquireTimeoutMs);
      timer.unref?.();
      queue.push({ resolve, reject, timer });
    });
  }

  return { acquire, release };
}

let _global = null;

export function getGlobalSemaphore(env = process.env) {
  if (_global) return _global;
  const max = Math.max(
    1,
    Number.parseInt(env.AI_GLOBAL_CONCURRENCY ?? "", 10) || DEFAULT_MAX,
  );
  const timeout = Math.max(
    1_000,
    Number.parseInt(env.AI_SEMAPHORE_TIMEOUT_MS ?? "", 10) ||
      DEFAULT_TIMEOUT_MS,
  );
  _global = createSemaphore(max, timeout);
  return _global;
}

export function _resetGlobalSemaphore() {
  _global = null;
}
