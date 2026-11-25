'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  let state = {
    accounts: [],
    activeAccountId: null,
    license: { tier: 'free', valid: false, maxAccounts: 1 },
    empiricalPnls: [],
  };

  function showBox(el, msg, kind) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'status-box ' + (kind || '');
    el.hidden = false;
  }

  async function apiJson(url, options) {
    const res = await fetch(url, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      const errMsg = (data && (data.message || data.error)) || `Request failed (${res.status})`;
      const err = new Error(errMsg);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  function activeAccount() {
    return state.accounts.find((a) => a.id === state.activeAccountId) || state.accounts[0] || null;
  }

  function renderLicenseBadge() {
    const badge = $('badge-license');
    const lic = state.license || { tier: 'free', maxAccounts: 1 };
    if (lic.tier === 'team') {
      badge.textContent = 'Pro Team (Unlimited Accounts)';
      badge.className = 'pill';
    } else if (lic.tier === 'solo') {
      badge.textContent = `Pro Solo (${lic.maxAccounts || 20} Accounts)`;
      badge.className = 'pill';
    } else {
      badge.textContent = 'MIT Free (1 Account)';
      badge.className = 'pill warn';
    }
  }

  function renderAccountsDropdown() {
    const sel = $('account-select');
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (const acc of state.accounts) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = `${acc.name} (${acc.drawdownMode} — $${Math.round(acc.realizedBalance).toLocaleString()})`;
      sel.appendChild(opt);
    }
    const current = activeAccount();
    if (current) {
      state.activeAccountId = current.id;
      sel.value = current.id;
      $('edit-balance').value = String(current.realizedBalance);
      $('edit-unrealized').value = String(current.openUnrealizedPnl);
      $('edit-hwm').value = String(current.hwm);
      $('edit-day-pnl').value = String(current.dayRealizedPnl);
      $('mc-target').value = String(current.profitTarget || 3000);
      $('export-csv-link').href = `/api/journal/export.csv?accountId=${encodeURIComponent(current.id)}`;
    }
  }

  function renderTradesTable(trades) {
    const tbody = $('trades-tbody');
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    if (!trades || trades.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'No paired trades logged yet. Import a broker CSV above.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const t of trades) {
      const tr = document.createElement('tr');
      const cells = [
        t.symbol,
        t.side,
        String(t.qty),
        Number(t.entryPrice).toFixed(2),
        Number(t.exitPrice).toFixed(2),
        (t.netPnlUsd >= 0 ? '+$' : '-$') + Math.abs(Number(t.netPnlUsd)).toFixed(2),
        t.ruleAdherent ? 'PASS' : (t.violationReason || 'VIOLATION'),
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  async function refreshAccountsAndSelect(preferredId) {
    const data = await apiJson('/api/accounts');
    state.accounts = data.accounts || [];
    state.license = data.license || state.license;
    if (preferredId && state.accounts.some((a) => a.id === preferredId)) {
      state.activeAccountId = preferredId;
    } else if (!state.accounts.some((a) => a.id === state.activeAccountId)) {
      state.activeAccountId = state.accounts[0] ? state.accounts[0].id : null;
    }
    renderLicenseBadge();
    renderAccountsDropdown();
  }

  async function runRiskCheck() {
    const acc = activeAccount();
    if (!acc) return;
    const consecRaw = $('risk-consec-losses').value.trim();
    const payload = {
      accountId: acc.id,
      symbol: $('risk-symbol').value,
      userStopTicks: Math.max(1, Number($('risk-stop-ticks').value || 10)),
      atr14: Math.max(0, Number($('risk-atr').value || 0)),
      sessionFilter: {
        skipGlobexCheck: true,
        ...(consecRaw !== '' ? { consecutiveLossesToday: Math.max(0, Number(consecRaw)) } : {}),
      },
    };
    const { result } = await apiJson('/api/risk/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    $('out-regime').textContent = result.status;
    $('out-floor').textContent = `$${Math.round(result.floor).toLocaleString()} / $${Math.round(result.effectiveHwm).toLocaleString()}`;
    $('out-buffer').textContent = `$${Math.round(result.remainingBuffer).toLocaleString()}`;
    $('out-contracts').textContent = `${result.maxContractsAllowed} ${result.symbol}`;
    $('out-micro').textContent = result.microFallbackSymbol
      ? `${result.microFallbackContracts} ${result.microFallbackSymbol}`
      : 'Within Cap';
    $('out-session').textContent = `${result.session.sessionQualityScore}/100 (${result.session.sessionAction})`;

    const box = $('risk-advisory');
    const details = (result.session.details && result.session.details.length)
      ? result.session.details.join(' | ')
      : `Stop ${result.stopTicksEffective} ticks ($${result.lossPerContract}/contract). Consistency ${(result.consistencyRatio * 100).toFixed(0)}%.`;
    const kind = result.status === 'RED_LOCKOUT' ? 'error' : result.status === 'AMBER_CAUTION' ? 'warn' : 'ok';
    showBox(box, `${result.status}: ${details}`, kind);
  }

  async function refreshJournal() {
    const acc = activeAccount();
    if (!acc) return;
    const [rep, tr] = await Promise.all([
      apiJson(`/api/journal/report?accountId=${encodeURIComponent(acc.id)}`),
      apiJson(`/api/journal/trades?accountId=${encodeURIComponent(acc.id)}`),
    ]);
    const sc = rep.scorecard;
    state.empiricalPnls = Array.isArray(sc.empiricalNetPnls) ? sc.empiricalNetPnls : [];
    $('sc-trades').textContent = String(sc.totalTrades);
    $('sc-winrate').textContent = `${sc.winRatePct}%`;
    $('sc-netpnl').textContent = (sc.netPnlUsd >= 0 ? '+$' : '-$') + Math.abs(sc.netPnlUsd).toFixed(2);
    $('sc-adherence').textContent = `${sc.ruleAdherencePct}%`;
    $('sc-tilt').textContent = `$${Number(sc.tiltLeakageUsd).toFixed(2)}`;
    renderTradesTable(tr.trades || []);
  }

  function runMonteCarlo() {
    const acc = activeAccount();
    const ddMax = acc ? acc.maxDrawdown : 2000;
    const target = Math.max(250, Number($('mc-target').value || 3000));
    const winRate = Math.min(90, Math.max(10, Number($('mc-winrate').value || 48))) / 100;
    const rr = Math.min(10, Math.max(0.5, Number($('mc-rr').value || 1.6)));
    const risk = Math.max(25, Number($('mc-risk-trade').value || 250));
    const emp = state.empiricalPnls.length >= 5 ? state.empiricalPnls : null;

    let seed = 0x9e3779b9;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const runs = 10000;
    let passed = 0;
    let ruined = 0;
    const lengths = [];
    const buckets = [0, 0, 0, 0, 0];

    for (let i = 0; i < runs; i += 1) {
      let eq = 0;
      let peak = 0;
      let t = 0;
      while (t < 250) {
        t += 1;
        const stepPnl = emp
          ? emp[Math.floor(nextRand() * emp.length)]
          : (nextRand() < winRate ? risk * rr : -risk);
        eq += stepPnl;
        if (eq > peak) peak = eq;
        if (eq >= target) {
          passed += 1;
          lengths.push(t);
          buckets[Math.min(4, Math.floor(t / 50))] += 1;
          break;
        }
        if (eq <= peak - ddMax) {
          ruined += 1;
          lengths.push(t);
          break;
        }
      }
      if (t >= 250) lengths.push(250);
    }

    lengths.sort((a, b) => a - b);
    $('mc-pass-pct').textContent = `${((passed / runs) * 100).toFixed(1)}%`;
    $('mc-ruin-pct').textContent = `${((ruined / runs) * 100).toFixed(1)}%`;
    $('mc-median-trades').textContent = String(lengths[Math.floor(lengths.length / 2)] || 0);

    const svg = $('mc-hist-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const maxB = Math.max(1, ...buckets);
    const labels = ['<50 tr', '50-99', '100-149', '150-199', '200+'];
    buckets.forEach((cnt, idx) => {
      const x = 35 + idx * 76;
      const h = Math.max(6, Math.round((cnt / maxB) * 85));
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(110 - h));
      rect.setAttribute('width', '46');
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', '#10b981');
      svg.appendChild(rect);

      const txt = document.createElementNS(ns, 'text');
      txt.setAttribute('x', String(x + 23));
      txt.setAttribute('y', '128');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('fill', '#cbd5e1');
      txt.setAttribute('font-size', '10');
      txt.textContent = labels[idx];
      svg.appendChild(txt);
    });
  }

  async function init() {
    try {
      await refreshAccountsAndSelect();
      await runRiskCheck();
      await refreshJournal();
      runMonteCarlo();
    } catch (err) {
      showBox($('account-status'), err?.message || String(err), 'error');
    }
  }

  $('account-select').addEventListener('change', async () => {
    state.activeAccountId = $('account-select').value;
    renderAccountsDropdown();
    try {
      await runRiskCheck();
      await refreshJournal();
      runMonteCarlo();
    } catch (err) {
      showBox($('account-status'), err?.message || String(err), 'error');
    }
  });

  $('create-acc-btn').addEventListener('click', async () => {
    const statusEl = $('account-status');
    const maxAcc = state.license && state.license.maxAccounts;
    if (typeof maxAcc === 'number' && state.accounts.length >= maxAcc) {
      showBox(
        statusEl,
        `Active ${state.license.tier} license allows ${maxAcc} account(s). Activate a Pro Solo (29 USDC) or Team (99 USDC) token below to add more.`,
        'error'
      );
      return;
    }
    try {
      const name = $('new-acc-name').value.trim() || 'Prop Eval Account';
      const presetId = $('new-acc-preset').value;
      const { account } = await apiJson('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, presetId }),
      });
      await refreshAccountsAndSelect(account.id);
      await runRiskCheck();
      await refreshJournal();
      showBox(statusEl, `Created account "${account.name}" (${account.drawdownMode}).`, 'ok');
    } catch (err) {
      showBox(statusEl, err?.message || String(err), 'error');
    }
  });

  $('save-acc-btn').addEventListener('click', async () => {
    const acc = activeAccount();
    if (!acc) return;
    const statusEl = $('account-status');
    try {
      await apiJson(`/api/accounts/${encodeURIComponent(acc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          realizedBalance: Number($('edit-balance').value),
          openUnrealizedPnl: Number($('edit-unrealized').value),
          hwm: Number($('edit-hwm').value),
          dayRealizedPnl: Number($('edit-day-pnl').value),
        }),
      });
      await refreshAccountsAndSelect(acc.id);
      await runRiskCheck();
      showBox(statusEl, 'Account equity snapshot updated.', 'ok');
    } catch (err) {
      showBox(statusEl, err?.message || String(err), 'error');
    }
  });

  $('run-risk-btn').addEventListener('click', () => {
    runRiskCheck().catch((err) => showBox($('risk-advisory'), err?.message || String(err), 'error'));
  });

  $('csv-file-input').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    $('csv-text-input').value = await file.text();
  });

  $('import-csv-btn').addEventListener('click', async () => {
    const acc = activeAccount();
    if (!acc) return;
    const statusEl = $('journal-status');
    const csvText = $('csv-text-input').value.trim();
    if (!csvText) {
      showBox(statusEl, 'Paste or select a broker CSV file first.', 'error');
      return;
    }
    try {
      const out = await apiJson('/api/journal/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: acc.id,
          format: $('csv-format').value,
          csvText,
        }),
      });
      await refreshAccountsAndSelect(acc.id);
      await runRiskCheck();
      await refreshJournal();
      showBox(
        statusEl,
        `Imported ${out.importedExecutions} row(s) (${out.skippedDuplicates} duplicates skipped) via ${out.formatUsed}. Paired ${out.pairedTradesCount} trade(s).`,
        'ok'
      );
    } catch (err) {
      showBox(statusEl, err?.message || String(err), 'error');
    }
  });

  $('refresh-journal-btn').addEventListener('click', () => {
    refreshJournal().catch((err) => showBox($('journal-status'), err?.message || String(err), 'error'));
  });

  $('mc-run-btn').addEventListener('click', runMonteCarlo);

  $('activate-license-btn').addEventListener('click', async () => {
    const statusEl = $('license-status');
    const token = $('license-token-input').value.trim();
    if (!token) {
      showBox(statusEl, 'Enter an EVALSHIELD-PRO-v1 token.', 'error');
      return;
    }
    try {
      const { license } = await apiJson('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      state.license = license;
      renderLicenseBadge();
      showBox(
        statusEl,
        `Activated tier=${license.tier} (maxAccounts=${license.maxAccounts === null ? 'unlimited' : license.maxAccounts}).`,
        'ok'
      );
    } catch (err) {
      showBox(statusEl, err?.message || String(err), 'error');
    }
  });

  init();
})();
