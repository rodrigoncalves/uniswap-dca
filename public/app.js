    const fmt = (n, digits = 2) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
    const fmtUsd = (n) => (n === null || n === undefined ? "—" : "$" + fmt(n, 2));
    const fmtBtc = (n) => (n === null || n === undefined ? "—" : Number(n).toFixed(8));
    // dd/MM/yyyy everywhere. A bare "YYYY-MM-DD" is a UTC date (reformatted, no
    // timezone shift); a full ISO timestamp is shown in the browser's local time.
    const pad2 = (n) => String(n).padStart(2, "0");
    const fmtDate = (v) => {
      if (!v) return "—";
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join("/");
      const t = new Date(v);
      return `${pad2(t.getDate())}/${pad2(t.getMonth() + 1)}/${t.getFullYear()}`;
    };
    const fmtDateTime = (v) => { const t = new Date(v); return `${fmtDate(v)} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`; };
    const escapeText = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

    function tile(label, value, cls = "") {
      const div = document.createElement("div");
      div.className = "tile";
      div.innerHTML = `<div class="label">${label}</div><div class="value ${cls}">${value}</div>`;
      return div;
    }

    const fmtPnl = (t) => {
      if (t.pnlUsdt === null || t.pnlUsdt === undefined) return "—";
      const sign = t.pnlUsdt >= 0 ? "+" : "−";
      return `${sign}${fmtUsd(Math.abs(t.pnlUsdt))} (${sign}${Math.abs(t.pnlPct).toFixed(2)}%)`;
    };

    // green up, red down, plain at zero (judged on the 2 decimals shown)
    const pnlClass = (t) => {
      const v = Math.round((t.pnlUsdt ?? 0) * 100);
      return v > 0 ? "pos" : v < 0 ? "neg" : "";
    };

    function renderTiles(t) {
      const el = document.getElementById("tiles");
      el.innerHTML = "";
      el.appendChild(tile("Invested", fmtUsd(t.totalInvestedUsdt)));
      el.appendChild(tile("BTC accumulated", fmtBtc(t.totalBtc)));
      el.appendChild(tile("Average price", t.weightedAvgPrice ? fmtUsd(t.weightedAvgPrice) : "—"));
      el.appendChild(tile("Latest price", t.latestMarketPrice ? fmtUsd(t.latestMarketPrice) : "—"));
      el.appendChild(tile("Revenue", fmtPnl(t), pnlClass(t)));
      el.appendChild(tile("Purchases", t.confirmedCount));
      el.appendChild(tile("Failures", t.failedCount));
      el.appendChild(tile("Total gas", fmtUsd(t.totalGasUsd)));
    }

    function renderBanner(control) {
      const banner = document.getElementById("banner");
      if (control.paused) {
        banner.classList.add("visible");
        const since = control.pausedAt ? fmtDateTime(control.pausedAt) : "unknown date";
        const until = control.pausedUntil ? ` until ${fmtDateTime(control.pausedUntil)}` : "";
        banner.textContent = `⏸ DCA PAUSED since ${since}${until}${control.reason ? " — " + control.reason : ""}`;
      } else {
        banner.classList.remove("visible");
      }
      document.getElementById("control-status").textContent = control.paused ? "Status: paused" : "Status: active";
      document.getElementById("btn-pause").disabled = control.paused;
      document.getElementById("btn-resume").disabled = !control.paused;
    }

    function statusLabel(run) {
      if (run.status === "FAILED" || run.status === "PAUSED") {
        return `<span class="status ${escapeText(run.status)}">${escapeText(run.status)}</span><div class="reason">${escapeText(run.error ?? "")}</div>`;
      }
      return `<span class="status ${escapeText(run.status)}">${escapeText(run.status)}</span>`;
    }

    function dateLabel(run) {
      return run.manualId ? `${escapeText(fmtDate(run.date))} <span class="tag">manual</span>` : escapeText(fmtDate(run.date));
    }

    function renderRows(runs) {
      const tbody = document.getElementById("rows");
      if (runs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty">no records yet</td></tr>`;
        return;
      }
      tbody.innerHTML = runs
        .map((r) => {
          const txLink = r.txHash
            && /^0x[a-fA-F0-9]{64}$/.test(r.txHash) ? `<a href="https://polygonscan.com/tx/${r.txHash}" target="_blank" rel="noopener">${r.txHash.slice(0, 10)}…</a>`
            : "—";
          const usdt = r.amountIn ? (Number(r.amountIn) / 1e6).toFixed(2) : "—";
          const btc = r.amountOut ? (Number(r.amountOut) / 1e8).toFixed(8) : "—";
          const oracle = r.oracleBtcUsd && r.oracleUsdtUsd ? fmtUsd(Number(r.oracleBtcUsd) / Number(r.oracleUsdtUsd)) : "—";
          return `<tr>
            <td>${dateLabel(r)}</td>
            <td>${statusLabel(r)}</td>
            <td>${usdt}</td>
            <td>${btc}</td>
            <td>${r.effectivePrice ? fmtUsd(r.effectivePrice) : "—"}</td>
            <td>${oracle}</td>
            <td>${r.oracleDeviationPct ? escapeText(r.oracleDeviationPct) + "%" : "—"}</td>
            <td>${r.gasCostUsd ? fmtUsd(r.gasCostUsd) : "—"}</td>
            <td>${txLink}</td>
          </tr>`;
        })
        .join("");
    }

    let strategies = [];
    let selected = null;
    let maxRunTotal = "1000";
    let dailyTotal = "0";
    const strategyName = (s) => s.label ?? `#${s.id}`;
    const today = () => new Date().toISOString().slice(0, 10);
    // same rule the server applies to a manual buy: active or paused, not past its end date
    const buyable = (s) => (s.status === "active" || s.status === "paused") && (!s.endDate || s.endDate >= today());
    const buyStatus = document.getElementById("buy-status");
    const btnBuy = document.getElementById("btn-buy");
    let buying = false;

    const menu = document.getElementById("strategy-menu");
    const menuButton = document.getElementById("btn-strategy-menu");
    menu.addEventListener("beforetoggle", (event) => {
      if (event.newState !== "open") return;
      const r = menuButton.getBoundingClientRect();
      menu.style.top = `${r.bottom + scrollY + 4}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, document.documentElement.clientWidth - 198)) + scrollX}px`;
    });
    menu.addEventListener("click", (event) => { if (event.target.closest("button") && menu.matches(":popover-open")) menu.hidePopover(); });

    // F5: one card per strategy, filtered by status (default: active only).
    // F10: home lists the cards; a card opens its own page (#s/<id>).
    const filterBox = document.getElementById("strategy-filter");
    const shownStatuses = () => new Set([...filterBox.querySelectorAll("input:checked")].map((i) => i.value));
    filterBox.addEventListener("change", renderTabs);
    document.getElementById("btn-new-strategy").addEventListener("click", () => openStrategyDialog(null));

    // go to a view; re-render when already there (hashchange wouldn't fire)
    const go = (hash) => { if (location.hash === hash || (hash === "" && location.hash === "#")) load(); else location.hash = hash; };

    function card(s, link) {
      const el = document.createElement(link ? "button" : "div");
      el.className = "card" + (s.status === "active" ? "" : " dim");
      const head = document.createElement("div");
      head.className = "head";
      const name = document.createElement("span");
      name.textContent = strategyName(s);
      const badge = document.createElement("span");
      badge.className = `status ${s.status}`;
      badge.textContent = s.status;
      head.append(name, badge);
      const t = s.tiles;
      // headline: invested (left) and revenue (right), like an exchange's strategy card
      const big = document.createElement("div");
      big.className = "big";
      const sign = (t.pnlUsdt ?? 0) >= 0 ? "+" : "−";
      big.innerHTML = `<div><small>Invested (USDT0)</small><strong>${escapeText(fmt(t.totalInvestedUsdt))}</strong></div>`
        + `<div><small>Revenue (USDT0)</small><strong class="${pnlClass(t)}">${t.pnlUsdt == null ? "—" : sign + escapeText(fmt(Math.abs(t.pnlUsdt)))}</strong>`
        + (t.pnlUsdt == null ? "" : `<span class="${pnlClass(t)}">${sign}${Math.abs(t.pnlPct).toFixed(2)}%</span>`) + `</div>`;
      const list = document.createElement("dl");
      const rows = [
        ["BTC", fmtBtc(t.totalBtc)],
        ["Avg price", t.weightedAvgPrice ? fmtUsd(t.weightedAvgPrice) : "—"],
        ["Per day", `${s.amount} USDT0`],
      ];
      if (s.maxTotal) rows.push(["Max total", `${s.maxTotal} USDT0`]);
      if (s.endDate) rows.push(["Ends", fmtDate(s.endDate)]);
      if (s.stoppedAt) rows.push(["Completed", fmtDate(s.stoppedAt)]);
      for (const [k, v] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        list.append(dt, dd);
      }
      el.append(head, big, list);
      if (link) {
        el.type = "button";
        el.addEventListener("click", () => go(`#s/${s.id}`));
      }
      return el;
    }

    function renderTabs() {
      const s = strategies.find((x) => x.id === selected);
      const cards = document.getElementById("cards");
      // home is just the cards; tiles and history live on each strategy's page
      document.getElementById("strategy-filter").hidden = Boolean(s);
      for (const id of ["strategy-back", "strategy-bar", "strategy-detail"]) document.getElementById(id).hidden = !s;
      if (!s) {
        const visible = strategies.filter((x) => shownStatuses().has(x.status));
        cards.replaceChildren(...visible.map((x) => card(x, true)));
        if (visible.length === 0) {
          const empty = document.createElement("p");
          empty.className = "reason";
          empty.textContent = "No strategies match the filter.";
          cards.appendChild(empty);
        }
        return;
      }
      cards.replaceChildren(card(s, false));
      // one primary action (buy into this strategy), the rest in the "⋯" menu
      document.getElementById("btn-strategy-pause").hidden = s.status !== "active";
      const resume = document.getElementById("btn-strategy-resume");
      resume.hidden = s.status === "active";
      resume.textContent = s.status === "completed" ? "Reactivate" : "Resume strategy";
      document.getElementById("btn-strategy-stop").hidden = s.status === "completed";
      document.getElementById("btn-strategy-delete").hidden = s.status !== "completed";
      btnBuy.hidden = !buyable(s);
      btnBuy.disabled = buying;
      btnBuy.textContent = `Buy ${s.amount} USDT0 now`;
    }

    async function load() {
      const sres = await fetch("/api/strategies");
      if (sres.status === 401) return showLogin();
      if (!sres.ok) throw new Error(`Could not load strategies (${sres.status})`);
      const sdata = await sres.json();
      strategies = sdata.strategies;
      maxRunTotal = sdata.maxRunTotal;
      dailyTotal = sdata.dailyTotal;
      if (selected !== null && !strategies.some((s) => s.id === selected)) return go(""); // deleted or bad link
      renderTabs();
      const res = await fetch(selected === null ? "/api/history" : `/api/history?strategy=${selected}`);
      if (!res.ok) throw new Error(`Could not load history (${res.status})`);
      const data = await res.json();
      renderTiles(data.tiles);
      renderBanner(data.control);
      renderRows(data.runs);
    }

    async function setPaused(paused) {
      const res = await withTotp((totp) => api(paused ? "/api/pause" : "/api/resume", totp ? { totp } : {}));
      if (!res.ok) return strategyError(res);
      load();
    }

    async function watchBuy() {
      const res = await fetch("/api/buy");
      if (!res.ok) return;
      const state = await res.json();
      buying = state.running;
      btnBuy.disabled = buying;
      if (state.running) {
        buyStatus.textContent = `Buying ${state.amount} USDT0... (usually under a minute)`;
        setTimeout(watchBuy, 3000);
      } else if (state.exitCode !== null) {
        buyStatus.textContent = state.exitCode === 0 ? `Manual buy of ${state.amount} USDT0 done -- see the history.` : `Manual buy of ${state.amount} USDT0 failed -- see the history for the reason.`;
        load();
      }
    }

    // F8: a manual buy spends the selected strategy's own amount (the server
    // takes only what's left if that would pass its max total).
    btnBuy.addEventListener("click", async () => {
      const s = strategies.find((x) => x.id === selected);
      if (!s || !buyable(s)) return;
      const strategyId = s.id;
      if (!confirm(`Buy BTC with ${s.amount} USDT0 now, into "${strategyName(s)}"? This sends a real transaction.`)) return;
      const res = await withTotp((totp) => api("/api/buy", totp ? { strategyId, totp } : { strategyId }));
      if (!res.ok) { buyStatus.textContent = (await res.json()).error ?? `error ${res.status}`; return; }
      watchBuy();
    });

    document.getElementById("btn-pause").addEventListener("click", () => setPaused(true));
    document.getElementById("btn-resume").addEventListener("click", () => setPaused(false));

    watchBuy();

// ---------------------------------------------------------------- authenticator (F1a)

async function api(path, body, method = "POST") {
  return fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Dca-App": "1" },
    body: JSON.stringify(body ?? {}),
  });
}

const authMsg = document.getElementById("auth-msg");
let elevationTimer = null;

function renderElevation(elevatedUntil, serverNow) {
  const label = document.getElementById("elevation-label");
  const unlockForm = document.getElementById("form-unlock");
  const lockBtn = document.getElementById("btn-lock");
  const expiresAt = performance.now() + (elevatedUntil ? new Date(elevatedUntil) - new Date(serverNow) : 0);
  clearInterval(elevationTimer);
  const tick = () => {
    const left = elevatedUntil ? Math.ceil((expiresAt - performance.now()) / 60000) : 0;
    const open = left > 0;
    label.textContent = open ? `🔓 Unlocked · ${left} min left` : "🔒 Locked";
    document.getElementById("lock-indicator").textContent = open ? `🔓 ${left} min` : "🔒";
    unlockForm.hidden = open;
    lockBtn.hidden = !open;
    if (!open) clearInterval(elevationTimer);
  };
  tick();
  if (elevatedUntil) elevationTimer = setInterval(tick, 15000);
}

async function loadAuth() {
  const res = await fetch("/api/auth", { cache: "no-store" });
  if (!res.ok) return;
  const state = await res.json();
  document.getElementById("totp-setup").hidden = state.totpEnrolled;
  document.getElementById("totp-ready").hidden = !state.totpEnrolled;
  document.getElementById("lock-indicator").hidden = !state.totpEnrolled;
  document.getElementById("session-label").textContent = state.sessionExpiresAt ? `Logged in until ${fmtDate(state.sessionExpiresAt)}` : "";
  if (state.totpEnrolled) renderElevation(state.elevatedUntil, state.serverNow);
  authMsg.textContent = state.lockedUntil ? `Too many wrong codes -- locked until ${fmtDateTime(state.lockedUntil)}.` : "";
}

async function withTotp(send) {
  let res = await send();
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.totpRequired) {
      const code = prompt("Authenticator code (6 digits):");
      if (!code) return res;
      res = await send(code.trim());
    }
  }
  await loadAuth().catch(() => {}); // status refresh must not hide the action's result
  return res;
}

async function strategyError(res) {
  const body = await res.json().catch(() => ({}));
  alert(body.error ?? `error ${res.status}`);
}

async function patchStrategy(body) {
  const id = selected;
  const res = await withTotp((totp) => api(`/api/strategies/${id}`, totp ? { ...body, totp } : body, "PATCH"));
  if (!res.ok) return strategyError(res);
  load();
}

document.getElementById("btn-strategy-pause").addEventListener("click", () => patchStrategy({ status: "paused" }));
document.getElementById("btn-strategy-resume").addEventListener("click", () => patchStrategy({ status: "active" }));
document.getElementById("btn-strategy-edit").addEventListener("click", () => openStrategyDialog(strategies.find((s) => s.id === selected)));
document.getElementById("btn-strategy-stop").addEventListener("click", () => {
  const s = strategies.find((x) => x.id === selected);
  if (s && confirm(`Complete "${strategyName(s)}"? It stops buying and its history stays; you can reactivate it later.`)) patchStrategy({ status: "completed" });
});
document.getElementById("btn-strategy-delete").addEventListener("click", async () => {
  const s = strategies.find((x) => x.id === selected);
  if (!s) return;
  const name = strategyName(s);
  if (prompt(`This permanently deletes the history of "${name}". Type ${name} to confirm:`) !== name) return;
  const res = await withTotp((totp) => api(`/api/strategies/${s.id}`, totp ? { totp } : {}, "DELETE"));
  if (!res.ok) return strategyError(res);
  go("");
});

const dialog = document.getElementById("strategy-dialog");
let editing = null;

function openStrategyDialog(s) {
  editing = s;
  document.getElementById("strategy-dialog-title").textContent = s ? `Edit ${strategyName(s)}` : "New strategy";
  document.getElementById("sf-label").value = s?.label ?? "";
  const amount = document.getElementById("sf-amount");
  amount.value = s?.amount ?? "";
  const end = document.getElementById("sf-end");
  end.value = s?.endDate ?? "";
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // UTC
  // an unchanged past end date must not block editing other fields; the server refuses any new date before tomorrow
  end.min = end.value && end.value < tomorrow ? end.value : tomorrow;
  document.getElementById("sf-max").value = s?.maxTotal ?? "";
  const room = Number(maxRunTotal) - Number(dailyTotal) + (s?.status === "active" ? Number(s.amount) : 0);
  amount.max = String(Math.max(0, Math.min(Number(maxRunTotal), room)));
  document.getElementById("sf-hint").textContent = `Daily total of active strategies: ${dailyTotal} of ${maxRunTotal} USDT0 per run.`;
  document.getElementById("sf-msg").textContent = "";
  dialog.showModal();
  amount.focus();
}

// click anywhere on the date field opens the calendar, not just the small icon
document.getElementById("sf-end").addEventListener("click", (event) => {
  try { event.target.showPicker(); } catch { /* older browsers: the icon still opens it */ }
});
document.getElementById("sf-cancel").addEventListener("click", () => dialog.close());
document.getElementById("strategy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  const body = {
    label: document.getElementById("sf-label").value,
    amount: document.getElementById("sf-amount").value.trim(),
    endDate: document.getElementById("sf-end").value || null,
    maxTotal: document.getElementById("sf-max").value.trim() || null,
  };
  if (editing && body.endDate === editing.endDate) delete body.endDate;
  const res = await withTotp((totp) => editing
    ? api(`/api/strategies/${editing.id}`, totp ? { ...body, totp } : body, "PATCH")
    : api("/api/strategies", totp ? { ...body, totp } : body));
  if (!res.ok) {
    const response = await res.json().catch(() => ({}));
    document.getElementById("sf-msg").textContent = response.error ?? `error ${res.status}`;
    return;
  }
  const saved = await res.json();
  dialog.close();
  go(`#s/${saved.id}`);
});

async function showError(res) {
  const body = await res.json().catch(() => ({}));
  authMsg.textContent = body.error ?? `error ${res.status}`;
}

document.getElementById("btn-totp-setup").addEventListener("click", async () => {
  const res = await api("/api/totp/setup");
  if (!res.ok) return showError(res);
  const { secret, uri } = await res.json();
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  document.getElementById("totp-qr").innerHTML = qr.createSvgTag(4, 2);
  document.getElementById("totp-secret").textContent = secret.replace(/(.{4})/g, "$1 ").trim();
  document.getElementById("totp-enrol").hidden = false;
  document.getElementById("btn-totp-setup").hidden = true;
});

document.getElementById("form-totp-confirm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  const res = await api("/api/totp/confirm", { totp: document.getElementById("totp-confirm-code").value.trim() });
  if (!res.ok) return showError(res);
  document.getElementById("totp-qr").innerHTML = "";
  document.getElementById("totp-secret").textContent = "";
  authMsg.textContent = "Authenticator set up.";
  loadAuth();
});

document.getElementById("form-unlock").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  const input = document.getElementById("unlock-code");
  const res = await api("/api/unlock", { totp: input.value.trim() });
  input.value = "";
  if (!res.ok) return showError(res);
  loadAuth();
});

document.getElementById("btn-lock").addEventListener("click", async () => {
  await api("/api/lock");
  loadAuth();
});

loadAuth();

// ---------------------------------------------------------------- login (F6)

function showLogin() {
  document.getElementById("app").hidden = true;
  document.getElementById("top-actions").hidden = true;
  document.getElementById("login-form").hidden = false;
  document.getElementById("login-password").focus();
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  const code = document.getElementById("login-code");
  const res = await api("/api/login", { password: document.getElementById("login-password").value, totp: code.value.trim() || undefined });
  code.value = "";
  if (res.ok) return location.reload();
  const body = await res.json().catch(() => ({}));
  document.getElementById("login-msg").textContent = body.totpRequired ? "Enter the 6-digit code from your authenticator." : body.error ?? `error ${res.status}`;
  (body.totpRequired ? code : document.getElementById("login-password")).focus();
});

for (const [id, path, question] of [["btn-logout", "/api/logout", null], ["btn-logout-all", "/api/logout-all", "Log out on every device?"]]) {
  document.getElementById(id).addEventListener("click", async () => {
    if (question && !confirm(question)) return;
    await api(path);
    location.reload();
  });
}

// ---------------------------------------------------------------- wallet health (F7)

// F10: one summary line (worst status + nearest "runs out"); the details open
// on their own only when something needs attention.
const HEALTH_RANK = { ok: 0, warning: 1, critical: 2 };

async function loadHealth() {
  const el = document.getElementById("health");
  const summary = document.getElementById("health-summary");
  const box = document.getElementById("health-box");
  const res = await fetch("/api/balance").catch(() => null);
  const b = res?.ok ? await res.json() : { available: false };
  if (!b.available) {
    summary.innerHTML = `<span class="warning"><span class="dot" aria-hidden="true"></span>Wallet health unavailable</span>`;
    el.innerHTML = `<span class="reason">Balances unavailable right now (RPC unreachable or not configured).</span>`;
    box.open = true;
    return;
  }
  const h = b.health;
  const covers = (item) => item.runwayDays === null ? "" : ` · covers ${item.runwayDays} day${item.runwayDays === 1 ? "" : "s"}${item.runsOutOn ? ` (runs out ${fmtDateTime(item.runsOutOn)})` : ""}`;
  const allowance = Number(b.allowance) > 1e12 ? "unlimited" : `${fmt(b.allowance)} USDT0`;
  const rows = [
    [h.tokenIn.status, `USDT0: ${fmt(b.tokenIn)} for ${fmt(b.dailyNeed)}/day${covers(h.tokenIn)}`],
    [h.gas.status, `POL (gas): ${fmt(b.pol, 4)}${b.avgGasPol ? ` · ~${fmt(b.avgGasPol, 4)} per run` : ""}${covers(h.gas)}${h.gas.status === "critical" ? ` · below the ${b.minPol} POL minimum` : ""}`],
    [h.allowance.status, `Allowance to Permit2: ${allowance}${h.allowance.status === "warning" ? " · the next run approves again (extra gas)" : ""}`],
  ];
  el.innerHTML = rows.map(([status, text]) => `<div class="${escapeText(status)}"><span class="dot" aria-hidden="true"></span>${escapeText(text)} <span class="reason">(${escapeText(status)})</span></div>`).join("")
    + `<span class="reason">read ${fmtDateTime(b.readAt)}</span>`;
  const worst = [h.tokenIn, h.gas, h.allowance].reduce((w, item) => (HEALTH_RANK[item.status] > HEALTH_RANK[w] ? item.status : w), "ok");
  const runsOut = [h.tokenIn.runsOutOn, h.gas.runsOutOn].filter(Boolean).sort()[0]; // same ISO format, so string order = time order
  summary.innerHTML = `<span class="${escapeText(worst)}"><span class="dot" aria-hidden="true"></span>Wallet ${worst === "ok" ? "ok" : escapeText(worst)}</span>`
    + (runsOut ? ` <span class="reason">· runs out ${fmtDateTime(runsOut)}</span>` : "");
  box.open = worst !== "ok";
}

loadHealth();

// ---------------------------------------------------------------- settings (F1c)

const SETTING_KEYS = ["maxSlippagePct", "maxPriceImpactPct", "maxOracleDeviationPct", "approvalDays", "minPolBalance"];

function renderWalletAddress(value) {
  const address = typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;
  document.getElementById("wallet-address").textContent = address ?? "not set";
  const link = document.getElementById("wallet-link");
  link.hidden = !address;
  if (address) link.href = `https://polygonscan.com/address/${address}`;
  else link.removeAttribute("href");
  return address;
}

async function loadSettingsPanel() {
  const res = await fetch("/api/settings");
  if (!res.ok) return;
  const data = await res.json();
  const { settings, caps, setupIssues } = data;
  renderWalletAddress(data.walletAddress);
  // Caps come from the server (validation.ts) -- the browser enforces them natively.
  for (const key of SETTING_KEYS) {
    const input = document.getElementById(`st-${key}`);
    input.min = caps[key].min;
    input.max = caps[key].max;
    input.step = caps[key].step;
    if (settings) input.value = settings[key];
  }
  document.getElementById("report-mode").value = data.reportMode;
  document.getElementById("alert-days").value = data.alertDays;
  document.getElementById("report-note").textContent = data.reportConfigured ? "" : "Email is not configured on the server (Resend key and recipient), so nothing is sent either way.";
  const banner = document.getElementById("setup-banner");
  banner.classList.toggle("visible", setupIssues.length > 0);
  banner.textContent = setupIssues.length ? `Setup incomplete -- the bot won't buy until fixed: ${setupIssues.join("; ")}.` : "";
}

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  const body = { runTime: "00:00" }; // fixed: the scheduled run is always 00:00 UTC, not editable in the app
  for (const key of SETTING_KEYS) body[key] = Number(document.getElementById(`st-${key}`).value);
  const res = await withTotp((totp) => api("/api/settings", totp ? { ...body, totp } : body));
  const msg = document.getElementById("st-msg");
  if (!res.ok) {
    msg.textContent = (await res.json().catch(() => ({}))).error ?? `error ${res.status}`;
    return;
  }
  msg.textContent = "Saved.";
  loadSettingsPanel();
});

document.getElementById("report-mode").addEventListener("change", async (event) => {
  const mode = event.target.value;
  const msg = document.getElementById("report-msg");
  const res = await api("/api/report", { mode });
  msg.textContent = res.ok ? "Saved." : (await res.json().catch(() => ({}))).error ?? `error ${res.status}`;
  loadSettingsPanel(); // re-read the stored value: a refused change snaps the select back
});

document.getElementById("alert-days").addEventListener("change", async (event) => {
  const msg = document.getElementById("report-msg");
  if (!event.target.reportValidity()) return;
  const res = await api("/api/report", { alertDays: Number(event.target.value) });
  msg.textContent = res.ok ? "Saved." : (await res.json().catch(() => ({}))).error ?? `error ${res.status}`;
  loadSettingsPanel();
});

document.getElementById("key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("key-input");
  let privateKey = input.value.trim();
  input.value = "";
  if (!confirm("Replace the DCA wallet's key? Purchases will come from the new address from now on.")) {
    privateKey = "";
    return;
  }

  const msg = document.getElementById("key-msg");
  msg.textContent = "Replacing key…";
  try {
    const res = await withTotp((totp) => api("/api/key", totp ? { privateKey, totp } : { privateKey }));
    privateKey = "";
    if (!res.ok) {
      msg.textContent = res.status === 400 ? "Invalid private key. Use 0x followed by 64 hex characters."
        : res.status === 403 ? "Unlock with your authenticator and try again."
        : res.status === 409 ? "A purchase is in progress. Try again after it finishes."
        : `Key replacement failed (${res.status}).`;
      return;
    }
    const { walletAddress } = await res.json();
    const address = renderWalletAddress(walletAddress);
    msg.textContent = address ? `Key replaced. New address: ${address}` : "Key replaced, but the address could not be displayed. Refresh the page.";
    loadSettingsPanel();
    loadHealth();
  } catch {
    msg.textContent = "Key replacement failed. Check your connection and try again.";
  } finally {
    privateKey = "";
  }
});

loadSettingsPanel();

// ---------------------------------------------------------------- views (F10)
// Hash routes, no reload, browser back works: "" home (cards + all history),
// #s/<id> one strategy's page, #settings the admin panels. Banners sit outside.
// #settings opens a modal over whatever page was showing; closing it (✕, Esc)
// swaps the #settings history entry back to that page.
const settingsDialog = document.getElementById("view-settings");
let pageHash = "";
const syncView = () => {
  if (location.hash === "#settings") {
    if (!settingsDialog.open) settingsDialog.showModal();
    load();
    return;
  }
  if (settingsDialog.open) settingsDialog.close();
  pageHash = location.hash;
  const m = /^#s\/(\d+)$/.exec(location.hash);
  selected = m ? Number(m[1]) : null;
  load();
  scrollTo(0, 0);
};
settingsDialog.addEventListener("close", () => { if (location.hash === "#settings") location.replace(pageHash || "#"); });
document.getElementById("settings-close").addEventListener("click", () => settingsDialog.close());
window.addEventListener("hashchange", syncView);
syncView();

// ---------------------------------------------------------------- PWA (F11)
// The worker caches the static shell only (sw.js); data always comes from the
// server, so offline the page shows this banner instead of looking live.
const offlineBanner = document.getElementById("offline-banner");
const syncOffline = () => offlineBanner.classList.toggle("visible", !navigator.onLine);
window.addEventListener("online", syncOffline);
window.addEventListener("offline", syncOffline);
syncOffline();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
