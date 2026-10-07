// Тест: «один 429 → после паузы данные есть».
// Поднимает фейковый портал: первый запрос отвечает 429, второй — 200 с данными.
// fetchWithRetry должен переждать паузу, повторить и вернуть данные.

import http from "node:http";
import assert from "node:assert";
import { fetchWithRetry, retryAfterMs } from "../lib/http.js";

const server = http.createServer((req, res) => {
  if (globalThis.__hits !== undefined) {
    globalThis.__hits += 1;
  }
  if (globalThis.__hits === 1) {
    res.writeHead(429, { "Retry-After": "0", "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "RATE_LIMITED" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: { ok: 1, deals: 5 } }));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

globalThis.__hits = 0;
const url = `http://127.0.0.1:${port}/deals/aggregate`;

const res = await fetchWithRetry(url, { method: "POST" }, {
  maxRetries: 3,
  defaultDelayMs: 30,
  log: (m) => console.log(m),
});

assert.strictEqual(res.status, 200, `ожидали 200 после ретрая, получили ${res.status}`);
const body = await res.json();
assert.strictEqual(body.data.ok, 1, "данные не пришли после ретрая");
assert.ok(globalThis.__hits >= 2, "портал не получил повторный запрос");

console.log(`ok: hits=${globalThis.__hits}, status=${res.status}, data.ok=${body.data.ok} — «один 429 → после паузы данные есть» выполнен`);

server.close();
