import { createPublicKey, verify as nodeEd25519Verify } from 'node:crypto';
import type { Tier } from './tx-lock-do.ts';

export interface CloudEnvLike {
  TOKEN_PREFIX?: string;
  LICENSE_SIGNING_PUBLIC_SPKI_B64?: string;
  LICENSES_KV?: KVNamespace;
}

export interface ProLicensePayload {
  v: 1;
  product: 'evalshield-copilot';
  tier: Tier;
  maxAccounts: number | null;
  payer: string;
  txHash: string;
  issuedAt: number;
  expiresAt: number | null;
}

export type CloudAuthResult =
  | { provided: false; authenticated: false }
  | {
      provided: true;
      authenticated: false;
      status: 401 | 403 | 500;
      error: string;
      message: string;
    }
  | {
      provided: true;
      authenticated: true;
      tier: Tier;
      payload: ProLicensePayload;
      kvClaimed: boolean;
    };

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const ALLOWED_RELAY_HOSTS = new Set(['discord.com', 'discordapp.com', 'api.telegram.org']);

function base64UrlToUint8Array(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9\-_]+$/.test(input)) return null;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  try {
    const raw = atob(padded);
    const buf = new ArrayBuffer(raw.length);
    const out = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i += 1) {
      out[i] = raw.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const raw = atob(b64.trim());
    const buf = new ArrayBuffer(raw.length);
    const out = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i += 1) {
      out[i] = raw.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

async function verifyEd25519Signature(
  spkiB64: string,
  signingInput: Uint8Array<ArrayBuffer>,
  sigBytes: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  try {
    const spkiBytes = base64ToUint8Array(spkiB64);
    if (!spkiBytes) return false;
    const key = await crypto.subtle.importKey('spki', spkiBytes, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sigBytes, signingInput);
  } catch {
    try {
      const pubKey = createPublicKey({
        key: Buffer.from(spkiB64.trim(), 'base64'),
        format: 'der',
        type: 'spki'
      });
      return nodeEd25519Verify(null, Buffer.from(signingInput), pubKey, Buffer.from(sigBytes));
    } catch {
      return false;
    }
  }
}

export function extractBearerOrLicenseToken(headers: Headers): string | null {
  const auth = headers.get('authorization')?.trim();
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1]) return match[1].trim();
  }
  const lic = headers.get('x-evalshield-license')?.trim();
  return lic || null;
}

/**
 * Cryptographically authenticates Hosted Cloud Pro API requests using ONLY the public SPKI key
 * (zero private signing material is ever stored in verification paths).
 */
export async function authenticateCloudProRequest(
  headers: Headers,
  env: CloudEnvLike
): Promise<CloudAuthResult> {
  const token = extractBearerOrLicenseToken(headers);
  if (!token) {
    return { provided: false, authenticated: false };
  }

  const spkiB64 = env.LICENSE_SIGNING_PUBLIC_SPKI_B64?.trim();
  if (!spkiB64) {
    return {
      provided: true,
      authenticated: false,
      status: 500,
      error: 'SERVER_MISCONFIGURED',
      message: 'LICENSE_SIGNING_PUBLIC_SPKI_B64 is required to verify Cloud Pro API entitlements.'
    };
  }

  const prefix = env.TOKEN_PREFIX || 'EVALSHIELD-PRO-v1.';
  if (!token.startsWith(prefix)) {
    return {
      provided: true,
      authenticated: false,
      status: 403,
      error: 'INVALID_PRO_TOKEN',
      message: `Expected token starting with ${prefix}`
    };
  }

  const parts = token.slice(prefix.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return {
      provided: true,
      authenticated: false,
      status: 403,
      error: 'INVALID_PRO_TOKEN',
      message: 'Malformed token structure.'
    };
  }

  const [payloadB64Url, sigB64Url] = parts;
  const payloadBytes = base64UrlToUint8Array(payloadB64Url);
  const sigBytes = base64UrlToUint8Array(sigB64Url);
  if (!payloadBytes || !sigBytes) {
    return {
      provided: true,
      authenticated: false,
      status: 403,
      error: 'INVALID_PRO_TOKEN',
      message: 'Invalid base64url encoding in token.'
    };
  }

  const rawInput = new TextEncoder().encode(`${prefix}${payloadB64Url}`);
  const signingInput = new Uint8Array(new ArrayBuffer(rawInput.byteLength));
  signingInput.set(rawInput);
  const sigValid = await verifyEd25519Signature(spkiB64, signingInput, sigBytes);
  if (!sigValid) {
    return {
      provided: true,
      authenticated: false,
      status: 403,
      error: 'INVALID_PRO_TOKEN',
      message: 'Invalid Ed25519 signature.'
    };
  }

  let parsed: Partial<ProLicensePayload>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<ProLicensePayload>;
  } catch {
    return {
      provided: true,
      authenticated: false,
      status: 403,
      error: 'INVALID_PRO_TOKEN',
      message: 'Token payload is not valid JSON.'
    };
  }

  if (
    parsed.v !== 1 ||
    parsed.product !== 'evalshield-copilot' ||
    (parsed.tier !== 'solo' && parsed.tier !== 'team' && parsed.tier !== 'enterprise') ||
    typeof parsed.payer !== 'string' ||
    !ADDR_RE.test(parsed.payer) ||
    typeof parsed.txHash !== 'string' ||
    !TX_RE.test(parsed.txHash) ||
    typeof parsed.issuedAt !== 'number' ||
    !Number.isFinite(parsed.issuedAt) ||
    (parsed.expiresAt !== null && (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)))
  ) {
    return {
      provided: true,
      authenticated: false,
      status: 403,
      error: 'INVALID_PRO_TOKEN',
      message: 'Token payload failed entitlement schema validation.'
    };
  }

  if (parsed.expiresAt !== null && Date.now() > parsed.expiresAt) {
    return {
      provided: true,
      authenticated: false,
      status: 403,
      error: 'PRO_TOKEN_EXPIRED',
      message: 'Pro API entitlement token has expired.'
    };
  }

  const txLower = parsed.txHash.toLowerCase();
  let kvClaimed = false;
  if (env.LICENSES_KV) {
    const revoked = await env.LICENSES_KV.get(`revoked_tx:${txLower}`);
    if (revoked) {
      return {
        provided: true,
        authenticated: false,
        status: 403,
        error: 'PRO_TOKEN_REVOKED',
        message: 'Entitlement has been revoked.'
      };
    }
    kvClaimed = Boolean(await env.LICENSES_KV.get(`claimed_tx:${txLower}`));
  }

  return {
    provided: true,
    authenticated: true,
    tier: parsed.tier,
    payload: {
      v: 1,
      product: 'evalshield-copilot',
      tier: parsed.tier,
      maxAccounts: parsed.maxAccounts ?? (parsed.tier === 'solo' ? 20 : null),
      payer: parsed.payer,
      txHash: txLower,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt
    },
    kvClaimed
  };
}

const CME_BLACKOUT_EVENTS = [
  {
    id: 'us-cpi-dec-2026',
    name: 'US CPI & Core CPI Release (BLS)',
    category: 'INFLATION',
    impact: 'HIGH',
    scheduledUtc: '2026-12-10T13:30:00Z',
    bufferMinutesBefore: 15,
    bufferMinutesAfter: 15,
    sizeMultiplierDuringWindow: 0,
    affectedContracts: ['ES', 'MES', 'NQ', 'MNQ', 'GC', 'MGC'],
    rationale: 'Topstep/Apex slippage protection during Tier-1 BLS inflation prints.'
  },
  {
    id: 'fomc-rate-dec-2026',
    name: 'FOMC Rate Decision & Press Conference (Federal Reserve)',
    category: 'CENTRAL_BANK',
    impact: 'EXTREME',
    scheduledUtc: '2026-12-16T19:00:00Z',
    bufferMinutesBefore: 20,
    bufferMinutesAfter: 35,
    sizeMultiplierDuringWindow: 0,
    affectedContracts: ['ES', 'MES', 'NQ', 'MNQ', 'GC', 'MGC', 'CL', 'MCL'],
    rationale: 'FOMC dot-plot + Powell Q&A regularly triggers multi-handle spread widening.'
  },
  {
    id: 'us-pce-dec-2026',
    name: 'US Core PCE Price Index (BEA)',
    category: 'INFLATION',
    impact: 'HIGH',
    scheduledUtc: '2026-12-23T13:30:00Z',
    bufferMinutesBefore: 10,
    bufferMinutesAfter: 15,
    sizeMultiplierDuringWindow: 0.5,
    affectedContracts: ['ES', 'MES', 'NQ', 'MNQ', 'GC', 'MGC'],
    rationale: 'Fed-preferred inflation gauge ahead of holiday liquidity thinning.'
  },
  {
    id: 'us-nfp-jan-2027',
    name: 'US Non-Farm Payrolls & Unemployment Rate (BLS)',
    category: 'LABOR',
    impact: 'HIGH',
    scheduledUtc: '2027-01-08T13:30:00Z',
    bufferMinutesBefore: 15,
    bufferMinutesAfter: 15,
    sizeMultiplierDuringWindow: 0,
    affectedContracts: ['ES', 'MES', 'NQ', 'MNQ', 'GC', 'MGC'],
    rationale: 'High-slippage 08:30 ET release; enforces flat or micro-only caution.'
  },
  {
    id: 'cme-daily-maint',
    name: 'CME Globex Daily Settlement & Maintenance Break',
    category: 'SESSION',
    impact: 'MANDATORY_FLAT',
    recurringEtWindow: '17:00-18:00 America/New_York',
    bufferMinutesBefore: 5,
    bufferMinutesAfter: 2,
    sizeMultiplierDuringWindow: 0,
    affectedContracts: ['ES', 'MES', 'NQ', 'MNQ', 'GC', 'MGC', 'CL', 'MCL'],
    rationale: 'Prop firm EOD rules require zero open positions across the 17:00 ET close.'
  }
];

export function buildBlackoutCalendarResponse(auth: CloudAuthResult) {
  return {
    ok: true,
    openAccess: true,
    licenseModel: 'WinRAR Dual (Solo $0 Full 300-pt)',
    authenticated: auth.authenticated,
    tier: auth.authenticated ? auth.tier : 'solo_free_300pt',
    kvClaimed: auth.authenticated ? auth.kvClaimed : false,
    schemaVersion: '2026.11.v3',
    generatedAtUtc: new Date().toISOString(),
    cmeMaintenanceDailyEt: '17:00-18:00 America/New_York',
    usEuDstNote: 'Verify 1-hour London/NY overlap shifts during March & Oct/Nov US/EU DST mismatch weeks.',
    newsPolicyDistinction: {
      ftmo: 'STRICT_ALL_ORDERS_BAN (±2m including resting SL/TP)',
      mffu: 'FUNDED_ONLY_BAN (±5m on Funded, Eval exempt)',
      topstepAndTradeify: 'EXEMPT (slippage advisory only)'
    },
    volatilityRules: {
      atrExpansionStandDownRatio: 2.0,
      atrExpansionMultiplier: 0.5,
      consecLossTiltLimit: 3,
      tiltCooldownMinutes: 15
    },
    events: CME_BLACKOUT_EVENTS
  };
}

const CANONICAL_PROP_PRESETS = [
  {
    id: 'topstep_50k',
    label: 'Topstep $50K Trading Combine (EOD)',
    firm: 'Topstep',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: 1_000,
    lockCap: 50_000,
    maxContractsCap: 5,
    consistencyCap: 0.5,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT'
  },
  {
    id: 'topstep_150k',
    label: 'Topstep $150K Trading Combine (EOD)',
    firm: 'Topstep',
    startingBalance: 150_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 4_500,
    dailyLossLimit: 3_000,
    lockCap: 150_000,
    maxContractsCap: 15,
    consistencyCap: 0.5,
    profitTarget: 9_000,
    newsRestriction: 'EXEMPT'
  },
  {
    id: 'apex_50k_intraday',
    label: 'Apex $50K Evaluation (Intraday Trailing)',
    firm: 'Apex Trader Funding',
    startingBalance: 50_000,
    drawdownMode: 'INTRADAY_TRAILING',
    maxDrawdown: 2_500,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 10,
    consistencyCap: 0.3,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT'
  },
  {
    id: 'apex_50k_eod',
    label: 'Apex $50K Evaluation (EOD)',
    firm: 'Apex Trader Funding',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_500,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 10,
    consistencyCap: 0.3,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT'
  },
  {
    id: 'mffu_50k_starter',
    label: 'MyFundedFutures $50K Starter (EOD / Funded ±5m)',
    firm: 'MyFundedFutures',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 5,
    consistencyCap: 0.5,
    profitTarget: 3_000,
    newsRestriction: 'FUNDED_ONLY_BAN'
  },
  {
    id: 'ftmo_100k_2step',
    label: 'FTMO $100K 2-Step (Static DD / Strict ±2m)',
    firm: 'FTMO',
    startingBalance: 100_000,
    drawdownMode: 'STATIC',
    maxDrawdown: 10_000,
    dailyLossLimit: 5_000,
    lockCap: null,
    maxContractsCap: 50,
    consistencyCap: 1.0,
    profitTarget: 10_000,
    newsRestriction: 'STRICT_ALL_ORDERS_BAN',
    antiHedgingBanned: true
  },
  {
    id: 'ftmo_100k_1step',
    label: 'FTMO $100K 1-Step (50% Cons / Strict ±2m)',
    firm: 'FTMO',
    startingBalance: 100_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 10_000,
    dailyLossLimit: 3_000,
    lockCap: null,
    maxContractsCap: 50,
    consistencyCap: 0.5,
    profitTarget: 10_000,
    newsRestriction: 'STRICT_ALL_ORDERS_BAN',
    antiHedgingBanned: true
  },
  {
    id: 'tradeify_50k_growth',
    label: 'Tradeify $50K Growth (35% Cons / Anti-Hedge)',
    firm: 'Tradeify',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 5,
    consistencyCap: 0.35,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    antiHedgingBanned: true
  },
  {
    id: 'tradeify_50k_straight',
    label: 'Tradeify $50K Straight to Funded (20% Cons)',
    firm: 'Tradeify',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 5,
    consistencyCap: 0.2,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    antiHedgingBanned: true
  }
];

export function buildCloudPresetsResponse(auth: CloudAuthResult) {
  return {
    ok: true,
    openAccess: true,
    schemaVersion: '2026.11.v3',
    updatedAtUtc: '2026-11-26T00:00:00Z',
    authenticated: auth.authenticated,
    tier: auth.authenticated ? auth.tier : 'solo_free_300pt',
    orderRoutingEnabled: false,
    presets: CANONICAL_PROP_PRESETS,
    proRiskMultipliers: {
      softDllAlpha: 0.8,
      amberCautionThresholdPct: 0.5,
      redLockoutThresholdPct: 0.2,
      amberSizeScale: 0.5,
      consistencyWarningPct: 0.85
    },
    deskTemplates: {
      maxConcurrentEvalsPerTrader: 20,
      deskMaxDailyLossPct: 0.65,
      mandatoryFlatWindowEt: '16:50-18:00'
    }
  };
}

export interface MonteCarloResultPayload {
  ok: true;
  tier: Tier;
  runs: number;
  accountsSimulated: number;
  drawdownMode: 'EOD_TRAILING' | 'INTRADAY_TRAILING' | 'STATIC';
  passProbabilityPct: number;
  ruinProbabilityPct: number;
  timeoutProbabilityPct: number;
  expectedValuePerTradeUsd: number;
  medianTradesToResolve: number;
  fundedHeadroomUsd: {
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
  };
  maxDrawdownPercentilesUsd: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
  };
  recommendedMaxRiskUsd: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return Math.round(sorted[idx]! * 100) / 100;
}

export function runServerMonteCarlo(
  rawBody: Record<string, unknown>,
  tier: Tier
): { ok: true; data: MonteCarloResultPayload } | { ok: false; error: string; message: string } {
  const runsRaw = rawBody.runs === undefined ? 10_000 : Number(rawBody.runs);
  const accountsRaw = rawBody.accounts === undefined ? 1 : Number(rawBody.accounts);
  const winRateRaw = rawBody.winRate === undefined ? 0.48 : Number(rawBody.winRate);
  const rrRaw = rawBody.rewardRiskRatio === undefined ? 1.6 : Number(rawBody.rewardRiskRatio);
  const riskRaw = rawBody.riskPerTradeUsd === undefined ? 250 : Number(rawBody.riskPerTradeUsd);
  const targetRaw = rawBody.profitTargetUsd === undefined ? 3000 : Number(rawBody.profitTargetUsd);
  const ddMaxRaw = rawBody.maxDrawdownUsd === undefined ? 2000 : Number(rawBody.maxDrawdownUsd);
  const maxTradesRaw = rawBody.maxTradesPerEval === undefined ? 250 : Number(rawBody.maxTradesPerEval);
  const modeRaw = String(rawBody.drawdownMode ?? 'EOD_TRAILING').toUpperCase();
  const seedRaw = rawBody.seed === undefined ? 0x9e3779b9 : Number(rawBody.seed);

  if (
    !Number.isFinite(runsRaw) ||
    !Number.isFinite(accountsRaw) ||
    !Number.isFinite(winRateRaw) ||
    !Number.isFinite(rrRaw) ||
    !Number.isFinite(riskRaw) ||
    !Number.isFinite(targetRaw) ||
    !Number.isFinite(ddMaxRaw) ||
    !Number.isFinite(maxTradesRaw) ||
    !Number.isFinite(seedRaw)
  ) {
    return { ok: false, error: 'INVALID_PARAMS', message: 'Simulation parameters must be finite numbers.' };
  }

  const runs = Math.min(25_000, Math.max(500, Math.trunc(runsRaw)));
  const maxTierAccounts = 100;
  const accounts = Math.min(maxTierAccounts, Math.max(1, Math.trunc(accountsRaw)));
  const winRate = winRateRaw > 1 && winRateRaw <= 95 ? winRateRaw / 100 : winRateRaw;
  if (winRate < 0.05 || winRate > 0.95) {
    return { ok: false, error: 'INVALID_PARAMS', message: 'winRate must be in [0.05, 0.95] or [5, 95].' };
  }
  const rr = Math.min(20, Math.max(0.2, rrRaw));
  const risk = Math.min(50_000, Math.max(10, riskRaw));
  const target = Math.min(100_000, Math.max(100, targetRaw));
  const ddMax = Math.min(100_000, Math.max(100, ddMaxRaw));
  const maxTrades = Math.min(500, Math.max(20, Math.trunc(maxTradesRaw)));
  const drawdownMode =
    modeRaw === 'INTRADAY_TRAILING' || modeRaw === 'STATIC' ? modeRaw : 'EOD_TRAILING';

  let empirical: number[] | null = null;
  if (rawBody.empiricalPnls !== undefined) {
    if (!Array.isArray(rawBody.empiricalPnls) || rawBody.empiricalPnls.length > 1000) {
      return { ok: false, error: 'INVALID_PARAMS', message: 'empiricalPnls must be <= 1000 numbers.' };
    }
    const clean: number[] = [];
    for (const v of rawBody.empiricalPnls) {
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > 100_000) {
        return { ok: false, error: 'INVALID_PARAMS', message: 'All empiricalPnls entries must be finite.' };
      }
      clean.push(n);
    }
    if (clean.length >= 5) empirical = clean;
  }

  let seed = (Math.trunc(seedRaw) >>> 0) || 0x9e3779b9;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  let passed = 0;
  let ruined = 0;
  let timedOut = 0;
  const tradeCounts: number[] = [];
  const headrooms: number[] = [];
  const maxDrawdowns: number[] = [];
  const portfolioScale = accounts > 1 ? 1 / Math.sqrt(accounts) : 1;
  const intradayExcursionPenalty = drawdownMode === 'INTRADAY_TRAILING' ? 0.15 * risk : 0;

  for (let i = 0; i < runs; i += 1) {
    let eq = 0;
    let peak = 0;
    let worstDd = 0;
    let t = 0;
    let status: 'pass' | 'ruin' | 'timeout' = 'timeout';

    while (t < maxTrades) {
      t += 1;
      let stepPnl = empirical
        ? empirical[Math.floor(nextRand() * empirical.length)]!
        : nextRand() < winRate
          ? risk * rr
          : -risk;
      if (accounts > 1) {
        stepPnl = stepPnl * portfolioScale;
      }

      if (drawdownMode === 'INTRADAY_TRAILING' && stepPnl > 0) {
        const intrabarPeak = Math.max(peak, eq + stepPnl + intradayExcursionPenalty);
        peak = intrabarPeak;
      }

      eq += stepPnl;
      if (drawdownMode !== 'STATIC' && eq > peak) {
        peak = eq;
      }
      const floor = drawdownMode === 'STATIC' ? -ddMax : peak - ddMax;
      const curDd = Math.max(0, (drawdownMode === 'STATIC' ? 0 : peak) - eq);
      if (curDd > worstDd) worstDd = curDd;

      if (eq >= target) {
        status = 'pass';
        break;
      }
      if (eq <= floor) {
        status = 'ruin';
        break;
      }
    }

    if (status === 'pass') passed += 1;
    else if (status === 'ruin') ruined += 1;
    else timedOut += 1;

    tradeCounts.push(t);
    const finalFloor = drawdownMode === 'STATIC' ? -ddMax : peak - ddMax;
    headrooms.push(Math.max(0, eq - finalFloor));
    maxDrawdowns.push(worstDd);
  }

  tradeCounts.sort((a, b) => a - b);
  headrooms.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const evPerTrade = empirical
    ? empirical.reduce((sum, x) => sum + x, 0) / empirical.length
    : winRate * (risk * rr) - (1 - winRate) * risk;
  const safeMaxRiskUsd = Math.max(25, Math.round(Math.min(risk, ddMax / 8)));

  return {
    ok: true,
    data: {
      ok: true,
      tier,
      runs,
      accountsSimulated: accounts,
      drawdownMode,
      passProbabilityPct: Math.round((passed / runs) * 1000) / 10,
      ruinProbabilityPct: Math.round((ruined / runs) * 1000) / 10,
      timeoutProbabilityPct: Math.round((timedOut / runs) * 1000) / 10,
      expectedValuePerTradeUsd: Math.round(evPerTrade * 100) / 100,
      medianTradesToResolve: tradeCounts[Math.floor(tradeCounts.length / 2)] ?? 0,
      fundedHeadroomUsd: {
        p10: percentile(headrooms, 0.1),
        p25: percentile(headrooms, 0.25),
        median: percentile(headrooms, 0.5),
        p75: percentile(headrooms, 0.75),
        p90: percentile(headrooms, 0.9)
      },
      maxDrawdownPercentilesUsd: {
        p50: percentile(maxDrawdowns, 0.5),
        p75: percentile(maxDrawdowns, 0.75),
        p90: percentile(maxDrawdowns, 0.9),
        p95: percentile(maxDrawdowns, 0.95),
        p99: percentile(maxDrawdowns, 0.99)
      },
      recommendedMaxRiskUsd: safeMaxRiskUsd
    }
  };
}

function escapeTelegramHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function validateRelayWebhookUrl(rawUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443') return null;

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_RELAY_HOSTS.has(host)) return null;

  if (host === 'api.telegram.org') {
    if (!/^\/bot[A-Za-z0-9:_-]+\/sendMessage$/.test(parsed.pathname)) return null;
  } else {
    if (!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(parsed.pathname)) return null;
  }
  return parsed;
}

export async function processCloudRelayAlert(
  rawBody: Record<string, unknown>,
  tier: Tier
): Promise<{ status: number; body: Record<string, unknown> }> {
  const alertType = String(rawBody.alertType ?? '').trim().toUpperCase();
  if (
    alertType !== 'TILT_LOCKOUT' &&
    alertType !== 'DLL_WARNING' &&
    alertType !== 'BUFFER_CAUTION' &&
    alertType !== 'CONSISTENCY_WARNING'
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'INVALID_ALERT_TYPE',
        message: 'alertType must be TILT_LOCKOUT, DLL_WARNING, BUFFER_CAUTION, or CONSISTENCY_WARNING.'
      }
    };
  }

  const accountName = String(rawBody.accountName ?? 'Primary Eval Account').slice(0, 80);
  const symbol = String(rawBody.symbol ?? 'ES').slice(0, 16);
  const remainingBufferUsd = Number(rawBody.remainingBufferUsd ?? 0);
  const maxContractsAllowed = Number(rawBody.maxContractsAllowed ?? 0);
  const consecutiveLosses = Number(rawBody.consecutiveLosses ?? 0);
  const detail = String(rawBody.message ?? 'Risk threshold triggered. Stay flat until buffer resets.').slice(0, 400);
  const dryRun = rawBody.dryRun === undefined ? true : Boolean(rawBody.dryRun);

  if (
    !Number.isFinite(remainingBufferUsd) ||
    !Number.isFinite(maxContractsAllowed) ||
    !Number.isFinite(consecutiveLosses)
  ) {
    return {
      status: 400,
      body: { ok: false, error: 'INVALID_PARAMS', message: 'Numeric alert metrics must be finite.' }
    };
  }

  let validatedTarget: URL | null = null;
  if (rawBody.webhookUrl !== undefined && String(rawBody.webhookUrl).trim() !== '') {
    validatedTarget = validateRelayWebhookUrl(String(rawBody.webhookUrl));
    if (!validatedTarget) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'INVALID_WEBHOOK_TARGET',
          message:
            'webhookUrl must be HTTPS on discord.com/api/webhooks/... or api.telegram.org/bot.../sendMessage (private/local/IP targets blocked).'
        }
      };
    }
  } else if (!dryRun) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'MISSING_WEBHOOK_URL',
        message: 'webhookUrl is required when dryRun is false.'
      }
    };
  }

  const color = alertType === 'TILT_LOCKOUT' ? 0xef4444 : alertType === 'DLL_WARNING' ? 0xf59e0b : 0x38bdf8;
  const discordPayload = {
    username: 'EvalShield Cloud Co-Pilot (Read-Only)',
    embeds: [
      {
        title: `[${alertType}] ${accountName} (${symbol})`,
        description: detail,
        color,
        fields: [
          { name: 'Remaining Buffer', value: `$${Math.round(remainingBufferUsd).toLocaleString()}`, inline: true },
          { name: 'Max Contracts Allowed', value: `${Math.max(0, Math.trunc(maxContractsAllowed))} ${symbol}`, inline: true },
          { name: 'Consecutive Losses', value: String(Math.max(0, Math.trunc(consecutiveLosses))), inline: true }
        ],
        footer: { text: `Read-Only Risk Advisory • Tier=${tier} • Zero Order Routing` },
        timestamp: new Date().toISOString()
      }
    ]
  };

  const telegramChatId = String(rawBody.telegramChatId ?? '').trim().slice(0, 64);
  const telegramPayload = {
    ...(telegramChatId ? { chat_id: telegramChatId } : {}),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      `<b>[EvalShield Cloud ${escapeTelegramHtml(alertType)}]</b>\n` +
      `Account: <code>${escapeTelegramHtml(accountName)}</code> (${escapeTelegramHtml(symbol)})\n` +
      `Remaining Buffer: <b>$${Math.round(remainingBufferUsd).toLocaleString()}</b> | Max Contracts: <b>${Math.max(0, Math.trunc(maxContractsAllowed))}</b>\n` +
      `Consec. Losses: ${Math.max(0, Math.trunc(consecutiveLosses))}\n` +
      `${escapeTelegramHtml(detail)}`
  };

  let dispatchResult: { dispatched: boolean; remoteStatus?: number } = { dispatched: false };
  if (!dryRun && validatedTarget) {
    const isTelegram = validatedTarget.hostname.toLowerCase() === 'api.telegram.org';
    const outboundBody = isTelegram ? telegramPayload : discordPayload;
    try {
      const upstream = await fetch(validatedTarget.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(outboundBody),
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      });
      dispatchResult = { dispatched: upstream.ok, remoteStatus: upstream.status };
    } catch (err) {
      return {
        status: 502,
        body: {
          ok: false,
          error: 'RELAY_DISPATCH_FAILED',
          message: err instanceof Error ? err.message : 'Relay upstream error'
        }
      };
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      dryRun,
      tier,
      orderRoutingEnabled: false,
      targetHost: validatedTarget ? validatedTarget.hostname : null,
      dispatchResult,
      discordPayload,
      telegramPayload
    }
  };
}

export async function buildPublicCloudBrief(
  options?: { slugs?: string[]; coins?: string[]; nowMs?: number; fetchFn?: typeof fetch }
): Promise<Record<string, unknown>> {
  const fetchFn = options?.fetchFn ?? fetch;
  const nowMs = options?.nowMs ?? Date.now();
  const coins = options?.coins && options.coins.length > 0 ? options.coins : ['BTC', 'ETH', 'SOL'];
  const slugs = (options?.slugs ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const warnings: string[] = [];

  // Check US/EU DST mismatch (America/New_York vs Europe/Berlin)
  const fmtOffset = (tz: string) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(nowMs));
    const map = new Map(parts.map((p) => [p.type, p.value]));
    const hr = Number(map.get('hour') ?? '0');
    const localMs = Date.UTC(
      Number(map.get('year') ?? '1970'),
      Number(map.get('month') ?? '1') - 1,
      Number(map.get('day') ?? '1'),
      hr === 24 ? 0 : hr,
      Number(map.get('minute') ?? '0'),
      0
    );
    return Math.round((localMs - Math.floor(nowMs / 60_000) * 60_000) / 60_000);
  };
  const diffHours = Math.round(((fmtOffset('Europe/Berlin') - fmtOffset('America/New_York')) / 60) * 10) / 10;
  const dstMismatchActive = Math.abs(diffHours - 6) > 0.05;

  const hyperliquid: Array<Record<string, unknown>> = [];
  try {
    const hlRes = await fetchFn('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'EvalShield-Cloud/3.0' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(3500)
    });
    if (hlRes.ok) {
      const data = (await hlRes.json()) as [
        { universe?: Array<{ name?: string }> },
        Array<{ markPx?: string; funding?: string; openInterest?: string }>
      ];
      const wanted = new Set(coins.map((c) => c.toUpperCase()));
      const uni = data?.[0]?.universe ?? [];
      const ctxs = data?.[1] ?? [];
      for (let i = 0; i < uni.length; i += 1) {
        const c = uni[i]?.name?.toUpperCase();
        if (!c || !wanted.has(c)) continue;
        const row = ctxs[i] ?? {};
        const hourlyFunding = Number(row.funding ?? 0);
        hyperliquid.push({
          coin: c,
          markPx: Number(row.markPx ?? 0),
          hourlyFundingRate: hourlyFunding,
          annualizedFundingPct: Math.round(hourlyFunding * 24 * 365 * 10000) / 100,
          openInterest: Number(row.openInterest ?? 0),
          extremeFundingAlert: Math.abs(hourlyFunding) >= 0.0005
        });
      }
    } else {
      warnings.push(`Hyperliquid HTTP ${hlRes.status}`);
    }
  } catch (err) {
    warnings.push(`Hyperliquid error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const polymarket: Array<Record<string, unknown>> = [];
  if (slugs.length > 0) {
    for (const slug of slugs) {
      try {
        const pRes = await fetchFn(
          `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
          { headers: { accept: 'application/json', 'user-agent': 'EvalShield-Cloud/3.0.1' }, signal: AbortSignal.timeout(3500) }
        );
        if (pRes.ok) {
          const rows = (await pRes.json()) as Array<Record<string, unknown>>;
          const m = rows?.[0];
          if (m) {
            const rawP = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
            const yesPct = Array.isArray(rawP) && rawP[0] !== undefined ? Math.round(Number(rawP[0]) * 1000) / 10 : null;
            polymarket.push({
              slug,
              question: String(m.question ?? slug),
              yesProbabilityPct: yesPct,
              closed: Boolean(m.closed),
              endDate: m.endDate ?? null
            });
          }
        }
      } catch (err) {
        warnings.push(`Polymarket "${slug}" error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    try {
      const pRes = await fetchFn(
        'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=3&order=volume24hr&ascending=false',
        { headers: { accept: 'application/json', 'user-agent': 'EvalShield-Cloud/3.0.1' }, signal: AbortSignal.timeout(3500) }
      );
      if (pRes.ok) {
        const rows = (await pRes.json()) as Array<Record<string, unknown>>;
        for (const m of (Array.isArray(rows) ? rows : []).slice(0, 3)) {
          const rawP = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          const yesPct = Array.isArray(rawP) && rawP[0] !== undefined ? Math.round(Number(rawP[0]) * 1000) / 10 : null;
          polymarket.push({
            slug: String(m.slug ?? m.id ?? 'market'),
            question: String(m.question ?? m.slug ?? 'Active Market'),
            yesProbabilityPct: yesPct,
            volume24hUsd: Number.isFinite(Number(m.volume24hr)) ? Math.round(Number(m.volume24hr)) : null,
            closed: Boolean(m.closed),
            endDate: m.endDate ?? null
          });
        }
      } else {
        warnings.push(`Polymarket discovery HTTP ${pRes.status}`);
      }
    } catch (err) {
      warnings.push(`Polymarket discovery error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: true,
    openAccess: true,
    schemaVersion: '2026.11.v3',
    generatedAtUtc: new Date(nowMs).toISOString(),
    usEuDstMismatchActive: dstMismatchActive,
    nyToBerlinDiffHours: diffHours,
    rolloverAdvisory:
      'Watch 17:00 ET New York rollover spread widening on XAUUSD/FX; check spread/SL ratio >= 25%.',
    hyperliquid,
    polymarket,
    warnings
  };
}

const ALLOWED_PORTFOLIO_KEYS = new Set([
  'accountId',
  'accountName',
  'symbol',
  'side',
  'qty',
  'riskUsd',
  'antiHedgingBanned'
]);

export function evaluatePublicPortfolioGuard(rawBody: Record<string, unknown>): {
  ok: true;
  safeToProceed: boolean;
  correlatedBuckets: Record<string, { signedLots: number; grossLots: number; accounts: number }>;
  alerts: Array<{ code: string; severity: string; message: string; accounts: string[] }>;
} | { ok: false; error: string; message: string } {
  const rawPositions = rawBody.positions;
  if (!Array.isArray(rawPositions) || rawPositions.length === 0 || rawPositions.length > 100) {
    return { ok: false, error: 'INVALID_PARAMS', message: 'positions must be a non-empty array of 1..100 position objects.' };
  }
  const bucketOf = (sym: string) => {
    const s = sym.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (s === 'ES' || s === 'MES' || s === 'NQ' || s === 'MNQ') return 'US_EQUITY_INDEX';
    if (s === 'GC' || s === 'MGC' || s === 'XAUUSD') return 'GOLD_METALS';
    if (s.startsWith('BTC') || s.startsWith('ETH') || s.startsWith('SOL')) return 'CRYPTO_BETA';
    return s;
  };
  const scaleOf = (sym: string, q: number) => (['MES', 'MNQ', 'MGC', 'MCL'].includes(sym.toUpperCase()) ? q * 0.1 : q);

  const buckets: Record<string, { signedLots: number; grossLots: number; accounts: number }> = {};
  const dirs = new Map<string, { longs: Set<string>; shorts: Set<string>; accs: Set<string> }>();
  const alerts: Array<{ code: string; severity: string; message: string; accounts: string[] }> = [];

  for (let i = 0; i < rawPositions.length; i += 1) {
    const item = rawPositions[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'INVALID_PARAMS', message: `positions[${i}] must be a JSON object.` };
    }
    const p = item as Record<string, unknown>;
    for (const k of Object.keys(p)) {
      if (!ALLOWED_PORTFOLIO_KEYS.has(k)) {
        return {
          ok: false,
          error: 'INVALID_PARAMS',
          message: `positions[${i}] contains unsupported field "${k}". Expected: accountId, symbol, side (LONG|SHORT), qty.`
        };
      }
    }
    const acc = typeof p.accountId === 'string' ? p.accountId.trim() : '';
    const sym = typeof p.symbol === 'string' ? p.symbol.trim().toUpperCase() : '';
    const sideRaw = typeof p.side === 'string' ? p.side.trim().toUpperCase() : '';
    const qty = typeof p.qty === 'number' ? p.qty : Number.NaN;
    if (!acc || !sym || (sideRaw !== 'LONG' && sideRaw !== 'SHORT') || !Number.isFinite(qty) || qty <= 0) {
      return {
        ok: false,
        error: 'INVALID_PARAMS',
        message: `positions[${i}] requires valid non-empty accountId, symbol, side ('LONG' | 'SHORT'), and positive finite qty.`
      };
    }
    const side = sideRaw;
    const b = bucketOf(sym);
    const lots = scaleOf(sym, qty);
    const d = dirs.get(b) ?? { longs: new Set<string>(), shorts: new Set<string>(), accs: new Set<string>() };
    d.accs.add(acc);
    if (side === 'LONG') d.longs.add(acc);
    else d.shorts.add(acc);
    dirs.set(b, d);
    const cur = buckets[b] ?? { signedLots: 0, grossLots: 0, accounts: 0 };
    cur.signedLots = Math.round((cur.signedLots + (side === 'LONG' ? lots : -lots)) * 100) / 100;
    cur.grossLots = Math.round((cur.grossLots + lots) * 100) / 100;
    cur.accounts = d.accs.size;
    buckets[b] = cur;
  }

  for (const [b, d] of dirs.entries()) {
    if (d.longs.size > 0 && d.shorts.size > 0) {
      alerts.push({
        code: 'CROSS_ACCOUNT_ANTI_HEDGE_VIOLATION',
        severity: 'CRITICAL',
        message: `Conflicting LONG & SHORT positions in ${b} violate Tradeify/FTMO anti-hedging rules.`,
        accounts: Array.from(d.accs)
      });
    }
    const netAbs = Math.abs(buckets[b]?.signedLots ?? 0);
    if (netAbs >= 1.75 && d.accs.size >= 1 && rawPositions.filter((r) => bucketOf(String((r as Record<string, unknown>).symbol ?? '')) === b).length >= 2) {
      alerts.push({
        code: 'CORRELATED_EXPOSURE_MULTIPLIER',
        severity: netAbs >= 4 ? 'CRITICAL' : 'WARN',
        message: `Correlated basket ${b} reaches ${netAbs} equivalent full-size lots.`,
        accounts: Array.from(d.accs)
      });
    }
  }

  return {
    ok: true,
    safeToProceed: !alerts.some((a) => a.severity === 'CRITICAL'),
    correlatedBuckets: buckets,
    alerts
  };
}
