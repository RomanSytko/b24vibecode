import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Загружаем `.env` для локального запуска, идя вверх от этого файла (не от cwd).
// На задеплоенном сервере `.env` нет вообще (исключён из архива) — переменные
// приезжают в process.env, здесь это no-op. Значения из process.env всегда побеждают.
function loadEnvUpwards(startDir, maxLevels = 4) {
  let dir = path.resolve(startDir);
  for (let level = 0; level <= maxLevels; level += 1) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      try {
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (!m || m[1] in process.env) continue;
          process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
        }
      } catch {
        // Нечитаемый файл — считаем отсутствующим.
      }
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const KEY_FROM_ENVIRONMENT = typeof process.env.BITRIX_API_KEY === "string" && process.env.BITRIX_API_KEY !== "";
const ENV_FILE = loadEnvUpwards(__dirname);

const PORT = process.env.PORT || 3000;
const BASE = process.env.BITRIX_API_BASE_URL || "";
const KEY = process.env.BITRIX_API_KEY || "";
const PORTAL_DOMAIN = process.env.BITRIX_PORTAL_DOMAIN || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const PORTAL_TIMEOUT_MS = Number(process.env.PORTAL_TIMEOUT_MS || 180_000);
const REFRESH_MS = 5 * 60_000;

console.log(
  KEY
    ? `portal key loaded from ${KEY_FROM_ENVIRONMENT ? "the environment" : ENV_FILE}`
    : `NO portal key: ${ENV_FILE ? `${ENV_FILE} has no BITRIX_API_KEY` : "no .env found and none in the environment"}` +
      " — /api/* will report the missing key until it appears",
);

// ---- разбор отказов портала по error.code (см. bitrix-app-data) ----
class PortalError extends Error {
  constructor(kind, message, status, extra = {}) {
    super(message);
    this.kind = kind;
    this.status = status ?? null;
    this.code = extra.code ?? null;
    this.scope = extra.scope ?? null;
    this.userMessage = extra.userMessage ?? null;
    this.switchUrl = extra.switchUrl ?? null;
  }
}

const KIND_BY_CODE = new Map([
  ["MISSING_API_KEY", "no_key"],
  ["TOKEN_MISSING", "no_portal_access"],
  ["SCOPE_DENIED", "scope_denied"],
  ["WRITE_BLOCKED_READONLY_KEY", "read_only_key"],
  ["BITRIX_ACCESS_DENIED", "access_denied"],
  ["B24_TARIFF_RESTRICTION", "tariff"],
]);

function toPortalError(status, data) {
  const nested = data?.error && typeof data.error === "object" ? data.error : {};
  const code = nested.code ?? data?.code ?? null;
  const message = nested.message ?? (typeof data?.error === "string" ? data.error : null) ?? `portal_error_${status}`;
  const details = nested.details ?? data?.details ?? {};
  const userMessage = [nested.userMessage, data?.userMessage].find((v) => typeof v === "string" && v.trim()) ?? null;
  const kind = status === 429 ? "rate_limited"
    : KIND_BY_CODE.get(code) ?? (status === 401 ? "denied" : status === 403 ? "forbidden" : "portal_error");
  return new PortalError(kind, message, status, {
    code,
    userMessage,
    scope: kind === "scope_denied" ? missingScope(message, details) : null,
    switchUrl: kind === "read_only_key" ? cabinetLink(details.switchUrl) : null,
  });
}

function missingScope(message, details) {
  if (typeof details.requiredScope === "string") return details.requiredScope;
  const m = /(?:'|")([\w:-]+(?:\.[\w:-]+)*)(?:'|")/.exec(message)
    || /\b(vibe:[\w-]+(?:\.[\w-]+)*)/.exec(message)
    || /scope:\s*([\w:-]+(?:\.[\w:-]+)*)/i.exec(message);
  return m ? m[1] : null;
}

function cabinetLink(switchUrl) {
  if (typeof switchUrl !== "string" || !switchUrl) return null;
  try {
    const origin = new URL(BASE).origin;
    const url = new URL(switchUrl, origin);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

async function portal(pathname, { method = "GET", body, params } = {}) {
  if (!KEY || !BASE) throw new PortalError("no_key", "portal env vars are absent");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PORTAL_TIMEOUT_MS);
  const startedAt = Date.now();
  let url = `${BASE}${pathname}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    url += `?${qs.toString()}`;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": KEY,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
  } catch (err) {
    const kind = err?.name === "AbortError" ? "timeout" : "unreachable";
    throw new PortalError(kind, `${pathname} ${kind} after ${Date.now() - startedAt}ms`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw toPortalError(res.status, data);
  console.log(`[portal] ${pathname} -> ${res.status} in ${Date.now() - startedAt}ms`);
  return data?.data ?? data;
}

const HTTP_BY_KIND = {
  no_key: 503, timeout: 504, unreachable: 504, rate_limited: 429, portal_error: 502,
  denied: 403, no_portal_access: 403, scope_denied: 403, read_only_key: 403,
  access_denied: 403, tariff: 403, forbidden: 403,
};
const TEXT_BY_KIND = {
  no_key: "Приложение запущено без ключа приложения — данные портала недоступны.",
  timeout: "Портал отвечает дольше обычного, данные ещё не обновились. Он под нагрузкой — попробуйте через несколько минут.",
  unreachable: "Не удалось связаться с порталом. Похоже на временный сбой сети.",
  rate_limited: "Слишком много запросов к порталу. Данные обновятся через несколько минут.",
  denied: "Ключ приложения больше не действует: он отозван, истёк или недействителен. Переподключение Битрикс24 его не заменит: привяжите в карточке «Приложение» действующий ключ с нужными правами и опубликуйте приложение заново.",
  no_portal_access: "У ключа приложения нет действующего подключения к порталу Битрикс24. Причина видна на странице ключа в кабинете VibeCode; иногда доступ должен выдать администратор портала. Переподключать Битрикс24 не нужно: у приложения свой ключ.",
  scope_denied: "Ключу приложения не хватает права на эти данные. Добавьте нужное право ключу в кабинете VibeCode или привяжите в карточке «Приложение» ключ с нужным правом и опубликуйте приложение заново. Переподключать Битрикс24 не нужно: у приложения свой ключ.",
  read_only_key: "Ключ приложения открыт только на чтение, поэтому запись не выполнена. Переключите ключ приложения на чтение и запись в кабинете VibeCode.",
  access_denied: "Битрикс24 отказал в доступе: у сотрудника, от имени которого работает приложение, нет прав на эти данные. Права выдаёт администратор портала.",
  tariff: "Тариф портала Битрикс24 не включает эту возможность.",
  forbidden: "Платформа VibeCode отказала в доступе к данным портала.",
  portal_error: "Портал вернул ошибку при запросе данных.",
};

function failureText(error) {
  if (error.userMessage) return error.userMessage;
  if (error.code === "AGGREGATION_LIMIT_EXCEEDED") {
    return "Выбранный период слишком широк для агрегации сделок на этом портале. Выберите более короткий период (7/30/90 дней или свой интервал) — так данные посчитаются точно.";
  }
  if (error.kind === "scope_denied" && error.scope) {
    return `Ключу приложения не хватает права «${error.scope}». Добавьте это право ключу в кабинете VibeCode или привяжите в карточке «Приложение» ключ с этим правом и опубликуйте приложение заново. Переподключать Битрикс24 не нужно: у приложения свой ключ.`;
  }
  if (error.kind === "read_only_key" && error.switchUrl) {
    return `${TEXT_BY_KIND.read_only_key} Страница ключа: ${error.switchUrl}`;
  }
  return TEXT_BY_KIND[error.kind] || TEXT_BY_KIND.portal_error;
}

function noteFailure(err) {
  return {
    kind: err.kind || "portal_error",
    message: err.message,
    code: err.code ?? null,
    scope: err.scope ?? null,
    userMessage: err.userMessage ?? null,
    switchUrl: err.switchUrl ?? null,
  };
}

// ---- справочники, не зависящие от периода (обновляются раз в REFRESH_MS) ----
const dictionaries = {
  stages: [],     // [{code, name, semantics, sort}]
  users: [],      // [{id, name}]
  loading: false,
  loadedAt: 0,
  error: null,
};

async function loadStages() {
  let rows;
  try {
    rows = await portal("/statuses/search", {
      method: "POST",
      body: { filter: { entityId: "DEAL_STAGE" } },
    });
  } catch (err) {
    // Справочник стадий не критичен: при его отсутствии выводим коды стадий.
    if (err.kind === "scope_denied" && !dictionaries.error) dictionaries.error = err;
    return;
  }
  const list = Array.isArray(rows) ? rows : rows?.items ?? [];
  dictionaries.stages = list.map((s) => ({
    code: s.statusId ?? s.status,
    name: s.name ?? s.status,
    semantics: s.semantics ?? "",
    sort: Number(s.sort ?? 0),
  }));
}

async function loadUsers() {
  try {
    const rows = await portal("/users", { params: { limit: 5000 } });
    const list = Array.isArray(rows) ? rows : rows?.items ?? [];
    dictionaries.users = list.map((u) => ({
      id: Number(u.id),
      name: [u.name, u.lastName].filter(Boolean).join(" ") || `#${u.id}`,
    }));
  } catch (err) {
    if (err.kind === "scope_denied" && !dictionaries.error) dictionaries.error = err;
  }
}

async function refreshDictionaries() {
  if (dictionaries.loading) return;
  dictionaries.loading = true;
  try {
    await Promise.all([loadStages(), loadUsers()]);
    if (dictionaries.stages.length || dictionaries.users.length) {
      dictionaries.loadedAt = Date.now();
    }
  } finally {
    dictionaries.loading = false;
  }
}

// ---- снимки по периодам ----
// Портальные вызовы идут в фоне (никогда внутри запроса посетителя), результат
// кешируется по ключу периода. Устаревшие данные с честной подписью лучше ошибки.
const snapshots = new Map(); // periodKey -> {data, at, error, building}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Преобразует запрос клиента в безопасные границы периода. Валидация строгая:
// только даты YYYY-MM-DD, никакого произвольного текста в фильтры портала.
function resolvePeriod(query) {
  const preset = String(query.preset || "30d");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = isoDay(today);

  const presets = { "7d": 7, "30d": 30, "90d": 90 };

  if (preset in presets && presets[preset]) {
    const days = presets[preset];
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    return { key: preset, from: isoDay(from), to: todayIso, preset, label: `${days} дней` };
  }

  if (preset === "this_month") {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { key: "this_month", from: isoDay(from), to: todayIso, preset, label: "этот месяц" };
  }

  // Кастомные даты
  const fromRaw = String(query.from || "");
  const toRaw = String(query.to || "");
  if (!DATE_RE.test(fromRaw) || !DATE_RE.test(toRaw)) {
    // Некорректные/пустые даты — рабочий дефолт (последние 30 дней).
    const from = new Date(today);
    from.setDate(from.getDate() - 29);
    return { key: "30d", from: isoDay(from), to: todayIso, preset: "30d", label: "30 дней" };
  }
  const from = fromRaw <= toRaw ? fromRaw : toRaw;
  const to = toRaw >= fromRaw ? toRaw : fromRaw;
  return { key: `custom:${from}:${to}`, from, to, preset: "custom", label: `${from} — ${to}` };
}

function dealAmount(d) {
  const n = Number(d.amount);
  return Number.isFinite(n) ? n : 0;
}

// Безопасное приведение агрегата к числу (0 для undefined/null/не числа).
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Отфильтровывает агрегации, усечённые порталом (meta.truncated / OPERATION_TIME_LIMIT).
function isTruncated(agg) {
  const meta = agg?.meta;
  if (!meta) return false;
  if (meta.truncated === true) return true;
  const sample = meta.pageErrorSample;
  if (sample && sample.code === "OPERATION_TIME_LIMIT") return true;
  return false;
}

async function refreshPeriod(period) {
  const { key, from, to } = period;
  const p = snapshots.get(key) || { data: null, at: 0, error: null, building: false };
  if (p.building) return;
  p.building = true;
  snapshots.set(key, p);

  const ctx = { truncated: false };
  const stageFilter = {};
  if (from && to) { stageFilter.createdAt = { $gte: from, $lte: to }; }

  try {
    // 1) Сводка по стадиям: количество и сумма одним запросом с группировкой по stageId.
    // Фактический контракт (проверен на живом портале):
    //   data = { count, aggregates:{ amount:{ sum } }, groups:[ { stageId, count, aggregates:{ amount:{ sum } } }, ... ] }
    const stageAgg = await portal("/deals/aggregate", {
      method: "POST",
      body: {
        aggregate: [
          { field: "*", function: "count" },
          { field: "amount", function: "sum" },
        ],
        groupBy: "stageId",
        filter: stageFilter,
      },
    });
    if (isTruncated(stageAgg)) ctx.truncated = true;
    const stageRows = Array.isArray(stageAgg?.groups) ? stageAgg.groups : (Array.isArray(stageAgg) ? stageAgg : []);
    const map = new Map();
    for (const g of stageRows) {
      const code = g.stageId ?? g.group ?? null;
      map.set(code, {
        stageId: code,
        count: num(g.count) + num(g?.aggregates?.amount?.count),
        sum: num(g?.aggregates?.amount?.sum) + num(g?.aggregates?.amount?.value),
      });
    }

    const stageByName = new Map(dictionaries.stages.map((s) => [s.code, s]));
    const funnel = [...map.values()].map((row) => {
      const meta = stageByName.get(row.stageId);
      return {
        stageId: row.stageId,
        name: meta?.name || row.stageId,
        semantics: meta?.semantics ?? "",
        sort: meta?.sort ?? 0,
        count: row.count,
        sum: row.sum,
      };
    });
    funnel.sort((a, b) => a.sort - b.sort || a.stageId.localeCompare(b.stageId));

    // 2) KPI: открытые сделки (в работе) за период — из сводки по незакрытым
    // стадиям. В этом справочнике открытые стадии имеют семантику "" или "P",
    // закрытые — "S" (выиграно) и "F" (провалено).
    const open = funnel.filter((s) => s.semantics !== "S" && s.semantics !== "F");
    const openSum = open.reduce((a, s) => a + s.sum, 0);
    const openCount = open.reduce((a, s) => a + s.count, 0);
    const totalCount = funnel.reduce((a, s) => a + s.count, 0);

    // 3) KPI: выигранные сделки за период (по дате закрытия) + сумма + средний чек.
    const wonFilter = { stageSemanticId: "S" };
    if (from && to) wonFilter.closedAt = { $gte: from, $lte: to };
    const wonAgg = await portal("/deals/aggregate", {
      method: "POST",
      body: {
        aggregate: [
          { field: "*", function: "count" },
          { field: "amount", function: "sum" },
          { field: "amount", function: "avg" },
        ],
        groupBy: "stageSemanticId",
        filter: wonFilter,
      },
    });
    if (isTruncated(wonAgg)) ctx.truncated = true;
    const wonRows = Array.isArray(wonAgg?.groups) ? wonAgg.groups : (Array.isArray(wonAgg) ? wonAgg : []);
    const wonRow = wonRows.find((g) => (g.stageSemanticId ?? g.group) === "S") || wonRows[0] || {};
    const wonCount = num(wonRow.count) + num(wonRow?.aggregates?.amount?.count);
    const wonSum = num(wonRow?.aggregates?.amount?.sum) + num(wonRow?.aggregates?.amount?.value);
    const wonAvgRaw = num(wonRow?.aggregates?.amount?.avg);
    const wonAvg = wonAvgRaw || (wonCount > 0 ? wonSum / wonCount : 0);

    // 4) Последние сделки за период (по дате создания).
    let recentDeals = [];
    const recentFilter = { ...stageFilter };
    const recentRes = await portal("/deals/search", {
      method: "POST",
      body: {
        filter: recentFilter,
        sort: { createdAt: "desc" },
        select: ["id", "title", "amount", "currency", "stageId", "assignedById", "createdAt"],
        limit: 15,
      },
    });
    const recentList = Array.isArray(recentRes) ? recentRes : recentRes?.items ?? [];
    const userById = new Map(dictionaries.users.map((u) => [u.id, u.name]));
    recentDeals = recentList.map((d) => {
      const meta = stageByName.get(d.stageId);
      return {
        id: d.id,
        title: d.title || "Без названия",
        amount: dealAmount(d),
        currency: d.currency || "RUB",
        stageId: d.stageId,
        stageName: meta?.name || d.stageId,
        assignedById: d.assignedById,
        assignedName: userById.get(Number(d.assignedById)) || (d.assignedById ? `#${d.assignedById}` : "—"),
        createdAt: d.createdAt || null,
      };
    });

    // 5) Текущий пользователь (для заголовка).
    let user = null;
    try {
      const me = await portal("/users/me");
      user = { id: me?.id, name: [me?.name, me?.lastName].filter(Boolean).join(" ") || "Пользователь" };
    } catch (err) {
      if (err.kind === "scope_denied" && !dictionaries.error) dictionaries.error = err;
      user = { id: null, name: null };
    }

    p.data = {
      period,
      user,
      funnel,
      kpi: { openSum, openCount, wonCount, wonSum, wonAvg, totalCount },
      recentDeals,
      truncated: ctx.truncated,
      hasStages: dictionaries.stages.length > 0,
    };
    p.at = Date.now();
    p.error = null;
  } catch (err) {
    p.error = noteFailure(err);
    console.log(`[snapshot:${key}] refresh failed: ${p.error.kind}${p.error.code ? ` (${p.error.code})` : ""} — ${err.message}`);
  } finally {
    p.building = false;
  }
}

function requestPeriodKey(query) {
  return resolvePeriod(query).key;
}

// ---- HTTP сервер ----
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (url.pathname === "/api/dashboard") {
    const period = resolvePeriod({
      preset: url.searchParams.get("preset") || "30d",
      from: url.searchParams.get("from") || "",
      to: url.searchParams.get("to") || "",
    });
    const key = period.key;
    let p = snapshots.get(key);
    // Кнопка «Обновить» форсирует пересборку в фоне; текущий снимок всё равно
    // не возвращается ошибочным — данные остаются доступными, пока обновляются.
    if (url.searchParams.get("refresh") === "1" && p?.data && !p.building) {
      void refreshPeriod(period);
    }
    const meta = {
      period,
      portalDomain: PORTAL_DOMAIN,
      updatedAt: p?.at ? new Date(p.at).toISOString() : null,
      ageMs: p?.at ? Date.now() - p.at : null,
      building: p?.building ?? false,
      warning: p?.error ? failureText(p.error) : (dictionaries.error ? failureText(dictionaries.error) : null),
      truncated: p?.data?.truncated ?? false,
      hasStages: dictionaries.stages.length > 0,
    };

    if (p?.data) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ data: p.data, meta }));
      return;
    }

    if (!p || (!p.building && !p.error)) {
      // Снимка ещё нет — запускаем фоновую сборку и отвечаем "loading".
      void refreshPeriod(period);
    }
    const kind = p?.error?.kind ?? (KEY && BASE ? "loading" : "no_key");
    if (kind === "loading") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Данные ещё загружаются. Портал отвечает медленно, подождите.", meta }));
      return;
    }
    const failure = p?.error ?? { kind };
    res.writeHead(HTTP_BY_KIND[kind] || 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: failureText(failure), kind, code: failure.code ?? null, meta }));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      keyPresent: Boolean(KEY),
      keySource: KEY ? (KEY_FROM_ENVIRONMENT ? "environment" : ENV_FILE) : null,
      baseUrlPresent: Boolean(BASE),
      portalDomain: Boolean(PORTAL_DOMAIN),
      portalTimeoutMs: PORTAL_TIMEOUT_MS,
      dictionaries: { stages: dictionaries.stages.length, users: dictionaries.users.length, loadedAt: dictionaries.loadedAt ? new Date(dictionaries.loadedAt).toISOString() : null, lastError: dictionaries.error },
      snapshotCount: snapshots.size,
    }));
    return;
  }

  // Статика — только из public/, чтобы .env в корне сессии наружу не ушёл.
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const isDotfile = rel.split("/").some((seg) => seg.startsWith("."));
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const insidePublic = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (isDotfile || !insidePublic) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    const type = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => console.log(`listening on ${PORT}`));

// Первичная загрузка справочников после старта — приложение сразу доступно,
// а первый ответ портала может идти минуты.
void refreshDictionaries();
setInterval(() => void refreshDictionaries(), REFRESH_MS).unref();

// Предзаполняем снимок для рабочего периода по умолчанию (30 дней): агрегация
// с фильтром по дате проходит на любом портале и не упирается в лимит агрегации.
const defaultPeriod = resolvePeriod({ preset: "30d" });
void refreshPeriod(defaultPeriod);
