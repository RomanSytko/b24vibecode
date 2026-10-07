// Утилиты сетевых запросов к порталу с корректной обработкой 429.

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Парсит заголовок Retry-After: целое число секунд или HTTP-дата.
export function retryAfterMs(res, defMs) {
  const raw = res?.headers?.get?.("retry-after");
  if (!raw) return defMs;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    const diff = date - Date.now();
    return Math.max(0, diff);
  }
  return defMs;
}

// fetch с повтором на 429. Пауза берётся из Retry-After, иначе defaultDelayMs.
// Возвращает последний ответ (последний 429, если лимит повторов исчерпан).
export async function fetchWithRetry(url, options, {
  maxRetries = 3,
  defaultDelayMs = 30_000,
  log = () => {},
} = {}) {
  let res;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    res = await fetch(url, options);
    const last = attempt === maxRetries - 1;
    if (!last && res.status === 429) {
      const wait = retryAfterMs(res, defaultDelayMs);
      log(`  429 → retry in ${wait}ms (${attempt + 2}/${maxRetries})`);
      await sleep(wait);
      continue;
    }
    return res;
  }
  return res;
}
