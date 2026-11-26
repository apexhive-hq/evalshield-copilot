import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  applyEodSessionRollover,
  buildFifteenSecondBrief,
  computeDrawdownState,
  evaluatePortfolioGuard,
  evaluateRiskCheck,
  evaluateSessionQuality,
  getContractSpec,
  getMaxAllowedAccounts,
  isGlobexClosedUtc,
  isUsEuDstMismatchWeek,
  normalizeSymbolRoot,
  parseRssAtomHeadlineBrief,
  PROP_FIRM_PRESETS,
  TOKEN_PREFIX,
  validateSafeConnectorUrl,
  verifyEvalShieldLicenseToken,
  type AccountRiskProfile
} from '../src/index.js';

function makeBaseAccount(overrides?: Partial<AccountRiskProfile>): AccountRiskProfile {
  const preset = PROP_FIRM_PRESETS.topstep_50k;
  return {
    id: 'acc_1',
    name: 'Test 50K',
    presetId: preset.id,
    startingBalance: preset.startingBalance,
    realizedBalance: preset.startingBalance,
    openUnrealizedPnl: 0,
    hwm: preset.startingBalance,
    dayRealizedPnl: 0,
    drawdownMode: preset.drawdownMode,
    maxDrawdown: preset.maxDrawdown,
    dailyLossLimit: preset.dailyLossLimit,
    alphaSoftDll: 0.8,
    safetyReserve: 0,
    lockCap: preset.lockCap,
    maxContractsCap: preset.maxContractsCap,
    consistencyCap: preset.consistencyCap,
    profitTarget: preset.profitTarget,
    dailyRealizedPnls: [],
    ...overrides
  };
}

test('CME symbol normalization & verified tick specs', () => {
  assert.equal(normalizeSymbolRoot('ES 03-26'), 'ES');
  assert.equal(normalizeSymbolRoot('MNQZ26'), 'MNQ');
  assert.equal(normalizeSymbolRoot('CME_MINI:MES1!'), 'MES');
  assert.equal(getContractSpec('ES').tickValue, 12.5);
  assert.equal(getContractSpec('MES').tickValue, 1.25);
  assert.equal(getContractSpec('NQ').tickValue, 5.0);
  assert.equal(getContractSpec('MNQ').tickValue, 0.5);
  assert.equal(getContractSpec('GC').tickValue, 10.0);
  assert.equal(getContractSpec('MGC').tickValue, 1.0);
  assert.equal(getContractSpec('CL').tickValue, 10.0);
  assert.equal(getContractSpec('MCL').tickValue, 1.0);
});

test('EOD vs Intraday trailing drawdown floor & Apex safety-lock cap', () => {
  const eod = makeBaseAccount({
    drawdownMode: 'EOD_TRAILING',
    realizedBalance: 50_000,
    openUnrealizedPnl: 1_200,
    hwm: 50_000,
    maxDrawdown: 2_000,
    lockCap: 50_000
  });
  const eodState = computeDrawdownState(eod);
  // Floating +1,200 does NOT pull up EOD HWM
  assert.equal(eodState.effectiveHwm, 50_000);
  assert.equal(eodState.floor, 48_000);
  assert.equal(eodState.ddBuffer, 3_200);

  // EOD rollover advances HWM from closed balance and caps floor at lockCap
  const rolled = applyEodSessionRollover(eod, 52_600);
  const rolledState = computeDrawdownState(rolled);
  assert.equal(rolledState.effectiveHwm, 52_600);
  assert.equal(rolledState.floor, 50_000);

  // Intraday trailing pulls floor immediately on floating unrealized gain
  const intraday = makeBaseAccount({
    drawdownMode: 'INTRADAY_TRAILING',
    realizedBalance: 50_000,
    openUnrealizedPnl: 1_200,
    hwm: 50_000,
    maxDrawdown: 2_500,
    dailyLossLimit: null,
    lockCap: 50_100
  });
  const intraState = computeDrawdownState(intraday);
  assert.equal(intraState.effectiveHwm, 51_200);
  assert.equal(intraState.floor, 48_700);
  assert.equal(intraState.ddBuffer, 2_500);
});

test('ATR stop floor, DLL soft lock, maxContractsAllowed & micro fallback', () => {
  const acc = makeBaseAccount({
    realizedBalance: 50_000,
    dayRealizedPnl: 0,
    dailyLossLimit: 1_000,
    alphaSoftDll: 0.8,
    maxDrawdown: 2_000
  });
  // Wed 14:30 UTC (09:30 or 10:30 ET, open Globex session)
  const wedOpenUtc = Date.UTC(2026, 2, 18, 14, 30, 0);
  const res = evaluateRiskCheck({
    account: acc,
    symbol: 'ES',
    userStopTicks: 8,
    atr14: 3.0, // 12 ticks on ES (0.25 tickSize) > 8 user ticks
    kAtr: 1.0,
    roundTripCommission: 4.5,
    slippageTicks: 1,
    maxRiskPerTradePct: 0.25,
    runwayTrades: 4,
    sessionFilter: { nowUtcMs: wedOpenUtc }
  });

  // Fresh account: Soft DLL = 800, DD = 2000 => remainingBuffer = 800, status = GREEN
  assert.equal(res.remainingBuffer, 800);
  assert.equal(res.stopTicksEffective, 12);
  // Loss per ES = 12*12.5 + 4.5 + 12.5 = 167
  assert.equal(res.lossPerContract, 167);
  // Budget = min(0.25*800, 800/4) = 200 => floor(200/167) = 1 ES contract
  assert.equal(res.tradeRiskBudget, 200);
  assert.equal(res.maxContractsAllowed, 1);
  assert.equal(res.status, 'GREEN');

  // Losing 650 intraday -> softDllBuffer = 800 - 650 = 150 <= 0.20*800 (160) -> RED_LOCKOUT!
  const tightAcc = makeBaseAccount({
    realizedBalance: 49_350,
    dayRealizedPnl: -650,
    dailyLossLimit: 1_000,
    alphaSoftDll: 0.8,
    maxDrawdown: 2_000
  });
  const locked = evaluateRiskCheck({
    account: tightAcc,
    symbol: 'ES',
    userStopTicks: 12,
    sessionFilter: { nowUtcMs: wedOpenUtc }
  });
  assert.equal(locked.status, 'RED_LOCKOUT');
  assert.equal(locked.maxContractsAllowed, 0);

  // Losing 450 intraday -> remainingBuffer = 350 (>160 RED, <=400 AMBER): AMBER halves budget -> 0 ES, >= 2 MES!
  const amberAcc = makeBaseAccount({
    realizedBalance: 49_550,
    dayRealizedPnl: -450,
    dailyLossLimit: 1_000,
    alphaSoftDll: 0.8,
    maxDrawdown: 2_000
  });
  const amber = evaluateRiskCheck({
    account: amberAcc,
    symbol: 'ES',
    userStopTicks: 12,
    maxRiskPerTradePct: 0.25,
    runwayTrades: 4,
    sessionFilter: { nowUtcMs: wedOpenUtc }
  });
  assert.equal(amber.status, 'AMBER_CAUTION');
  assert.equal(amber.maxContractsAllowed, 0);
  assert.equal(amber.microFallbackSymbol, 'MES');
  assert.ok((amber.microFallbackContracts ?? 0) >= 2);
});

test('Consistency rule calculation & warning flag', () => {
  const acc = makeBaseAccount({
    startingBalance: 50_000,
    realizedBalance: 52_000,
    dayRealizedPnl: 1_400,
    dailyRealizedPnls: [600, 1_400],
    consistencyCap: 0.3,
    profitTarget: 3_000
  });
  const wedOpenUtc = Date.UTC(2026, 2, 18, 14, 30, 0);
  const res = evaluateRiskCheck({
    account: acc,
    symbol: 'MES',
    userStopTicks: 10,
    sessionFilter: { nowUtcMs: wedOpenUtc }
  });
  assert.equal(res.totalProfit, 2_000);
  assert.equal(res.maxDayProfit, 1_400);
  assert.equal(res.consistencyRatio, 0.7);
  assert.equal(res.dailyProfitSoftCap, 900);
  assert.equal(res.requiredTotalProfitForPayout, 4666.67);
  assert.equal(res.nearConsistencyCap, true);
  assert.ok(res.session.flags.includes('CONSISTENCY_CAP_WARNING'));
});

test('Session filter handles Globex maintenance, ATR expansion, and tilt cooldown', () => {
  // EDT in summer (July 15, 2026): 17:15 ET == 21:15 UTC
  const breakUtc = Date.UTC(2026, 6, 15, 21, 15, 0);
  assert.equal(isGlobexClosedUtc(breakUtc), true);
  const closedSession = evaluateSessionQuality({ nowUtcMs: breakUtc });
  assert.equal(closedSession.sessionAction, 'STAND_DOWN');
  assert.ok(closedSession.flags.includes('SESSION_CLOSED'));

  // Open session with 3 consecutive losses 5 min ago -> 10 min cooldown left
  const openUtc = Date.UTC(2026, 6, 15, 14, 0, 0);
  assert.equal(isGlobexClosedUtc(openUtc), false);
  const tilt = evaluateSessionQuality({
    nowUtcMs: openUtc,
    consecutiveLossesToday: 3,
    maxConsecLosses: 3,
    cooldownMinutes: 15,
    lastLossUtcMs: openUtc - 5 * 60_000,
    atr14: 10,
    atr20dMedian: 4 // > 2.0x
  });
  assert.equal(tilt.sessionAction, 'STAND_DOWN');
  assert.equal(tilt.volSizeMultiplier, 0.5);
  assert.equal(tilt.cooldownRemainingSec, 600);
  assert.ok(tilt.flags.includes('HIGH_VOL_REGIME'));
  assert.ok(tilt.flags.includes('TILT_COOLDOWN_ACTIVE'));
});

test('Ed25519 EVALSHIELD-PRO-v1 license verification & account tier limits', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  const payload = {
    v: 1 as const,
    product: 'evalshield-copilot' as const,
    tier: 'solo' as const,
    maxAccounts: 20,
    payer: '0x1111111111111111111111111111111111111111',
    txHash: `0x${'a'.repeat(64)}`,
    issuedAt: 1_700_000_000_000,
    expiresAt: null
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = Buffer.from(`${TOKEN_PREFIX}${payloadB64}`, 'utf8');
  const sigB64 = sign(null, signingInput, privateKey).toString('base64url');
  const token = `${TOKEN_PREFIX}${payloadB64}.${sigB64}`;

  const ok = verifyEvalShieldLicenseToken(token, { publicKeySpkiB64: spkiB64 });
  assert.equal(ok.valid, true);
  assert.equal(ok.tier, 'solo');
  assert.equal(getMaxAllowedAccounts(ok), 20);

  // Tampered payload rejected; Solo-Free local core unlocks local accounts without restriction
  const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, tier: 'team' }), 'utf8').toString('base64url');
  const bad = verifyEvalShieldLicenseToken(`${TOKEN_PREFIX}${tamperedPayload}.${sigB64}`, {
    publicKeySpkiB64: spkiB64
  });
  assert.equal(bad.valid, false);
  assert.equal(getMaxAllowedAccounts(bad), null);

  // Team ($99 Early-Bird) and Enterprise ($499 Early-Bird) ApexHive commercial tokens verify cleanly
  for (const tier of ['team', 'enterprise'] as const) {
    const commPayloadB64 = Buffer.from(
      JSON.stringify({ ...payload, tier, maxAccounts: tier === 'team' ? 99 : null }),
      'utf8'
    ).toString('base64url');
    const commSig = sign(null, Buffer.from(`${TOKEN_PREFIX}${commPayloadB64}`, 'utf8'), privateKey).toString('base64url');
    const verified = verifyEvalShieldLicenseToken(`${TOKEN_PREFIX}${commPayloadB64}.${commSig}`, {
      publicKeySpkiB64: spkiB64
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.tier, tier);
  }
});

test('v3.0 Cross-Asset Specs, XAUUSD spread R-drag, Crypto Perps fees/funding, and remaining safe headroom', () => {
  assert.equal(normalizeSymbolRoot('XAU/USD'), 'XAUUSD');
  assert.equal(normalizeSymbolRoot('BTCUSDT'), 'BTC-PERP');
  assert.equal(getContractSpec('XAUUSD').assetClass, 'FX_METAL');
  assert.equal(getContractSpec('BTC-PERP').assetClass, 'CRYPTO_PERP');

  const ftmoAcc = makeBaseAccount({
    presetId: 'ftmo_100k_1step',
    startingBalance: 100_000,
    realizedBalance: 103_000,
    dayRealizedPnl: 4_300,
    consistencyCap: 0.5,
    profitTarget: 10_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 10_000,
    dailyLossLimit: 3_000,
    newsRestriction: 'STRICT_ALL_ORDERS_BAN'
  });

  // 17:02 ET Thursday -> FX Rollover Spread Window + 85% Consistency Cap Check
  const rolloverUtc = Date.UTC(2026, 2, 19, 21, 2, 0); // March 19 2026 is ALSO US/EU DST mismatch week!
  const goldRes = evaluateRiskCheck({
    account: ftmoAcc,
    symbol: 'XAUUSD',
    userStopTicks: 200,
    spreadTicks: 75, // 75 pips rollover widening
    sessionFilter: { nowUtcMs: rolloverUtc }
  });
  assert.equal(goldRes.spreadDragWarning, true);
  assert.equal(goldRes.dailyCap85Reached, true);
  assert.equal(goldRes.remainingSafeAdditionalProfitUsd, 700);
  assert.ok(goldRes.session.flags.includes('FX_ROLLOVER_SPREAD_WINDOW'));
  assert.ok(goldRes.session.flags.includes('SPREAD_R_DRAG_HIGH'));
  assert.ok(goldRes.session.flags.includes('US_EU_DST_MISMATCH_WEEK'));

  // Crypto perp taker fee + 8h funding fee calculation
  const btcRes = evaluateRiskCheck({
    account: makeBaseAccount({ presetId: 'custom', startingBalance: 50_000, realizedBalance: 50_000 }),
    symbol: 'BTC-PERP',
    userStopTicks: 500,
    notionalUsd: 20_000,
    isMakerOrder: false,
    fundingRateHourly: 0.0005,
    expectedHoldHours: 8,
    sessionFilter: { nowUtcMs: rolloverUtc }
  });
  assert.equal(btcRes.assetClass, 'CRYPTO_PERP');
  assert.equal(btcRes.perpFeesUsd, 18); // 20000 * 4.5bps * 2
  assert.equal(btcRes.estimatedFundingUsd, 80); // 20000 * 0.0005 * 8
  assert.ok(!btcRes.session.flags.includes('SESSION_CLOSED'));
});

test('v3.0 Prop-Firm News Blackout Distinction & US/EU DST mismatch calendar', () => {
  const dstWeek = isUsEuDstMismatchWeek(Date.UTC(2026, 2, 18, 14, 0, 0));
  assert.equal(dstWeek.active, true);
  assert.equal(dstWeek.diffHours, 5);

  const normalWeek = isUsEuDstMismatchWeek(Date.UTC(2026, 5, 10, 14, 0, 0));
  assert.equal(normalWeek.active, false);
  assert.equal(normalWeek.diffHours, 6);

  const cpiMs = Date.UTC(2026, 5, 10, 12, 30, 0);
  const nowInside2m = cpiMs - 60_000;
  // FTMO strict ±2m SL/TP ban
  const ftmo = evaluateSessionQuality({
    nowUtcMs: nowInside2m,
    newsRestriction: 'STRICT_ALL_ORDERS_BAN',
    eventWindows: [{ name: 'US CPI', timestampUtcMs: cpiMs }]
  });
  assert.equal(ftmo.sessionAction, 'STAND_DOWN');
  assert.ok(ftmo.flags.includes('STRICT_NEWS_SL_TP_BAN'));

  // Tradeify / Topstep news exempt -> advisory only
  const exempt = evaluateSessionQuality({
    nowUtcMs: nowInside2m,
    newsRestriction: 'EXEMPT',
    eventWindows: [{ name: 'US CPI', timestampUtcMs: cpiMs }]
  });
  assert.notEqual(exempt.sessionAction, 'STAND_DOWN');
  assert.ok(exempt.flags.includes('NEWS_VOLATILITY_ADVISORY'));

  // MFFU Eval = exempt, MFFU Funded = blocked
  const mffuEval = evaluateSessionQuality({
    nowUtcMs: nowInside2m,
    newsRestriction: 'FUNDED_ONLY_BAN',
    accountStage: 'EVAL',
    eventWindows: [{ name: 'US CPI', timestampUtcMs: cpiMs }]
  });
  assert.notEqual(mffuEval.sessionAction, 'STAND_DOWN');

  const mffuFunded = evaluateSessionQuality({
    nowUtcMs: nowInside2m,
    newsRestriction: 'FUNDED_ONLY_BAN',
    accountStage: 'FUNDED',
    eventWindows: [{ name: 'US CPI', timestampUtcMs: cpiMs }]
  });
  assert.equal(mffuFunded.sessionAction, 'STAND_DOWN');
});

test('v3.0 Multi-Account Portfolio Guard detects cross-account anti-hedging, ES+NQ correlation & copier orphan', () => {
  const acc1 = makeBaseAccount({ id: 'acc_1', name: 'Tradeify #1', presetId: 'tradeify_50k_growth' });
  const acc2 = makeBaseAccount({ id: 'acc_2', name: 'Tradeify #2', presetId: 'tradeify_50k_growth' });

  const conflict = evaluatePortfolioGuard(
    [
      { accountId: 'acc_1', symbol: 'ES', side: 'LONG', qty: 2, antiHedgingBanned: true },
      { accountId: 'acc_2', symbol: 'NQ', side: 'SHORT', qty: 2, antiHedgingBanned: true }
    ],
    [acc1, acc2]
  );
  assert.equal(conflict.safeToProceed, false);
  assert.ok(conflict.alerts.some((a) => a.code === 'CROSS_ACCOUNT_ANTI_HEDGE_VIOLATION'));

  const correlatedAndSkewed = evaluatePortfolioGuard(
    [
      { accountId: 'acc_1', symbol: 'ES', side: 'LONG', qty: 2 },
      { accountId: 'acc_1', symbol: 'NQ', side: 'LONG', qty: 2 }
    ],
    [acc1, acc2]
  );
  assert.ok(correlatedAndSkewed.alerts.some((a) => a.code === 'CORRELATED_EXPOSURE_MULTIPLIER'));
  assert.ok(correlatedAndSkewed.alerts.some((a) => a.code === 'COPIER_ORPHAN_OR_SKEW_DETECTED'));
});

test('v3.0 SSRF Policy Guard, RSS 3-item cap & Mocked Gamma/Hyperliquid 15s Brief', async () => {
  assert.throws(() => validateSafeConnectorUrl('https://x.com/MacroAlf'), /X_SCRAPING_DISALLOWED/);
  assert.throws(() => validateSafeConnectorUrl('https://api.binance.com/api/v3/ticker'), /GEO_RESTRICTED/);
  assert.throws(() => validateSafeConnectorUrl('https://127.0.0.1/feed.xml'), /SSRF_BLOCKED/);
  assert.doesNotThrow(() => validateSafeConnectorUrl('https://feeds.reuters.com/reuters/businessNews'));

  const mockRss = `<?xml version="1.0"?><rss><channel>
    <item><title>FOMC Minutes Show Caution</title><link>https://example.com/1</link></item>
    <item><title>Sports News Ignored</title><link>https://example.com/2</link></item>
    <item><title>CPI Core Inflation Eases</title><link>https://example.com/3</link></item>
    <item><title>Fed Chair Speech Tomorrow</title><link>https://example.com/4</link></item>
    <item><title>FOMC Rate Decision Preview</title><link>https://example.com/5</link></item>
  </channel></rss>`;
  const parsed = parseRssAtomHeadlineBrief(mockRss, ['FOMC', 'CPI', 'Fed'], 'TestRSS', 5);
  assert.equal(parsed.length, 3); // Strictly hard-capped at 3 bullets!
  assert.ok(parsed.every((p) => !p.title.includes('Sports')));

  const mockFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('gamma-api.polymarket.com')) {
      return new Response(
        JSON.stringify([
          {
            question: 'Will the Fed cut rates in December?',
            outcomePrices: '["0.68", "0.32"]',
            oneDayPriceChange: 0.04,
            volume24hr: 1250000,
            closed: false,
            endDate: '2027-01-01T00:00:00Z'
          }
        ]),
        { status: 200 }
      );
    }
    if (url.includes('api.hyperliquid.xyz/info')) {
      return new Response(
        JSON.stringify([
          { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
          [
            { markPx: '95200.5', funding: '0.0006', openInterest: '41000', dayNtlVlm: '950000000' },
            { markPx: '3420.1', funding: '0.0001', openInterest: '180000', dayNtlVlm: '420000000' }
          ]
        ]),
        { status: 200 }
      );
    }
    return new Response(mockRss, { status: 200 });
  }) as typeof fetch;

  const brief = await buildFifteenSecondBrief({
    nowMs: Date.UTC(2026, 2, 18, 14, 0, 0),
    polymarketSlugs: ['fed-cut-december'],
    hyperliquidCoins: ['BTC', 'ETH'],
    rssSources: [{ url: 'https://feeds.reuters.com/test.xml', label: 'Reuters', keywords: ['FOMC', 'CPI'] }],
    fetchFn: mockFetch
  });
  assert.equal(brief.polymarket[0]?.yesProbabilityPct, 68);
  assert.equal(brief.polymarket[0]?.expiredOrSettled, false);
  assert.equal(brief.hyperliquid[0]?.coin, 'BTC');
  assert.equal(brief.hyperliquid[0]?.extremeFundingAlert, true);
  assert.equal(brief.rssHighlights.length, 3);
});
