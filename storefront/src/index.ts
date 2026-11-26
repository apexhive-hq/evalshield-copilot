import { createPrivateKey, sign as nodeEd25519Sign } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  parseStrictHexBigInt,
  rpcCallWithFailover,
  sumBaseUsdcTransfers,
  verifySmartWalletOrEoaSignature,
  type RpcReceipt
} from './base-verifier.ts';
import {
  authenticateCloudProRequest,
  buildBlackoutCalendarResponse,
  buildCloudPresetsResponse,
  buildPublicCloudBrief,
  evaluatePublicPortfolioGuard,
  processCloudRelayAlert,
  runServerMonteCarlo
} from './cloud-pro.ts';
import { TxClaimLockDO, type Tier } from './tx-lock-do.ts';

export { TxClaimLockDO };

export interface TxClaimLockNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface Env {
  ASSETS: Fetcher;
  LICENSES_KV: KVNamespace;
  GLOBAL_CLAIMED_TX_KV: KVNamespace;
  TX_CLAIM_LOCK?: TxClaimLockNamespace;
  BRAND_NAME: string;
  PRODUCT_ID: string;
  TOKEN_PREFIX: string;
  PAY_TO_EVM_ADDRESS: string;
  BASE_USDC_CONTRACT: string;
  BASE_CHAIN_ID: string;
  BASE_RPC_URL: string;
  BASE_RPC_URLS?: string;
  TEAM_PRICE_USDC_ATOMIC: string;
  ENTERPRISE_PRICE_USDC_ATOMIC?: string;
  MIN_CONFIRMATIONS: string;
  CHALLENGE_TTL_SECONDS: string;
  DOWNLOAD_TTL_SECONDS: string;
  SOLANA_RECEIVE_ADDRESS: string;
  BTC_RECEIVE_ADDRESS: string;
  TRON_RECEIVE_ADDRESS: string;
  LICENSE_SIGNING_PRIVATE_JWK?: string;
  LICENSE_SIGNING_PUBLIC_SPKI_B64?: string;
  DOWNLOAD_HMAC_SECRET?: string;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
// Accepts 65-byte EOA EIP-191 signatures AND variable-length ABI-encoded ERC-1271 / EIP-6492 Smart Wallet signatures.
const SIG_RE = /^0x(?:[0-9a-fA-F]{2}){32,8192}$/;
const SCOPE_STOREFRONT = 'storefront:evalshield-copilot';
const MAX_JSON_BYTES = 32 * 1024;

const DEFAULT_BASE_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base'
];

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#080d18"/><path d="M16 4l10 4v7c0 6.2-4.3 11.4-10 13-5.7-1.6-10-6.8-10-13V8l10-4z" fill="none" stroke="#10b981" stroke-width="2.4"/><path d="M11 16l3.5 3.5L21 13" fill="none" stroke="#38bdf8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

interface ChallengeRecord {
  nonce: string;
  txHash: string;
  tier: Tier;
  ts: number;
  message: string;
}

interface GlobalClaimRecord {
  scope: string;
  payer: string;
  tier: string;
  txHash: string;
  claimedAt: number;
}

interface DownloadGrantRecord {
  txHash: string;
  payer: string;
  tier: Tier;
  remainingDownloads: number;
  createdAt: number;
  licenseToken: string;
}

function parseTier(raw: string | undefined): Tier | null {
  const t = (raw ?? '').trim();
  if (t === 'team' || t === 'enterprise') return t;
  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomHex(byteCount = 16): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

function getTierPriceAtomic(env: Env, tier: Tier): bigint {
  if (tier === 'enterprise') return BigInt(env.ENTERPRISE_PRICE_USDC_ATOMIC || '499000000');
  return BigInt(env.TEAM_PRICE_USDC_ATOMIC || '99000000');
}

function getBaseRpcUrls(env: Env): string[] {
  if (env.BASE_RPC_URLS && env.BASE_RPC_URLS.trim()) {
    const parsed = env.BASE_RPC_URLS.split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  if (env.BASE_RPC_URL && env.BASE_RPC_URL.trim()) {
    return [env.BASE_RPC_URL.trim()];
  }
  return DEFAULT_BASE_RPC_URLS;
}

async function parseBoundedJsonBody<T = Record<string, unknown>>(
  request: Request,
  maxBytes = MAX_JSON_BYTES
): Promise<
  | { ok: true; data: T }
  | { ok: false; status: 400 | 413; error: string; message: string }
> {
  const contentLen = request.headers.get('content-length');
  if (contentLen && /^\d+$/.test(contentLen) && Number(contentLen) > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: 'PAYLOAD_TOO_LARGE',
      message: `JSON payload exceeds ${maxBytes} bytes.`
    };
  }
  const rawText = await request.text();
  if (new TextEncoder().encode(rawText).byteLength > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: 'PAYLOAD_TOO_LARGE',
      message: `JSON payload exceeds ${maxBytes} bytes.`
    };
  }
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'INVALID_JSON', message: 'Expected JSON object.' };
    }
    return { ok: true, data: parsed as T };
  } catch {
    return { ok: false, status: 400, error: 'INVALID_JSON', message: 'Malformed JSON body.' };
  }
}

function buildChallengeMessage(params: {
  brand: string;
  product: string;
  tier: Tier;
  txHash: string;
  nonce: string;
  ts: number;
}): string {
  return [
    `${params.brand} EvalShield Co-Pilot Ownership Proof`,
    `product=${params.product}`,
    `tier=${params.tier}`,
    `tx=${params.txHash.toLowerCase()}`,
    `nonce=${params.nonce}`,
    `ts=${params.ts}`
  ].join('\n');
}

async function signEvalShieldLicense(
  env: Env,
  payload: {
    v: 1;
    product: string;
    tier: Tier;
    maxAccounts: number | null;
    payer: string;
    txHash: string;
    issuedAt: number;
    expiresAt: null;
  }
): Promise<string> {
  const rawJwk = env.LICENSE_SIGNING_PRIVATE_JWK!.trim().replace(/^'(.*)'$/, '$1');
  const jwk = JSON.parse(rawJwk) as JsonWebKey;
  const prefix = env.TOKEN_PREFIX || 'EVALSHIELD-PRO-v1.';
  const payloadB64Url = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${prefix}${payloadB64Url}`);

  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('Ed25519', key, signingInput);
    return `${prefix}${payloadB64Url}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
  } catch {
    const privKey = createPrivateKey({ key: jwk as Record<string, unknown>, format: 'jwk' });
    const sigBuf = nodeEd25519Sign(null, Buffer.from(signingInput), privKey);
    return `${prefix}${payloadB64Url}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
  }
}

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error(
    '[evalshield-copilot-store unhandled]',
    err instanceof Error ? err.stack || err.message : String(err)
  );
  return c.json({ error: 'INTERNAL_ERROR' }, 500);
});

const apiCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-EvalShield-License']
});

app.use('/api/*', apiCors);

app.use('*', async (c, next) => {
  await next();
  const ct = c.res.headers.get('content-type');
  if (ct && (ct.startsWith('application/json') || ct.startsWith('text/html')) && !/charset=/i.test(ct)) {
    c.res.headers.set('content-type', `${ct}; charset=utf-8`);
  }
});

app.get('/favicon.svg', () => {
  return new Response(FAVICON_SVG, {
    status: 200,
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' }
  });
});

app.get('/favicon.ico', () => {
  return new Response(FAVICON_SVG, {
    status: 200,
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' }
  });
});

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'evalshield-copilot',
    version: '3.0.1',
    licenseModel: 'WinRAR Dual Source-Available (Solo 0 USDC Full 300-pt + Early-Bird Commercial Team 99 USDC / Enterprise 499 USDC)',
    readOnlyFirewall: true,
    kvBound: Boolean(c.env.LICENSES_KV),
    globalReplayGuardBound: Boolean(c.env.GLOBAL_CLAIMED_TX_KV),
    durableObjectLockBound: Boolean(c.env.TX_CLAIM_LOCK),
    smartWalletSupport: ['EOA', 'ERC-1271', 'EIP-6492'],
    publicSandboxEndpoints: [
      '/api/cloud/blackout-calendar',
      '/api/cloud/presets',
      '/api/cloud/monte-carlo',
      '/api/cloud/brief',
      '/api/cloud/portfolio-guard',
      '/api/cloud/relay/alert'
    ]
  });
});

app.get('/api/config', (c) => {
  return c.json({
    brand: c.env.BRAND_NAME || 'ApexHive Labs',
    productId: c.env.PRODUCT_ID || 'evalshield-copilot',
    version: '3.0.1',
    tokenPrefix: c.env.TOKEN_PREFIX || 'EVALSHIELD-PRO-v1.',
    licensePublicKeySpkiB64: c.env.LICENSE_SIGNING_PUBLIC_SPKI_B64 || null,
    supportEmail: 'apexhive.hq@proton.me',
    chainId: Number(c.env.BASE_CHAIN_ID || '8453'),
    usdcContract: c.env.BASE_USDC_CONTRACT,
    payToEvmAddress: c.env.PAY_TO_EVM_ADDRESS,
    minConfirmations: Number(c.env.MIN_CONFIRMATIONS || '2'),
    smartWalletSupport: ['EOA', 'ERC-1271', 'EIP-6492'],
    tiers: {
      solo: {
        priceUsd: '0',
        seats: '1 natural person',
        maxAccounts: null,
        license: 'WinRAR Full-Open 300-pt Solo Edition (Forever Free, Self-Host BYO Cloud Kit Included)'
      },
      team: {
        priceAtomic: c.env.TEAM_PRICE_USDC_ATOMIC || '99000000',
        priceUsd: '99.00',
        seats: '2-99 seats',
        pricingLabel: 'Founder Early-Bird',
        maxAccounts: null,
        cloudQuota: 'Commercial Team Desk License (2-99 seats + Hosted Outbound Telegram/Discord Alert Relay)'
      },
      enterprise: {
        priceAtomic: c.env.ENTERPRISE_PRICE_USDC_ATOMIC || '499000000',
        priceUsd: '499.00',
        seats: '100+ seats',
        pricingLabel: 'Founder Early-Bird',
        maxAccounts: null,
        cloudQuota: 'Commercial Enterprise / Prop Firm / Fund License (100+ seats + White-Label Entitlement)'
      }
    },
    altTreasury: {
      solana: c.env.SOLANA_RECEIVE_ADDRESS,
      btc: c.env.BTC_RECEIVE_ADDRESS,
      tron: c.env.TRON_RECEIVE_ADDRESS
    }
  });
});

app.get('/api/cloud/blackout-calendar', async (c) => {
  const auth = await authenticateCloudProRequest(c.req.raw.headers, c.env);
  if (auth.provided && !auth.authenticated) {
    return c.json({ ok: false, error: auth.error, message: auth.message }, auth.status);
  }
  return c.json(buildBlackoutCalendarResponse(auth));
});

app.get('/api/cloud/presets', async (c) => {
  const auth = await authenticateCloudProRequest(c.req.raw.headers, c.env);
  if (auth.provided && !auth.authenticated) {
    return c.json({ ok: false, error: auth.error, message: auth.message }, auth.status);
  }
  return c.json(buildCloudPresetsResponse(auth));
});

app.get('/api/cloud/brief', async (c) => {
  const slugParam = c.req.query('slug') ?? '';
  const coinsParam = c.req.query('coins') ?? 'BTC,ETH,SOL';
  const brief = await buildPublicCloudBrief({
    slugs: slugParam.split(',').map((s) => s.trim()).filter(Boolean),
    coins: coinsParam.split(',').map((s) => s.trim()).filter(Boolean)
  });
  return c.json(brief);
});

app.post('/api/cloud/portfolio-guard', async (c) => {
  const parsed = await parseBoundedJsonBody(c.req.raw, MAX_JSON_BYTES);
  if (!parsed.ok) {
    return c.json({ ok: false, error: parsed.error, message: parsed.message }, parsed.status);
  }
  const out = evaluatePublicPortfolioGuard(parsed.data);
  if (!out.ok) {
    return c.json({ ok: false, error: out.error, message: out.message }, 400);
  }
  return c.json(out);
});

app.post('/api/cloud/monte-carlo', async (c) => {
  const auth = await authenticateCloudProRequest(c.req.raw.headers, c.env);
  if (auth.provided && !auth.authenticated) {
    return c.json({ ok: false, error: auth.error, message: auth.message }, auth.status);
  }

  const parsed = await parseBoundedJsonBody(c.req.raw, MAX_JSON_BYTES);
  if (!parsed.ok) {
    return c.json({ ok: false, error: parsed.error, message: parsed.message }, parsed.status);
  }

  const effectiveTier: Tier = auth.authenticated ? auth.tier : 'solo';
  const sim = runServerMonteCarlo(parsed.data, effectiveTier);
  if (!sim.ok) {
    return c.json({ ok: false, error: sim.error, message: sim.message }, 400);
  }
  return c.json(sim.data);
});

app.post('/api/cloud/relay/alert', async (c) => {
  const parsed = await parseBoundedJsonBody(c.req.raw, MAX_JSON_BYTES);
  if (!parsed.ok) {
    return c.json({ ok: false, error: parsed.error, message: parsed.message }, parsed.status);
  }

  const dryRun = parsed.data.dryRun === undefined ? true : Boolean(parsed.data.dryRun);
  const auth = await authenticateCloudProRequest(c.req.raw.headers, c.env);
  if (auth.provided && !auth.authenticated) {
    return c.json({ ok: false, error: auth.error, message: auth.message }, auth.status);
  }

  // Only dryRun formatting preview is open at $0; live outbound HTTP dispatches require commercial Bearer auth
  if (!dryRun && !auth.authenticated) {
    return c.json(
      {
        ok: false,
        error: 'PRO_AUTH_REQUIRED',
        message: 'Live outbound webhook dispatch requires Commercial License Bearer token (or deploy deploy/cloudflare-byo/ onto your own $0 Cloudflare account).'
      },
      401
    );
  }

  const out = await processCloudRelayAlert(parsed.data, auth.authenticated ? auth.tier : 'solo');
  return c.json(out.body, out.status as 200 | 400 | 502);
});

app.post('/api/challenge', async (c) => {
  const parsed = await parseBoundedJsonBody<{ txHash?: string; tier?: string }>(c.req.raw, MAX_JSON_BYTES);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, message: parsed.message }, parsed.status);
  }
  const body = parsed.data;

  const txHash = (body.txHash ?? '').trim();
  const tier = parseTier(body.tier);
  if (!TX_HASH_RE.test(txHash)) {
    return c.json({ error: 'INVALID_TX_HASH', message: 'Expected 0x-prefixed 64-hex txHash.' }, 400);
  }
  if (!tier) {
    return c.json({ error: 'INVALID_TIER', message: 'Commercial tier must be team (99 USDC) or enterprise (499 USDC). Solo is 0 USDC free.' }, 400);
  }

  const ttl = Math.max(60, Number(c.env.CHALLENGE_TTL_SECONDS || '300'));
  const nonce = randomHex(16);
  const ts = Math.floor(Date.now() / 1000);
  const message = buildChallengeMessage({
    brand: c.env.BRAND_NAME || 'ApexHive Labs',
    product: c.env.PRODUCT_ID || 'evalshield-copilot',
    tier,
    txHash,
    nonce,
    ts
  });

  const record: ChallengeRecord = { nonce, txHash: txHash.toLowerCase(), tier, ts, message };
  await c.env.LICENSES_KV.put(`challenge:${nonce}`, JSON.stringify(record), { expirationTtl: ttl });
  return c.json({ nonce, ts, expiresInSeconds: ttl, message });
});

app.post('/api/verify', async (c) => {
  if (
    !c.env.LICENSE_SIGNING_PRIVATE_JWK ||
    !c.env.DOWNLOAD_HMAC_SECRET ||
    c.env.DOWNLOAD_HMAC_SECRET.length < 16 ||
    !c.env.GLOBAL_CLAIMED_TX_KV ||
    !c.env.TX_CLAIM_LOCK
  ) {
    return c.json(
      {
        error: 'SERVER_MISCONFIGURED',
        message: 'Missing LICENSE_SIGNING_PRIVATE_JWK, DOWNLOAD_HMAC_SECRET, GLOBAL_CLAIMED_TX_KV, or TX_CLAIM_LOCK.'
      },
      500
    );
  }

  const parsed = await parseBoundedJsonBody<{
    txHash?: string;
    nonce?: string;
    signature?: string;
    tier?: string;
  }>(c.req.raw, MAX_JSON_BYTES);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, message: parsed.message }, parsed.status);
  }
  const body = parsed.data;

  const txHash = (body.txHash ?? '').trim();
  const nonce = (body.nonce ?? '').trim();
  const signature = (body.signature ?? '').trim();
  const tier = parseTier(body.tier);

  if (!TX_HASH_RE.test(txHash) || !nonce || !SIG_RE.test(signature)) {
    return c.json(
      { error: 'INVALID_REQUEST', message: 'Provide valid txHash, nonce, and EIP-191/ERC-1271/EIP-6492 signature.' },
      400
    );
  }
  if (!tier) {
    return c.json({ error: 'INVALID_TIER', message: 'Commercial tier must be team (99 USDC) or enterprise (499 USDC). Solo is 0 USDC free.' }, 400);
  }

  const txLower = txHash.toLowerCase();
  const challengeKey = `challenge:${nonce}`;
  const challengeRaw = await c.env.LICENSES_KV.get(challengeKey);
  if (!challengeRaw) {
    return c.json({ error: 'CHALLENGE_EXPIRED_OR_MISSING', message: 'Challenge expired (>300s) or unknown.' }, 403);
  }

  const challenge = JSON.parse(challengeRaw) as ChallengeRecord;
  const ttl = Math.max(60, Number(c.env.CHALLENGE_TTL_SECONDS || '300'));
  const nowSec = Math.floor(Date.now() / 1000);
  if (challenge.txHash !== txLower || challenge.tier !== tier || nowSec - challenge.ts > ttl) {
    await c.env.LICENSES_KV.delete(challengeKey);
    return c.json({ error: 'CHALLENGE_MISMATCH_OR_EXPIRED', message: 'Challenge mismatch or expired.' }, 403);
  }

  const rpcUrls = getBaseRpcUrls(c.env);
  let receipt: RpcReceipt | null;
  let latestBlockHex: string;
  try {
    [receipt, latestBlockHex] = await Promise.all([
      rpcCallWithFailover<RpcReceipt | null>(rpcUrls, 'eth_getTransactionReceipt', [txLower]),
      rpcCallWithFailover<string>(rpcUrls, 'eth_blockNumber', [])
    ]);
  } catch (err) {
    return c.json(
      { error: 'RPC_UNAVAILABLE', message: err instanceof Error ? err.message : 'Base RPC error' },
      502
    );
  }

  if (!receipt || receipt.status !== '0x1') {
    return c.json({ error: 'TX_NOT_CONFIRMED', message: 'Receipt missing or reverted.' }, 403);
  }
  const txBlock = parseStrictHexBigInt(receipt.blockNumber);
  const headBlock = parseStrictHexBigInt(latestBlockHex);
  if (txBlock === null || headBlock === null) {
    return c.json({ error: 'TX_NOT_CONFIRMED', message: 'Malformed hex blockNumber from RPC.' }, 403);
  }

  const minConf = Math.max(1, Number(c.env.MIN_CONFIRMATIONS || '2'));
  const confirmations = headBlock >= txBlock ? Number(headBlock - txBlock) + 1 : 0;
  if (confirmations < minConf) {
    return c.json({ error: 'INSUFFICIENT_CONFIRMATIONS', message: `Need >= ${minConf} confirmations.` }, 403);
  }

  const requiredAmount = getTierPriceAtomic(c.env, tier);
  const payerTotals = sumBaseUsdcTransfers(
    receipt.logs,
    c.env.BASE_USDC_CONTRACT,
    c.env.PAY_TO_EVM_ADDRESS
  );

  let matchedPayer: string | null = null;
  let paidAtomic = 0n;
  for (const [fromAddr, totalPaid] of payerTotals.entries()) {
    if (totalPaid < requiredAmount) continue;
    const sigOk = await verifySmartWalletOrEoaSignature({
      rpcUrls,
      address: fromAddr,
      message: challenge.message,
      signature
    });
    if (sigOk) {
      matchedPayer = fromAddr;
      paidAtomic = totalPaid;
      break;
    }
  }

  if (!matchedPayer) {
    await c.env.LICENSES_KV.delete(challengeKey);
    return c.json(
      {
        error: 'PAYMENT_OR_SIGNATURE_INVALID',
        message: 'Transfer or wallet signature (EIP-191 / ERC-1271 / EIP-6492) verification failed.'
      },
      403
    );
  }

  const globalKey = `global_tx:${txLower}`;
  const globalRaw = await c.env.GLOBAL_CLAIMED_TX_KV.get(globalKey);
  if (globalRaw) {
    const globalRec = JSON.parse(globalRaw) as GlobalClaimRecord;
    if (globalRec.scope !== SCOPE_STOREFRONT) {
      await c.env.LICENSES_KV.delete(challengeKey);
      return c.json(
        { error: 'TX_ALREADY_CLAIMED_ELSEWHERE', message: `Already claimed on ${globalRec.scope}.` },
        403
      );
    }
    if (globalRec.payer?.toLowerCase() !== matchedPayer.toLowerCase() || globalRec.tier !== tier) {
      await c.env.LICENSES_KV.delete(challengeKey);
      return c.json({ error: 'TX_ALREADY_CLAIMED', message: 'Transaction already claimed.' }, 403);
    }
  }

  // Acquire strongly-consistent Durable Object lock BEFORE issuing credentials or writing KV.
  const doId = c.env.TX_CLAIM_LOCK.idFromName(txLower);
  const doStub = c.env.TX_CLAIM_LOCK.get(doId);
  const doRes = await doStub.fetch('https://do.internal/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: SCOPE_STOREFRONT,
      txHash: txLower,
      payer: matchedPayer,
      tier,
      paidAtomic: paidAtomic.toString()
    })
  });
  const doJson = (await doRes.json()) as {
    ok: boolean;
    reclaimed?: boolean;
    error?: string;
    message?: string;
  };
  if (!doRes.ok || !doJson.ok) {
    await c.env.LICENSES_KV.delete(challengeKey);
    return c.json(
      {
        error: doJson.error || 'TX_ALREADY_CLAIMED',
        message: doJson.message || 'Transaction claim lock denied.'
      },
      403
    );
  }

  await c.env.LICENSES_KV.delete(challengeKey);

  const claimedKey = `claimed_tx:${txLower}`;
  const existingRaw = await c.env.LICENSES_KV.get(claimedKey);
  let reclaimed = Boolean(doJson.reclaimed);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as { payer?: string; tier?: Tier };
    if (existing.payer?.toLowerCase() === matchedPayer.toLowerCase() && existing.tier === tier) {
      reclaimed = true;
    } else {
      return c.json({ error: 'TX_ALREADY_CLAIMED', message: 'Transaction already claimed.' }, 403);
    }
  }

  const issuedAt = Date.now();
  const maxAccounts = null;
  const licenseToken = await signEvalShieldLicense(c.env, {
    v: 1,
    product: c.env.PRODUCT_ID || 'evalshield-copilot',
    tier,
    maxAccounts,
    payer: matchedPayer,
    txHash: txLower,
    issuedAt,
    expiresAt: null
  });

  const grantId = randomHex(16);
  const sigHex = await hmacSha256Hex(c.env.DOWNLOAD_HMAC_SECRET, grantId);
  const downloadToken = `${grantId}.${sigHex}`;
  const downloadTtl = Math.max(120, Number(c.env.DOWNLOAD_TTL_SECONDS || '600'));

  const grant: DownloadGrantRecord = {
    txHash: txLower,
    payer: matchedPayer,
    tier,
    remainingDownloads: 3,
    createdAt: issuedAt,
    licenseToken
  };

  const writes: Array<Promise<void>> = [
    c.env.LICENSES_KV.put(`dl:${grantId}`, JSON.stringify(grant), { expirationTtl: downloadTtl })
  ];
  if (!reclaimed) {
    writes.push(
      c.env.LICENSES_KV.put(
        claimedKey,
        JSON.stringify({ txHash: txLower, payer: matchedPayer, tier, paidAtomic: paidAtomic.toString(), issuedAt })
      ),
      c.env.GLOBAL_CLAIMED_TX_KV.put(
        globalKey,
        JSON.stringify({ scope: SCOPE_STOREFRONT, payer: matchedPayer, tier, txHash: txLower, claimedAt: issuedAt })
      )
    );
  }
  await Promise.all(writes);

  return c.json({
    ok: true,
    reclaimed,
    tier,
    maxAccounts,
    payer: matchedPayer,
    txHash: txLower,
    paidAtomic: paidAtomic.toString(),
    licenseToken,
    bearerHeader: `Authorization: Bearer ${licenseToken}`,
    downloadToken,
    downloadUrl: `/api/download?token=${encodeURIComponent(downloadToken)}`,
    activationCommand: `node apps/cli/dist/src/cli.js activate --token "${licenseToken}"`
  });
});

app.get('/api/download', async (c) => {
  if (!c.env.DOWNLOAD_HMAC_SECRET || c.env.DOWNLOAD_HMAC_SECRET.length < 16) {
    return c.json({ error: 'SERVER_MISCONFIGURED', message: 'Missing DOWNLOAD_HMAC_SECRET.' }, 500);
  }

  const token = (c.req.query('token') ?? '').trim();
  const match = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(token);
  if (!match) {
    return c.json({ error: 'INVALID_DOWNLOAD_TOKEN' }, 403);
  }

  const [, grantId, sigHex] = match;
  const expectedSig = await hmacSha256Hex(c.env.DOWNLOAD_HMAC_SECRET, grantId);
  if (!constantTimeEqualHex(sigHex, expectedSig)) {
    return c.json({ error: 'INVALID_DOWNLOAD_TOKEN' }, 403);
  }

  const dlKey = `dl:${grantId}`;
  const raw = await c.env.LICENSES_KV.get(dlKey);
  if (!raw) {
    return c.json({ error: 'DOWNLOAD_TOKEN_EXPIRED', message: 'Download grant expired or exhausted.' }, 403);
  }

  const grant = JSON.parse(raw) as DownloadGrantRecord;
  if (grant.remainingDownloads <= 0) {
    await c.env.LICENSES_KV.delete(dlKey);
    return c.json({ error: 'DOWNLOAD_LIMIT_REACHED' }, 403);
  }

  const nextRemaining = grant.remainingDownloads - 1;
  const downloadTtl = Math.max(120, Number(c.env.DOWNLOAD_TTL_SECONDS || '600'));
  if (nextRemaining <= 0) {
    await c.env.LICENSES_KV.delete(dlKey);
  } else {
    await c.env.LICENSES_KV.put(
      dlKey,
      JSON.stringify({ ...grant, remainingDownloads: nextRemaining }),
      { expirationTtl: downloadTtl }
    );
  }

  const bundle = {
    ok: true,
    product: 'evalshield-copilot',
    licenseModel: 'ApexHive Dual Source-Available (WinRAR Solo $0 + Commercial Team/Enterprise)',
    repoUrl: 'https://github.com/apexhive-hq/evalshield-copilot',
    tier: grant.tier,
    maxAccounts: null,
    payer: grant.payer,
    txHash: grant.txHash,
    issuedAt: grant.createdAt,
    licenseToken: grant.licenseToken,
    cloudProEndpoints: [
      'GET /api/cloud/blackout-calendar',
      'GET /api/cloud/presets',
      'GET /api/cloud/brief',
      'POST /api/cloud/monte-carlo',
      'POST /api/cloud/portfolio-guard',
      'POST /api/cloud/relay/alert'
    ]
  };

  return new Response(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="evalshield-copilot-entitlement.json"',
      'cache-control': 'no-store'
    }
  });
});

app.all('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Not Found', 404);
});

export default app;
