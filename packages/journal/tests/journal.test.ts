import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { TOKEN_PREFIX } from '@evalshield/core';
import {
  createEvalShieldHttpServer,
  escapeCsvCell,
  EvalShieldDb,
  pairExecutionsFifo,
  parseBrokerCsv
} from '../src/index.js';

const TRADOVATE_FILLS_CSV = [
  'Fill ID,Order ID,Timestamp,_timestamp,Side,Quantity,Price,Contract,Commission',
  'F1,O1,2026-03-18 09:35:00,2026-03-18T13:35:00.000Z,Buy,2,5000.00,ESH6,4.50',
  'F2,O2,2026-03-18 09:42:00,2026-03-18T13:42:00.000Z,Sell,2,5004.00,ESH6,4.50',
  'F3,O3,2026-03-18 10:05:00,2026-03-18T14:05:00.000Z,Sell,1,5010.00,ES 06-26,2.25',
  'F4,O4,2026-03-18 10:15:00,2026-03-18T14:15:00.000Z,Buy,1,5012.00,ES 06-26,2.25'
].join('\n');

const TRADOVATE_PERF_CSV = [
  'Contract,Size,Entry Price,Exit Price,P&L',
  'MESM6,2,5000.00,5010.00,$100.00'
].join('\n');

const NT8_TRADES_CSV = [
  'Account,Instrument,Market Position,Quantity,Entry Time,Entry Price,Exit Time,Exit Price,Profit,Commission,MAE,MFE',
  'Sim101,NQ 06-26,Long,1,2026-03-18T14:00:00Z,18000.00,2026-03-18T14:10:00Z,18020.00,395.50,4.50,-50.00,450.00'
].join('\n');

const RITHMIC_CSV = [
  'Account,Status,Buy/Sell,Symbol,Qty Filled,Avg Fill Price,Create Time,Update Time,Commission',
  'APEX-1,Filled,Buy,MNQM6,2,18000.00,2026-03-18T14:00:00Z,2026-03-18T14:00:01Z,1.24',
  'APEX-1,Canceled,Sell,MNQM6,2,18050.00,2026-03-18T14:01:00Z,2026-03-18T14:01:05Z,0',
  'APEX-1,Filled,Sell,MNQM6,2,18025.00,2026-03-18T14:05:00Z,2026-03-18T14:05:01Z,1.24'
].join('\n');

const TRADINGVIEW_CSV = [
  'Symbol,Side,Amount,Avg entry price,Time of first entry,Avg exit price,Time of final exit,Total commission costs',
  'CME_MINI:MES1!,Buy,2,5100.00,2026-03-18T14:00:00Z,5110.00,2026-03-18T14:20:00Z,2.48'
].join('\n');

test('All 4 broker CSV adapters parse cleanly & Rithmic validates missing columns', () => {
  const tf = parseBrokerCsv(TRADOVATE_FILLS_CSV, 'auto', 'acc_1');
  assert.equal(tf.formatUsed, 'tradovate-fills');
  assert.equal(tf.executions.length, 4);
  const fifo = pairExecutionsFifo(tf.executions);
  assert.equal(fifo.length, 2);
  // Trade 1: +4 pts * 2 * $50 = $400 - $9 = $391
  assert.equal(fifo[0]!.netPnlUsd, 391);
  // Trade 2: short 5010 -> 5012 = -2 pts * 1 * $50 = -$100 - $4.50 = -$104.50
  assert.equal(fifo[1]!.netPnlUsd, -104.5);

  const tp = parseBrokerCsv(TRADOVATE_PERF_CSV, 'auto', 'acc_1');
  assert.equal(tp.formatUsed, 'tradovate-perf');
  assert.equal(tp.directTrades[0]!.netPnlUsd, 100);
  assert.ok(tp.warnings.length > 0);

  const nt = parseBrokerCsv(NT8_TRADES_CSV, 'auto', 'acc_1');
  assert.equal(nt.formatUsed, 'nt8-trades');
  assert.equal(nt.directTrades[0]!.netPnlUsd, 395.5);
  assert.equal(nt.directTrades[0]!.maeUsd, -50);

  const rit = parseBrokerCsv(RITHMIC_CSV, 'auto', 'acc_1');
  assert.equal(rit.formatUsed, 'rithmic');
  assert.equal(rit.executions.length, 2); // Canceled row skipped
  const ritPaired = pairExecutionsFifo(rit.executions);
  // +25 pts * 2 * $2 = $100 - $2.48 = $97.52
  assert.equal(ritPaired[0]!.netPnlUsd, 97.52);

  const tv = parseBrokerCsv(TRADINGVIEW_CSV, 'auto', 'acc_1');
  assert.equal(tv.formatUsed, 'tradingview');
  // +10 pts * 2 * $5 = $100 - $2.48 = $97.52
  assert.equal(tv.directTrades[0]!.netPnlUsd, 97.52);

  assert.throws(
    () => parseBrokerCsv('Buy/Sell,Qty Filled,Avg Fill Price\nBuy,1,5000', 'rithmic', 'acc_1'),
    /Add\/Remove Columns/
  );
});

test('SQLite WAL journal deduplicates CSV re-imports, tracks tilt leakage, and sanitizes export CSV', () => {
  const db = new EvalShieldDb(':memory:');
  const acc = db.createAccount({ name: 'Eval 1', presetId: 'topstep_50k', maxContractsCap: 2 });

  const first = db.importCsv(acc.id, TRADOVATE_FILLS_CSV, 'auto', { maxAllowedContracts: 1 });
  assert.equal(first.importedExecutions, 4);
  assert.equal(first.skippedDuplicates, 0);
  assert.equal(first.pairedTradesCount, 2);
  // Net PnL = 391 - 104.5 = 286.50
  assert.equal(first.account.realizedBalance, 50_286.5);
  // Trade 1 had qty 2 > maxAllowedContracts 1 -> 50% adherence
  assert.equal(first.scorecard.ruleAdherencePct, 50);

  // Re-importing exact same CSV must skip all 4 duplicates without inflating PnL
  const dup = db.importCsv(acc.id, TRADOVATE_FILLS_CSV, 'auto', { maxAllowedContracts: 1 });
  assert.equal(dup.importedExecutions, 0);
  assert.equal(dup.skippedDuplicates, 4);
  assert.equal(dup.account.realizedBalance, 50_286.5);

  // Formula injection check
  assert.equal(escapeCsvCell('=CMD()'), "'=CMD()");
  assert.equal(escapeCsvCell('+1+1'), "'+1+1");
  const exported = db.exportTradesCsv(acc.id);
  assert.ok(exported.includes('QTY_EXCEEDED_CAP'));
  db.close();
});

test('HTTP server unlocks Solo-Free local accounts, enforces strict CORS, validates Ed25519, HMAC webhook, and 413 cap', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const webhookSecret = 'test-local-webhook-secret-32bytes';

  const db = new EvalShieldDb(':memory:');
  const acc = db.seedDefaultAccountIfEmpty();
  const server = createEvalShieldHttpServer({
    db,
    publicKeySpkiB64: spkiB64,
    webhookSecret,
    allowedOrigins: ['https://trusted.evalshield.example']
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // CORS: loopback Origin reflected with Vary: Origin (never wildcard *); disallowed write rejected with 403 ORIGIN_NOT_ALLOWED
    const health = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: 'http://127.0.0.1:4200' }
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4200');
    assert.equal(health.headers.get('vary'), 'Origin');
    const healthJson = (await health.json()) as { orderRoutingEnabled: boolean };
    assert.equal(healthJson.orderRoutingEnabled, false);

    const corsDenied = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'Cross-Origin Block', presetId: 'apex_50k_eod' })
    });
    assert.equal(corsDenied.status, 403);
    assert.equal(corsDenied.headers.get('access-control-allow-origin'), null);
    assert.equal(corsDenied.headers.get('vary'), 'Origin');
    assert.equal(((await corsDenied.json()) as { error: string }).error, 'ORIGIN_NOT_ALLOWED');

    // Explicit allowlist origin permitted
    const createdLocal = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://trusted.evalshield.example'
      },
      body: JSON.stringify({ name: 'Second Solo-Free Eval', presetId: 'apex_50k_eod' })
    });
    assert.equal(createdLocal.status, 201);
    assert.equal(
      createdLocal.headers.get('access-control-allow-origin'),
      'https://trusted.evalshield.example'
    );

    // Activate valid Ed25519 Solo token -> tier transitions to solo cleanly
    const payload = {
      v: 1,
      product: 'evalshield-copilot',
      tier: 'solo',
      maxAccounts: 20,
      payer: '0x2222222222222222222222222222222222222222',
      txHash: `0x${'b'.repeat(64)}`,
      issuedAt: Date.now(),
      expiresAt: null
    };
    const pB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = sign(null, Buffer.from(`${TOKEN_PREFIX}${pB64}`, 'utf8'), privateKey).toString('base64url');
    const token = `${TOKEN_PREFIX}${pB64}.${sig}`;

    const act = await fetch(`${baseUrl}/api/license/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token })
    });
    assert.equal(act.status, 200);
    const actJson = (await act.json()) as { license: { valid: boolean; tier: string } };
    assert.equal(actJson.license.valid, true);
    assert.equal(actJson.license.tier, 'solo');

    // Webhook rejects bad HMAC (401)
    const whBody = JSON.stringify({
      accountId: acc.id,
      eventType: 'atr_bar',
      symbol: 'ES',
      atr14: 3.5,
      atr20dMedian: 1.5
    });
    const badWh = await fetch(`${baseUrl}/api/ingest/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': '0'.repeat(64) },
      body: whBody
    });
    assert.equal(badWh.status, 401);

    // Valid HMAC webhook updates ATR context (200) & risk/check picks it up
    const goodSig = createHmac('sha256', webhookSecret).update(whBody).digest('hex');
    const goodWh = await fetch(`${baseUrl}/api/ingest/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': goodSig },
      body: whBody
    });
    assert.equal(goodWh.status, 200);

    const riskRes = await fetch(`${baseUrl}/api/risk/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: acc.id,
        symbol: 'ES',
        userStopTicks: 8,
        sessionFilter: { skipGlobexCheck: true }
      })
    });
    assert.equal(riskRes.status, 200);
    const riskJson = (await riskRes.json()) as {
      result: { stopTicksEffective: number; session: { flags: string[] } };
    };
    // ATR 3.5 / 0.25 = 14 ticks > 8 user ticks; 3.5 / 1.5 > 2.0 -> HIGH_VOL_REGIME!
    assert.equal(riskJson.result.stopTicksEffective, 14);
    assert.ok(riskJson.result.session.flags.includes('HIGH_VOL_REGIME'));

    // Webhook 413 guard (>65536 bytes)
    const oversized = await fetch(`${baseUrl}/api/ingest/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': '0'.repeat(64) },
      body: 'x'.repeat(70_000)
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('v3.0 pretrade audits, SSRF-safe BYO connectors, custom assets, 15s brief, and portfolio anti-hedge guard', async () => {
  const db = new EvalShieldDb(':memory:');
  const acc1 = db.createAccount({ name: 'Tradeify Growth #1', presetId: 'tradeify_50k_growth' });
  const acc2 = db.createAccount({ name: 'Tradeify Growth #2', presetId: 'tradeify_50k_growth' });

  const mockFetch = (async (input: string | URL) => {
    const u = String(input);
    if (u.includes('gamma-api.polymarket.com')) {
      return new Response(
        JSON.stringify([
          {
            question: 'Will US CPI exceed 3.0% YoY?',
            outcomePrices: '["0.42","0.58"]',
            oneDayPriceChange: 0.03,
            volume24hr: 500000,
            closed: false,
            endDate: '2027-01-01T00:00:00Z'
          }
        ]),
        { status: 200 }
      );
    }
    if (u.includes('api.hyperliquid.xyz/info')) {
      return new Response(
        JSON.stringify([
          { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }] },
          [
            { markPx: '96000', funding: '0.0007', openInterest: '39000', dayNtlVlm: '900000000' },
            { markPx: '3500', funding: '0.0001', openInterest: '150000', dayNtlVlm: '400000000' },
            { markPx: '210', funding: '0.0002', openInterest: '900000', dayNtlVlm: '300000000' }
          ]
        ]),
        { status: 200 }
      );
    }
    return new Response(
      `<rss><channel>
        <item><title>CPI Report Sparks Metals Bid</title><link>https://reuters.com/1</link></item>
        <item><title>Football Finals Weekend</title><link>https://reuters.com/2</link></item>
        <item><title>FOMC Minutes Highlight Gold Volatility</title><link>https://reuters.com/3</link></item>
      </channel></rss>`,
      { status: 200 }
    );
  }) as typeof fetch;

  const server = createEvalShieldHttpServer({ db, fetchFn: mockFetch });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Record Pre-Trade Snapshot + Raw Thesis
    const ptPost = await fetch(`${baseUrl}/api/journal/pretrade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: acc1.id,
        symbol: 'XAUUSD',
        side: 'LONG',
        plannedQty: 1,
        stopTicks: 150,
        thesisNote: 'London low sweep + CPI hedge bid'
      })
    });
    assert.equal(ptPost.status, 201);
    const ptGet = await fetch(`${baseUrl}/api/journal/pretrade?accountId=${encodeURIComponent(acc1.id)}`);
    const ptList = (await ptGet.json()) as { audits: Array<{ thesisNote: string; symbol: string }> };
    assert.equal(ptList.audits[0]?.symbol, 'XAUUSD');
    assert.equal(ptList.audits[0]?.thesisNote, 'London low sweep + CPI hedge bid');

    // 2. SSRF & X.com blocking vs valid RSS / Polymarket slug / Custom asset creation
    const xBlocked = await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'rss', label: 'X Scrape', target: 'https://x.com/trader' })
    });
    assert.equal(xBlocked.status, 400);

    const lanBlocked = await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'rss', label: 'LAN', target: 'https://192.168.1.10/rss.xml' })
    });
    assert.equal(lanBlocked.status, 400);

    await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'polymarket_slug', label: 'US CPI', target: 'us-cpi-above-3' })
    });
    await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'rss',
        label: 'Reuters Macro',
        target: 'https://feeds.reuters.com/macro.xml',
        keywords: ['CPI', 'FOMC']
      })
    });
    await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'custom_asset',
        label: 'Micro Dax Custom',
        target: 'FDXS',
        metaJson: { tickSize: 1, tickValue: 1, defaultRoundTripCommission: 2.0 }
      })
    });

    // Custom asset usable in risk/check
    const customRisk = await fetch(`${baseUrl}/api/risk/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: acc1.id,
        symbol: 'FDXS',
        userStopTicks: 20,
        sessionFilter: { skipGlobexCheck: true }
      })
    });
    assert.equal(customRisk.status, 200);
    const customJson = (await customRisk.json()) as { result: { symbol: string; assetClass: string } };
    assert.equal(customJson.result.symbol, 'FDXS');
    assert.equal(customJson.result.assetClass, 'CUSTOM');

    // 3. 15-second Brief aggregates Polymarket + Hyperliquid + filtered RSS
    const briefRes = await fetch(`${baseUrl}/api/brief`);
    assert.equal(briefRes.status, 200);
    const briefJson = (await briefRes.json()) as {
      brief: {
        polymarket: Array<{ yesProbabilityPct: number }>;
        hyperliquid: Array<{ coin: string; extremeFundingAlert: boolean }>;
        rssHighlights: Array<{ title: string }>;
      };
    };
    assert.equal(briefJson.brief.polymarket[0]?.yesProbabilityPct, 42);
    assert.equal(briefJson.brief.hyperliquid[0]?.extremeFundingAlert, true);
    assert.equal(briefJson.brief.rssHighlights.length, 2);

    // 4. Portfolio guard flags Tradeify cross-account opposite hedge
    const portRes = await fetch(`${baseUrl}/api/portfolio/guard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        positions: [
          { accountId: acc1.id, symbol: 'ES', side: 'LONG', qty: 2 },
          { accountId: acc2.id, symbol: 'NQ', side: 'SHORT', qty: 2 }
        ]
      })
    });
    assert.equal(portRes.status, 200);
    const portJson = (await portRes.json()) as {
      guard: { safeToProceed: boolean; alerts: Array<{ code: string }> };
    };
    assert.equal(portJson.guard.safeToProceed, false);
    assert.ok(portJson.guard.alerts.some((a) => a.code === 'CROSS_ACCOUNT_ANTI_HEDGE_VIOLATION'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('HTTP server optional localAuthToken enforces Bearer/header auth on /api/* while keeping /api/health open', async () => {
  const db = new EvalShieldDb(':memory:');
  db.seedDefaultAccountIfEmpty();
  const server = createEvalShieldHttpServer({ db, localAuthToken: 'local-secret-token-xyz' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const h = await fetch(`${baseUrl}/api/health`);
    assert.equal(h.status, 200);

    const unauth = await fetch(`${baseUrl}/api/accounts`);
    assert.equal(unauth.status, 401);
    assert.equal(((await unauth.json()) as { error: string }).error, 'LOCAL_AUTH_REQUIRED');

    const authed = await fetch(`${baseUrl}/api/accounts`, {
      headers: { authorization: 'Bearer local-secret-token-xyz' }
    });
    assert.equal(authed.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('Webhook fill CSV quoting blocks column/row injection and export.csv sanitizes Content-Disposition', async () => {
  const webhookSecret = 'webhook-csv-safety-secret-32bytes';
  const db = new EvalShieldDb(':memory:');
  const acc = db.seedDefaultAccountIfEmpty();
  const server = createEvalShieldHttpServer({ db, webhookSecret });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    // Newline in execId rejected cleanly (400)
    const nlPayload = JSON.stringify({
      accountId: acc.id,
      eventType: 'fill',
      symbol: 'MES',
      side: 'BUY',
      qty: 1,
      price: 5000,
      execId: 'EX1\nF99,O99,2026-03-18,2026-03-18,Sell,99,9999,ES,0'
    });
    const nlSig = createHmac('sha256', webhookSecret).update(nlPayload).digest('hex');
    const nlRes = await fetch(`${baseUrl}/api/ingest/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': nlSig },
      body: nlPayload
    });
    assert.equal(nlRes.status, 400);

    // Comma/quote inside execId safely CSV-quoted without splitting columns
    const commaPayload = JSON.stringify({
      accountId: acc.id,
      eventType: 'fill',
      symbol: 'MES',
      side: 'BUY',
      qty: 1,
      price: 5000,
      execId: 'EX,"1",2'
    });
    const commaSig = createHmac('sha256', webhookSecret).update(commaPayload).digest('hex');
    const commaRes = await fetch(`${baseUrl}/api/ingest/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': commaSig },
      body: commaPayload
    });
    assert.equal(commaRes.status, 200);

    // export.csv sanitizes filename and returns nosniff
    const exp = await fetch(`${baseUrl}/api/journal/export.csv?accountId=${encodeURIComponent(acc.id)}`);
    assert.equal(exp.status, 200);
    assert.equal(exp.headers.get('x-content-type-options'), 'nosniff');
    assert.match(exp.headers.get('content-disposition') ?? '', /^attachment; filename="evalshield-[A-Za-z0-9_-]+\.csv"$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
