// status-worker/src/utils.ts

export const fetchWithTimeout = async (
  url: string,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "RenscraftStatusBot/1.0",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 0 } as RequestInitCfProperties,
    });
  } finally {
    clearTimeout(timer);
  }
};

export const dayKey = (nowMs: number, offsetMinutes: number): string => {
  return new Date(nowMs + offsetMinutes * 60000).toISOString().slice(0, 10);
};

export const safeEqual = (a: string, b: string): boolean => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
};

export const json = (body: unknown, init?: ResponseInit): Response => {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
};
