'use strict';

(function () {
  const BASE_CHAIN_ID_HEX = '0x2105';
  const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const TREASURY_ADDRESS = '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206';
  const TIER_ATOMIC = { team: 99_000_000n, enterprise: 499_000_000n };
  const TIER_LABEL = { team: '99 USDC', enterprise: '499 USDC' };

  const CME = {
    ES: { tickSize: 0.25, tickValue: 12.5, micro: 'MES', fee: 4.5 },
    MES: { tickSize: 0.25, tickValue: 1.25, micro: null, fee: 1.24 },
    NQ: { tickSize: 0.25, tickValue: 5.0, micro: 'MNQ', fee: 4.5 },
    MNQ: { tickSize: 0.25, tickValue: 0.5, micro: null, fee: 1.24 },
    GC: { tickSize: 0.1, tickValue: 10.0, micro: 'MGC', fee: 4.8 },
    MGC: { tickSize: 0.1, tickValue: 1.0, micro: null, fee: 1.4 },
    XAUUSD: { tickSize: 0.01, tickValue: 1.0, micro: null, fee: 7.0 },
    EURUSD: { tickSize: 0.0001, tickValue: 10.0, micro: null, fee: 7.0 },
    'BTC-PERP': { tickSize: 1.0, tickValue: 1.0, micro: null, fee: 9.0 },
    'ETH-PERP': { tickSize: 0.1, tickValue: 0.1, micro: null, fee: 3.0 },
    'SOL-PERP': { tickSize: 0.01, tickValue: 0.01, micro: null, fee: 0.2 },
    CL: { tickSize: 0.01, tickValue: 10.0, micro: 'MCL', fee: 4.8 },
    MCL: { tickSize: 0.01, tickValue: 1.0, micro: null, fee: 1.4 },
  };

  const PRESETS = {
    topstep50k: { mode: 'EOD_TRAILING', balance: 50800, hwm: 51200, ddMax: 2000, dll: 1000, dayPnl: -250 },
    apex50k: { mode: 'INTRADAY_TRAILING', balance: 51100, hwm: 51800, ddMax: 2500, dll: 999999, dayPnl: -150 },
    mffu50k: { mode: 'EOD_TRAILING', balance: 50400, hwm: 50600, ddMax: 2000, dll: 999999, dayPnl: 200 },
    ftmo100k: { mode: 'STATIC', balance: 101200, hwm: 101200, ddMax: 10000, dll: 5000, dayPnl: 400 },
    tradeify50k: { mode: 'EOD_TRAILING', balance: 50900, hwm: 51000, ddMax: 2000, dll: 999999, dayPnl: 300 },
  };

  const $ = (id) => document.getElementById(id);

  function showBox(el, msg, kind) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'status-box ' + (kind || '');
    el.hidden = false;
  }

  function calcContracts(spec, stopTicks, atrPoints, riskBudget, spreadTicks) {
    const atrTicks = Math.ceil(atrPoints / spec.tickSize);
    const effectiveStop = Math.max(stopTicks, atrTicks);
    const lossPerContract = effectiveStop * spec.tickValue + spec.fee + (1 + spreadTicks) * spec.tickValue;
    if (lossPerContract <= 0 || riskBudget <= 0) return 0;
    return Math.min(15, Math.floor(riskBudget / lossPerContract));
  }

  function recomputeShield() {
    const mode = $('inp-mode').value;
    const balance = Number($('inp-balance').value || 50000);
    const hwm = Math.max(balance, Number($('inp-hwm').value || balance));
    const ddMax = Math.max(100, Number($('inp-dd-max').value || 2000));
    const dll = Math.max(100, Number($('inp-dll').value || 1000));
    const dayPnl = Number($('inp-day-pnl').value || 0);
    const symbol = $('inp-symbol').value;
    const stopTicks = Math.max(1, Number($('inp-stop-ticks').value || 20));
    const spreadTicks = Math.max(0, Number($('inp-spread-ticks')?.value || 0));
    const atr = Math.max(0, Number($('inp-atr').value || 0));
    const consecLosses = Math.max(0, Number($('inp-losses').value || 0));

    const floor = mode === 'STATIC' ? Math.max(0, (balance >= 90000 ? 100000 : 50000) - ddMax) : hwm - ddMax;
    const ddBuffer = Math.max(0, balance - floor);
    const softDllRemaining = Math.max(0, 0.8 * dll + dayPnl);
    const remainingBuffer = Math.max(0, Math.min(ddBuffer, softDllRemaining));

    const runwayBudget = remainingBuffer / 4;
    const spec = CME[symbol] || CME.MES;
    let maxContracts = calcContracts(spec, stopTicks, atr, runwayBudget, spreadTicks);
    const microCap = spec.micro ? calcContracts(CME[spec.micro], stopTicks, atr, runwayBudget, spreadTicks) : 0;

    let score = 100;
    if (remainingBuffer < 0.35 * ddMax) score -= 30;
    if (consecLosses >= 3) score -= 25;
    if (consecLosses >= 3 || remainingBuffer <= 0.2 * ddMax) {
      maxContracts = 0;
    }
    score = Math.max(0, score);
    const regime = score >= 70 ? 'GO' : score >= 40 ? 'REDUCED_SIZE' : 'STAND_DOWN';

    $('out-floor').textContent = '$' + Math.round(floor).toLocaleString();
    $('out-buffer').textContent = '$' + Math.round(remainingBuffer).toLocaleString();
    $('out-contracts').textContent = String(maxContracts) + ' ' + symbol;
    $('out-micro').textContent = spec.micro ? `${microCap} ${spec.micro}` : 'Native Micro';
    $('out-quality').textContent = `${score} / ${regime}`;

    const adv = $('out-advisory');
    if (consecLosses >= 3) {
      showBox(adv, `TILT_COOLDOWN_ACTIVE (${consecLosses} consecutive losses) — Advisory size set to 0 until cooldown completes.`, 'error');
    } else if (maxContracts === 0 && spec.micro && microCap > 0) {
      showBox(adv, `Full-size ${symbol} exceeds 4-loss runway; downsize to <= ${microCap} ${spec.micro} micro contracts.`, '');
    } else {
      showBox(adv, `Status ${regime}: Effective stop ${Math.max(stopTicks, Math.ceil(atr / spec.tickSize))} ticks on ${symbol}. Safe buffer $${Math.round(remainingBuffer)}.`, 'ok');
    }
  }

  function runMonteCarlo() {
    const winRate = Math.min(90, Math.max(10, Number($('mc-winrate').value || 48))) / 100;
    const rr = Math.min(10, Math.max(0.5, Number($('mc-rr').value || 1.6)));
    const risk = Math.max(25, Number($('mc-risk-trade').value || 250));
    const target = Math.max(500, Number($('mc-target').value || 3000));
    const ddMax = Math.max(100, Number($('inp-dd-max').value || 2000));

    let seed = 0x9e3779b9;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const runs = 25000;
    let passed = 0;
    let ruined = 0;
    const tradeCounts = [];
    const buckets = [0, 0, 0, 0, 0];

    for (let i = 0; i < runs; i += 1) {
      let eq = 0;
      let peak = 0;
      let t = 0;
      while (t < 250) {
        t += 1;
        eq += nextRand() < winRate ? risk * rr : -risk;
        if (eq > peak) peak = eq;
        if (eq >= target) {
          passed += 1;
          tradeCounts.push(t);
          buckets[Math.min(4, Math.floor(t / 50))] += 1;
          break;
        }
        if (eq <= peak - ddMax) {
          ruined += 1;
          tradeCounts.push(t);
          break;
        }
      }
      if (t >= 250) tradeCounts.push(250);
    }

    tradeCounts.sort((a, b) => a - b);
    const median = tradeCounts[Math.floor(tradeCounts.length / 2)] || 0;
    $('mc-pass-pct').textContent = ((passed / runs) * 100).toFixed(1) + '%';
    $('mc-ruin-pct').textContent = ((ruined / runs) * 100).toFixed(1) + '%';
    $('mc-median-trades').textContent = String(median);

    const svg = $('mc-hist-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const maxB = Math.max(1, ...buckets);
    const labels = ['<50 tr', '50-99', '100-149', '150-199', '200+'];
    buckets.forEach((cnt, idx) => {
      const x = 35 + idx * 76;
      const h = Math.max(6, Math.round((cnt / maxB) * 85));
      const y = 110 - h;
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '46');
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', '#10b981');
      svg.appendChild(rect);

      const lbl = document.createElementNS(ns, 'text');
      lbl.setAttribute('x', String(x + 23));
      lbl.setAttribute('y', '128');
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('fill', '#cbd5e1');
      lbl.setAttribute('font-size', '10');
      lbl.textContent = labels[idx];
      svg.appendChild(lbl);
    });
  }

  function updateWalletLabel() {
    const tier = TIER_LABEL[$('tier-select').value] ? $('tier-select').value : 'team';
    const hasWallet = typeof window.ethereum !== 'undefined';
    $('wallet-pay-btn').textContent = hasWallet
      ? `Pay ${TIER_LABEL[tier]} with Base Wallet`
      : `Pay ${TIER_LABEL[tier]} (Manual / Safe Instructions)`;
    if ($('pay-amount-label')) {
      $('pay-amount-label').textContent = TIER_LABEL[tier];
    }
  }

  function encodeErc20Transfer(to, atomic) {
    return '0xa9059cbb' + to.toLowerCase().replace(/^0x/, '').padStart(64, '0') + BigInt(atomic).toString(16).padStart(64, '0');
  }

  async function requestChallenge(txHash, tier) {
    const chRes = await fetch('/api/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash, tier }),
    });
    let ch = null;
    try { ch = await chRes.json(); } catch { ch = null; }
    if (!chRes.ok || !ch || !ch.nonce) {
      throw new Error((ch && (ch.message || ch.error)) || `Challenge failed (${chRes.status})`);
    }
    if ($('manual-challenge-box')) $('manual-challenge-box').hidden = false;
    if ($('manual-challenge-msg')) $('manual-challenge-msg').textContent = ch.message;
    if ($('manual-nonce-input')) $('manual-nonce-input').value = ch.nonce;
    return ch;
  }

  async function submitVerify(txHash, nonce, sig, tier) {
    const statusEl = $('checkout-status');
    const resultEl = $('checkout-result');
    const vRes = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash, nonce, signature: sig, tier }),
    });
    let out = null;
    try { out = await vRes.json(); } catch { out = null; }
    if (!vRes.ok || !out || !out.ok) {
      throw new Error((out && (out.message || out.error)) || `Verification failed (${vRes.status})`);
    }

    showBox(statusEl, 'Base USDC verified! Entitlement issued.', 'ok');
    $('activation-cmd').textContent = out.activationCommand;
    $('license-token-text').textContent = out.licenseToken;
    $('download-bundle-link').href = out.downloadUrl;
    stateCert = { tier: out.tier, txHash: out.txHash, payer: out.payer, token: out.licenseToken };
    rebuildCommercialCert();
    resultEl.hidden = false;
  }

  async function verifyAndClaim(txHash, tier, opts) {
    const statusEl = $('checkout-status');
    const resultEl = $('checkout-result');
    resultEl.hidden = true;
    $('license-token-text').textContent = '';

    try {
      const manualNonce = opts?.forceChallenge ? '' : ($('manual-nonce-input')?.value || '').trim();
      const manualSig = opts?.forceChallenge ? '' : ($('manual-sig-input')?.value || '').trim();
      if (manualNonce && manualSig) {
        showBox(statusEl, 'Verifying Base USDC settlement & manual signature...', '');
        await submitVerify(txHash, manualNonce, manualSig, tier);
        return;
      }

      showBox(statusEl, 'Requesting EIP-191 / ERC-1271 ownership challenge...', '');
      const ch = await requestChallenge(txHash, tier);
      if (typeof window.ethereum === 'undefined') {
        showBox(
          statusEl,
          'Challenge generated below. Sign the challenge message in your Safe, Ledger, or mobile wallet, paste the 0x signature into "Wallet / Safe Signature", and click Sign & Verify Claim.',
          'warn'
        );
        $('manual-sig-input')?.focus();
        return;
      }

      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const sig = await window.ethereum.request({ method: 'personal_sign', params: [ch.message, accounts[0]] });
      if ($('manual-sig-input')) $('manual-sig-input').value = sig;
      await submitVerify(txHash, ch.nonce, sig, tier);
    } catch (err) {
      showBox(statusEl, err?.message || String(err), 'error');
    }
  }

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = PRESETS[btn.getAttribute('data-preset')];
      if (!p) return;
      $('inp-mode').value = p.mode;
      $('inp-balance').value = String(p.balance);
      $('inp-hwm').value = String(p.hwm);
      $('inp-dd-max').value = String(p.ddMax);
      $('inp-dll').value = String(p.dll);
      $('inp-day-pnl').value = String(p.dayPnl);
      recomputeShield();
    });
  });

  ['inp-mode', 'inp-balance', 'inp-hwm', 'inp-dd-max', 'inp-dll', 'inp-day-pnl', 'inp-symbol', 'inp-stop-ticks', 'inp-spread-ticks', 'inp-atr', 'inp-losses'].forEach((id) => {
    $(id)?.addEventListener('input', recomputeShield);
    $(id)?.addEventListener('change', recomputeShield);
  });

  $('mc-run-btn')?.addEventListener('click', runMonteCarlo);

  document.querySelectorAll('.tier-pick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('tier-select').value = btn.getAttribute('data-tier');
      updateWalletLabel();
      $('self-custody-warning').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
  function clearManualChallengeFields() {
    if ($('manual-nonce-input')) $('manual-nonce-input').value = '';
    if ($('manual-sig-input')) $('manual-sig-input').value = '';
    if ($('manual-challenge-msg')) $('manual-challenge-msg').textContent = '';
    if ($('manual-challenge-box')) $('manual-challenge-box').hidden = true;
  }

  $('tier-select')?.addEventListener('change', () => {
    clearManualChallengeFields();
    updateWalletLabel();
  });
  $('manual-tx-input')?.addEventListener('input', clearManualChallengeFields);

  updateWalletLabel();

  $('wallet-pay-btn')?.addEventListener('click', async () => {
    const tier = TIER_ATOMIC[$('tier-select').value] ? $('tier-select').value : 'team';
    if (typeof window.ethereum === 'undefined') {
      $('manual-challenge-box').hidden = false;
      showBox(
        $('checkout-status'),
        `No browser wallet detected. Send ${TIER_LABEL[tier]} on Base Mainnet (Chain ID 8453) to ${TREASURY_ADDRESS} (USDC ${BASE_USDC_ADDRESS}), paste your txHash below, click Generate Challenge, and paste your Safe/wallet signature.`,
        'warn'
      );
      $('manual-tx-input')?.focus();
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      if (String(chainId).toLowerCase() !== BASE_CHAIN_ID_HEX) {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID_HEX }] });
      }
      const data = encodeErc20Transfer(TREASURY_ADDRESS, TIER_ATOMIC[tier]);
      const txHash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: accounts[0], to: BASE_USDC_ADDRESS, data, value: '0x0' }],
      });
      $('manual-tx-input').value = txHash;
      clearManualChallengeFields();
      await verifyAndClaim(txHash, tier, { forceChallenge: true });
    } catch (err) {
      showBox($('checkout-status'), err?.message || String(err), 'error');
    }
  });

  $('manual-challenge-btn')?.addEventListener('click', async () => {
    const txHash = $('manual-tx-input').value.trim();
    const tier = TIER_ATOMIC[$('tier-select').value] ? $('tier-select').value : 'team';
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      showBox($('checkout-status'), 'Enter a valid 66-character 0x transaction hash first.', 'error');
      return;
    }
    try {
      showBox($('checkout-status'), 'Generating ownership challenge...', '');
      await requestChallenge(txHash, tier);
      showBox($('checkout-status'), 'Challenge ready. Sign the message with your Safe/wallet and paste the 0x signature below.', 'ok');
    } catch (err) {
      showBox($('checkout-status'), err?.message || String(err), 'error');
    }
  });

  $('manual-verify-btn')?.addEventListener('click', async () => {
    const txHash = $('manual-tx-input').value.trim();
    const tier = TIER_ATOMIC[$('tier-select').value] ? $('tier-select').value : 'team';
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      showBox($('checkout-status'), 'Enter a valid 66-character 0x transaction hash.', 'error');
      return;
    }
    await verifyAndClaim(txHash, tier);
  });

  async function inspectCloudEndpoint(path) {
    const outEl = $('cloud-preview-output');
    if (!outEl) return;
    const token = ($('license-token-text')?.textContent || '').trim();
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    try {
      const res = await fetch(path, { headers });
      const data = await res.json();
      outEl.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      outEl.textContent = err?.message || String(err);
    }
  }

  $('cloud-blackouts-btn')?.addEventListener('click', () => inspectCloudEndpoint('/api/cloud/blackout-calendar'));
  $('cloud-presets-btn')?.addEventListener('click', () => inspectCloudEndpoint('/api/cloud/presets'));
  $('cloud-brief-btn')?.addEventListener('click', () => inspectCloudEndpoint('/api/cloud/brief?coins=BTC,ETH,SOL'));

  let stateCert = null;

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function rebuildCommercialCert() {
    const link = $('cert-download-btn');
    if (!link || !stateCert) return;
    const org = (($('cert-org-input')?.value || '').trim() || 'Licensed Commercial Trading Desk');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>EvalShield Commercial License Certificate</title><style>body{font-family:system-ui,sans-serif;padding:40px;color:#0f172a;max-width:760px;margin:0 auto}h1{margin-bottom:4px}.box{border:2px solid #0f172a;padding:24px;border-radius:10px}table{width:100%;border-collapse:collapse;margin-top:16px}td{padding:8px 0;border-bottom:1px solid #cbd5e1}code{word-break:break-all;font-size:12px}</style></head><body><div class="box"><h1>ApexHive Labs — Commercial License Certificate</h1><p>Issued under ApexHive Dual Source-Available License (v3.0)</p><table><tr><td><strong>Organization / Desk</strong></td><td>${escHtml(org)}</td></tr><tr><td><strong>Product &amp; Tier</strong></td><td>evalshield-copilot (${escHtml(String(stateCert.tier).toUpperCase())})</td></tr><tr><td><strong>Seat Allocation</strong></td><td>${stateCert.tier === 'enterprise' ? '100+ Unlimited Organization Seats' : '2-99 Commercial Team Seats'}</td></tr><tr><td><strong>Payment Rail</strong></td><td>Base Mainnet USDC (0x2105)</td></tr><tr><td><strong>Payer Wallet</strong></td><td><code>${escHtml(stateCert.payer)}</code></td></tr><tr><td><strong>Settlement TxHash</strong></td><td><code>${escHtml(stateCert.txHash)}</code></td></tr><tr><td><strong>Signed Ed25519 Token</strong></td><td><code>${escHtml(stateCert.token)}</code></td></tr></table><p style="margin-top:16px;font-size:12px;color:#475569">Verify offline using Ed25519 SPKI key MCowBQYDK2VwAyEArz/+yUqh9Alo5B2DPD23q2vbvAuPPL5m1zqtHg66cA0= · Support: apexhive.hq@proton.me</p></div></body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    link.href = URL.createObjectURL(blob);
  }

  $('cert-org-input')?.addEventListener('input', rebuildCommercialCert);

  recomputeShield();
  runMonteCarlo();
})();
