(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const app = $("app");

  const state = {
    preset: "30d",
    from: "",
    to: "",
    portalDomain: "",
    pendingTimer: null,
  };

  const moneyFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const shortMoneyFmt = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
    notation: "compact",
    compactDisplay: "short",
  });

  function money(n) {
    const v = Number(n) || 0;
    return moneyFmt.format(Math.round(v));
  }

  function currencySuffix(code) {
    const map = { RUB: "₽", USD: "$", EUR: "€", BYN: "Br", KZT: "₸", UAH: "₴" };
    return map[code] || " " + (code || "");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
  }

  function ageText(ageMs) {
    if (ageMs == null) return "";
    const min = Math.max(1, Math.round(ageMs / 60000));
    return `обновлено ${min} мин назад`;
  }

  function closeTo(text) {
    const el = document.createElement("div");
    el.textContent = text;
    return el.textContent;
  }

  // ---------- период ----------
  function setPreset(p) {
    state.preset = p;
    state.from = "";
    state.to = "";
    document.querySelectorAll(".chip").forEach((b) => {
      b.setAttribute("aria-selected", b.dataset.preset === p ? "true" : "false");
    });
    load();
  }

  function applyCustom() {
    const from = $("dateFrom").value;
    const to = $("dateTo").value;
    if (!from || !to) { showStatus("Выберите обе даты для кастомного периода."); return; }
    state.preset = "custom";
    state.from = from;
    state.to = to;
    document.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-selected", "false"));
    load();
  }

  function periodQuery() {
    const p = new URLSearchParams();
    p.set("preset", state.preset);
    if (state.preset === "custom") {
      p.set("from", state.from);
      p.set("to", state.to);
    }
    return p.toString();
  }

  // ---------- состояние интерфейса ----------
  function showStatus(text) {
    const line = $("statusLine");
    if (!text) { line.hidden = true; line.textContent = ""; return; }
    line.textContent = text;
    line.hidden = false;
  }

  function showState(title, text) {
    // Простой экран состояния: заглушка вместо панелей.
    let el = document.querySelector(".state");
    if (!el) {
      el = document.createElement("div");
      el.className = "state";
      const h = document.createElement("h3");
      const p = document.createElement("p");
      el.append(h, p);
      app.insertBefore(el, app.querySelector("main"));
    }
    el.querySelector("h3").textContent = title;
    el.querySelector("p").textContent = text;
  }

  function clearState() {
    const el = document.querySelector(".state");
    if (el) el.remove();
  }

  // ---------- рендер ----------
  function renderLoading() {
    clearState();
    const kpis = ["kpiOpenSum", "kpiWonCount", "kpiAvg"];
    kpis.forEach((k) => { $(k).textContent = "…"; });
    showStatus("Загружаем данные с портала — первый ответ может занять больше минуты…");
    renderStageEmpty();
    renderDealsEmpty();
  }

  function render(data, meta) {
    clearState();
    showStatus(meta.warning || "");
    state.portalDomain = meta.portalDomain || "";

    // Пользователь
    if (data.user && data.user.name) {
      $("userBox").hidden = false;
      $("userName").textContent = data.user.name;
      $("userRole").textContent = data.user.id ? "портал" : "гость";
    } else {
      $("userBox").hidden = true;
    }

    // KPI
    const k = data.kpi || {};
    $("kpiOpenSum").textContent = `${money(k.openSum)} ₽`;
    $("kpiOpenNote").textContent = `${money(k.openCount)} сделок в работе · ${money(k.totalCount)} создано за период`;
    $("kpiWonCount").textContent = money(k.wonCount);
    $("kpiWonNote").textContent = `на сумму ${money(k.wonSum)} ₽`;
    $("kpiAvg").textContent = `${money(k.wonAvg)} ₽`;
    $("kpiAvgNote").textContent = "по выигранным сделкам периода";

    // Воронка
    renderFunnel(data.funnel || []);

    // Последние сделки
    renderDeals(data.recentDeals || []);

    // Подвал
    const parts = [];
    parts.push(meta.updatedAt ? closeTo(ageText(meta.ageMs)) : "данные ещё не собраны");
    if (meta.period) parts.push(`период: ${meta.period.label}`);
    if (data.truncated) parts.push("⚠ счётчик неполный: диапазон слишком широк для точного расчёта");
    $("footer").textContent = parts.join(" · ");
  }

  function renderFunnel(funnel) {
    const list = $("funnelList");
    list.textContent = "";
    $("funnelMeta").textContent = funnel.length ? `${funnel.length} стадий` : "";
    if (!funnel.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Нет сделок за выбранный период.";
      list.appendChild(e);
      return;
    }
    const tpl = $("stageRow");
    const maxSum = Math.max(...funnel.map((s) => s.sum), 0);
    const maxCount = Math.max(...funnel.map((s) => s.count), 0);
    const bySum = maxSum > 0;
    for (const s of funnel) {
      const row = tpl.content.firstElementChild.cloneNode(true);
      const base = bySum ? maxSum : maxCount;
      const share = base > 0 ? Math.max(3, (bySum ? s.sum : s.count) / base * 100) : 3;
      row.querySelector(".stage-name").textContent = closeTo(s.name);
      row.querySelector(".stage-count").textContent = `${s.count} шт.`;
      row.querySelector(".stage-sum").textContent = `${money(s.sum)} ₽`;
      row.querySelector(".stage-fill").style.width = `${share}%`;
      if (s.semantics === "S") row.classList.add("sem-won");
      if (s.semantics === "F") row.classList.add("sem-lost");
      list.appendChild(row);
    }
    requestAnimationFrame(() => {
      list.querySelectorAll(".stage-fill").forEach((el) => { el.style.width = el.style.width; });
    });
  }

  function renderStageEmpty() {
    $("funnelList").textContent = "";
    $("funnelMeta").textContent = "";
  }

  function renderDeals(deals) {
    const body = $("dealsBody");
    body.textContent = "";
    $("recentMeta").textContent = deals.length ? `${deals.length} сделок` : "";
    if (!deals.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "empty";
      td.textContent = "Нет сделок за выбранный период.";
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    const tpl = $("dealRow");
    for (const d of deals) {
      const tr = tpl.content.firstElementChild.cloneNode(true);
      const link = tr.querySelector(".deal-link");
      link.textContent = closeTo(d.title);
      if (state.portalDomain && d.id) {
        link.href = `https://${state.portalDomain}/crm/deal/details/${d.id}/`;
      } else {
        link.replaceWith(document.createTextNode(closeTo(d.title)));
      }
      tr.querySelector(".deal-amount").textContent = `${money(d.amount)} ${currencySuffix(d.currency).trim()}`;
      const pill = tr.querySelector(".pill");
      pill.textContent = closeTo(d.stageName);
      if (d.stageId === "WON" || /:WON$/.test(d.stageId)) pill.classList.add("won");
      if (/LOSE|:LOSE|FAIL/.test(d.stageId)) pill.classList.add("lost");
      tr.querySelector(".deal-owner").textContent = closeTo(d.assignedName);
      tr.querySelector(".deal-date").textContent = fmtDate(d.createdAt);
      body.appendChild(tr);
    }
  }

  function renderDealsEmpty() {
    $("dealsBody").textContent = "";
    $("recentMeta").textContent = "";
  }

  // ---------- загрузка ----------
  async function load() {
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = null; }
    renderLoading();
    try {
      await fetchDashboard();
    } catch {
      showState("Не удалось загрузить данные", "Проверьте состояние сервера и повторите попытку.");
    }
  }

  async function fetchDashboard({ refresh = false } = {}) {
    let qs = periodQuery();
    if (refresh) qs += "&refresh=1";
    let res, json;
    try {
      res = await fetch(`/api/dashboard?${qs}`, { cache: "no-store" });
      json = await res.json().catch(() => null);
    } catch {
      showState("Сервер не отвечает", "Попробуйте обновить страницу через несколько секунд.");
      return;
    }

    if (res.status === 202) {
      showStatus(json?.error || "Данные ещё загружаются с портала…");
      scheduleRetry();
      return;
    }

    if (!res.ok) {
      if (json?.kind === "no_session") {
        showState("Нужна авторизованная сессия", "Откройте приложение из портала Битрикс24 (пункт меню / вкладка), будучи вошедшим в систему, — тогда дашборд покажет аналитику сделок.");
      } else {
        showState("Данные недоступны", json?.error || `Ошибка ${res.status}`);
      }
      if (json?.meta?.period) $("footer").textContent = `период: ${json.meta.period.label}`;
      return;
    }

    if (json && json.data) {
      render(json.data, json.meta || {});
      if (json.meta && json.meta.warning) return; // предупреждение уже показано в status line
    }
  }

  function scheduleRetry() {
    state.pendingTimer = setTimeout(() => { fetchDashboard(); }, 5000);
  }

  // ---------- events ----------
  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => setPreset(btn.dataset.preset));
  });
  $("applyCustom").addEventListener("click", applyCustom);
  $("refreshBtn").addEventListener("click", () => { fetchDashboard({ refresh: true }); });
  $("dateFrom").addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustom(); });
  $("dateTo").addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustom(); });

  // ---------- старт ----------
  setPreset("30d");
})();
