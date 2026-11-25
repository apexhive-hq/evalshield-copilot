import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  applyEodSessionRollover,
  computeDrawdownState,
  evaluateRiskCheck,
  evaluateSessionQuality,
  getContractSpec,
  getMaxAllowedAccounts,
  isGlobexClosedUtc,
  normalizeSymbolRoot,
  PROP_FIRM_PRESETS,
  TOKEN_PREFIX,
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

  // Tampered payload rejected
  const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, tier: 'team' }), 'utf8').toString('base64url');
  const bad = verifyEvalShieldLicenseToken(`${TOKEN_PREFIX}${tamperedPayload}.${sigB64}`, {
    publicKeySpkiB64: spkiB64
  });
  assert.equal(bad.valid, false);
  assert.equal(getMaxAllowedAccounts(bad), 1);
});
