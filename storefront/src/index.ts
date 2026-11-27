import { createPrivateKey, sign as nodeEd25519Sign } from 'node:crypto';
import { Hono } from 'hono';
import {
  parseStrictHexBigInt,
  rpcCallWithFailover,
  RpcUnavailableError,
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
import {
  TxClaimLockDO,
  type DurableDownloadGrantRecord,
  type Tier
} from './tx-lock-do.ts';

export { TxClaimLockDO };

export interface TxClaimLockNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface Env {
  ASSETS: Fetcher;
  LICENSES_KV?: KVNamespace;
  GLOBAL_CLAIMED_TX_KV?: KVNamespace;
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
  ALLOWED_ORIGINS?: string;
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

interface GlobalClaimRecord {
  scope: string;
  payer: string;
  tier: string;
  txHash: string;
  claimedAt: number;
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

function parsePositiveInt(raw: string | undefined, fallback: number, min = 1): number {
  const s = raw?.trim();
  if (!s || !/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) return fallback;
  return n;
}

async function readBoundedText(
  request: Request,
  maxBytes: number
): Promise<
  | { ok: true; text: string }
  | { ok: false; status: 413; error: string; message: string }
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
  if (!request.body) {
    return { ok: true, text: '' };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          status: 413,
          error: 'PAYLOAD_TOO_LARGE',
          message: `JSON payload exceeds ${maxBytes} bytes.`
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(combined) };
}

async function parseBoundedJsonBody<T = Record<string, unknown>>(
  request: Request,
  maxBytes = MAX_JSON_BYTES
): Promise<
  | { ok: true; data: T }
  | { ok: false; status: 400 | 413; error: string; message: string }
> {
  const readRes = await readBoundedText(request, maxBytes);
  if (!readRes.ok) return readRes;
  try {
    const parsed = JSON.parse(readRes.text);
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

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function isOriginAllowed(origin: string, reqUrl: string, envAllowed: string | undefined): boolean {
  try {
    const reqOrigin = new URL(reqUrl).origin;
    if (origin === reqOrigin) return true;
  } catch {
    return false;
  }
  return parseAllowedOrigins(envAllowed).has(origin);
}

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error(
    '[evalshield-copilot-store unhandled]',
    err instanceof Error ? err.stack || err.message : String(err)
  );
  return c.json({ error: 'INTERNAL_ERROR' }, 500);
});

app.use('*', async (c, next) => {
  await next();
  const ct = c.res.headers.get('content-type');
  if (ct && (ct.startsWith('application/json') || ct.startsWith('text/html')) && !/charset=/i.test(ct)) {
    c.res.headers.set('content-type', `${ct}; charset=utf-8`);
  }
  c.res.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const origin = c.req.header('origin')?.trim();
  const method = c.req.method.toUpperCase();

  // Keep /api/health safe minimal for uptime probes
  if (path === '/api/health') {
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', '*');
    return;
  }

  const allowed = origin ? isOriginAllowed(origin, c.req.url, c.env.ALLOWED_ORIGINS) : true;
  if (origin && !allowed && method !== 'GET' && method !== 'HEAD') {
    return c.json(
      {
        ok: false,
        error: 'ORIGIN_NOT_ALLOWED',
        message: 'Cross-origin requests require same-origin or ALLOWED_ORIGINS allowlist.'
      },
      403
    );
  }

  if (method === 'OPTIONS') {
    const headers: Record<string, string> = {
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-EvalShield-License'
    };
    if (origin && allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
    return new Response(null, { status: 204, headers });
  }

  await next();
  c.res.headers.set('Vary', 'Origin');
  if (origin && allowed) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-EvalShield-License');
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
    version: '3.0.2',
    licenseModel: 'ApexHive Dual Source-Available License (Solo local: Free · Team: 99 USDC · Enterprise: 499 USDC)',
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
      '/api/cloud/portfolio-guard'
    ],
    commercialRelayEndpoints: ['/api/cloud/relay/alert'],
    relayAuthPolicy: 'dryRun=true public preview; dryRun=false requires Team or Enterprise Bearer license'
  });
});

app.get('/api/config', (c) => {
  return c.json({
    brand: c.env.BRAND_NAME || 'ApexHive Labs',
    productId: c.env.PRODUCT_ID || 'evalshield-copilot',
    version: '3.0.2',
    tokenPrefix: c.env.TOKEN_PREFIX || 'EVALSHIELD-PRO-v1.',
    licensePublicKeySpkiB64: c.env.LICENSE_SIGNING_PUBLIC_SPKI_B64 || null,
    supportEmail: 'apexhive.hq@proton.me',
    chainId: parsePositiveInt(c.env.BASE_CHAIN_ID, 8453, 1),
    usdcContract: c.env.BASE_USDC_CONTRACT,
    payToEvmAddress: c.env.PAY_TO_EVM_ADDRESS,
    minConfirmations: parsePositiveInt(c.env.MIN_CONFIRMATIONS, 2, 1),
    smartWalletSupport: ['EOA', 'ERC-1271', 'EIP-6492'],
    tiers: {
      solo: {
        priceUsd: '0',
        seats: '1 natural person',
        maxAccounts: null,
        license: 'Solo local: Free (Rule-based risk engine, SQLite journal, and self-hosted BYO alert worker)'
      },
      team: {
        priceAtomic: c.env.TEAM_PRICE_USDC_ATOMIC || '99000000',
        priceUsd: '99.00',
        seats: '2-99 seats',
        pricingLabel: 'Team Commercial',
        maxAccounts: null,
        cloudQuota: 'Commercial Team Desk License (2-99 seats + Hosted Outbound Telegram/Discord Alert Relay)'
      },
      enterprise: {
        priceAtomic: c.env.ENTERPRISE_PRICE_USDC_ATOMIC || '499000000',
        priceUsd: '499.00',
        seats: '100+ seats',
        pricingLabel: 'Enterprise Commercial',
        maxAccounts: null,
        cloudQuota: 'Commercial Enterprise / Prop Firm / Fund License (100+ seats + White-Label Entitlement)'
      }
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
  if (!c.env.TX_CLAIM_LOCK) {
    return c.json(
      { error: 'SERVER_MISCONFIGURED', message: 'Missing TX_CLAIM_LOCK Durable Object binding.' },
      500
    );
  }

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

  const ttl = parsePositiveInt(c.env.CHALLENGE_TTL_SECONDS, 300, 60);
  const nonce = randomHex(16);
  const ts = Math.floor(Date.now() / 1000);
  const expiresAtMs = Date.now() + ttl * 1000;
  const message = buildChallengeMessage({
    brand: c.env.BRAND_NAME || 'ApexHive Labs',
    product: c.env.PRODUCT_ID || 'evalshield-copilot',
    tier,
    txHash,
    nonce,
    ts
  });

  const chStub = c.env.TX_CLAIM_LOCK.get(c.env.TX_CLAIM_LOCK.idFromName(`challenge:${nonce}`));
  const createRes = await chStub.fetch('https://do.internal/challenge/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nonce,
      txHash: txHash.toLowerCase(),
      tier,
      ts,
      message,
      expiresAtMs
    })
  });
  if (!createRes.ok) {
    return c.json({ error: 'CHALLENGE_STORE_ERROR', message: 'Failed to persist challenge nonce.' }, 500);
  }

  return c.json({ nonce, ts, expiresInSeconds: ttl, message });
});

app.post('/api/verify', async (c) => {
  if (
    !c.env.LICENSE_SIGNING_PRIVATE_JWK ||
    !c.env.DOWNLOAD_HMAC_SECRET ||
    c.env.DOWNLOAD_HMAC_SECRET.length < 16 ||
    !c.env.TX_CLAIM_LOCK
  ) {
    return c.json(
      {
        error: 'SERVER_MISCONFIGURED',
        message: 'Missing LICENSE_SIGNING_PRIVATE_JWK, DOWNLOAD_HMAC_SECRET, or TX_CLAIM_LOCK.'
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
  const challengeStub = c.env.TX_CLAIM_LOCK.get(c.env.TX_CLAIM_LOCK.idFromName(`challenge:${nonce}`));
  const checkRes = await challengeStub.fetch('https://do.internal/challenge/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txHash: txLower, tier })
  });
  const checkJson = (await checkRes.json()) as {
    ok: boolean;
    error?: string;
    message?: string;
    challenge?: { message: string };
  };
  if (!checkRes.ok || !checkJson.ok || !checkJson.challenge) {
    return c.json(
      {
        error: checkJson.error || 'CHALLENGE_EXPIRED_OR_MISSING',
        message: checkJson.message || 'Challenge expired (>300s) or unknown.'
      },
      403
    );
  }
  const challengeMessage = checkJson.challenge.message;

  const consumeChallenge = async () =>
    challengeStub.fetch('https://do.internal/challenge/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: txLower, tier })
    });

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

  const minConf = parsePositiveInt(c.env.MIN_CONFIRMATIONS, 2, 1);
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
  try {
    for (const [fromAddr, totalPaid] of payerTotals.entries()) {
      if (totalPaid < requiredAmount) continue;
      const sigOk = await verifySmartWalletOrEoaSignature({
        rpcUrls,
        address: fromAddr,
        message: challengeMessage,
        signature
      });
      if (sigOk) {
        matchedPayer = fromAddr;
        paidAtomic = totalPaid;
        break;
      }
    }
  } catch (err) {
    if (err instanceof RpcUnavailableError) {
      // Preserve challenge nonce across transient RPC outages during ERC-1271 / EIP-6492 eth_call
      return c.json({ error: 'RPC_UNAVAILABLE', message: err.message }, 502);
    }
    throw err;
  }

  if (!matchedPayer) {
    await consumeChallenge();
    return c.json(
      {
        error: 'PAYMENT_OR_SIGNATURE_INVALID',
        message: 'Transfer or wallet signature (EIP-191 / ERC-1271 / EIP-6492) verification failed.'
      },
      403
    );
  }

  const globalKey = `global_tx:${txLower}`;
  if (c.env.GLOBAL_CLAIMED_TX_KV) {
    const globalRaw = await c.env.GLOBAL_CLAIMED_TX_KV.get(globalKey);
    if (globalRaw) {
      const globalRec = JSON.parse(globalRaw) as GlobalClaimRecord;
      if (globalRec.scope !== SCOPE_STOREFRONT) {
        await consumeChallenge();
        return c.json(
          { error: 'TX_ALREADY_CLAIMED_ELSEWHERE', message: `Already claimed on ${globalRec.scope}.` },
          403
        );
      }
      if (globalRec.payer?.toLowerCase() !== matchedPayer.toLowerCase() || globalRec.tier !== tier) {
        await consumeChallenge();
        return c.json({ error: 'TX_ALREADY_CLAIMED', message: 'Transaction already claimed.' }, 403);
      }
    }
  }

  // Atomically consume the challenge nonce BEFORE claiming txHash so concurrent nonce reuse cannot race.
  const consumeRes = await consumeChallenge();
  if (!consumeRes.ok) {
    return c.json(
      { error: 'CHALLENGE_EXPIRED_OR_MISSING', message: 'Challenge already consumed or expired.' },
      403
    );
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
    return c.json(
      {
        error: doJson.error || 'TX_ALREADY_CLAIMED',
        message: doJson.message || 'Transaction claim lock denied.'
      },
      403
    );
  }

  const reclaimed = Boolean(doJson.reclaimed);
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
  const downloadTtl = parsePositiveInt(c.env.DOWNLOAD_TTL_SECONDS, 600, 120);

  const dlStub = c.env.TX_CLAIM_LOCK.get(c.env.TX_CLAIM_LOCK.idFromName(`dl:${grantId}`));
  const dlCreateRes = await dlStub.fetch('https://do.internal/download/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      txHash: txLower,
      payer: matchedPayer,
      tier,
      remainingDownloads: 3,
      createdAt: issuedAt,
      expiresAtMs: issuedAt + downloadTtl * 1000,
      licenseToken
    })
  });
  if (!dlCreateRes.ok) {
    return c.json({ error: 'DOWNLOAD_GRANT_STORE_ERROR', message: 'Failed to persist download grant.' }, 500);
  }

  if (!reclaimed) {
    const writes: Array<Promise<void>> = [];
    if (c.env.LICENSES_KV) {
      writes.push(
        c.env.LICENSES_KV.put(
          `claimed_tx:${txLower}`,
          JSON.stringify({ txHash: txLower, payer: matchedPayer, tier, paidAtomic: paidAtomic.toString(), issuedAt })
        )
      );
    }
    if (c.env.GLOBAL_CLAIMED_TX_KV) {
      writes.push(
        c.env.GLOBAL_CLAIMED_TX_KV.put(
          globalKey,
          JSON.stringify({ scope: SCOPE_STOREFRONT, payer: matchedPayer, tier, txHash: txLower, claimedAt: issuedAt })
        )
      );
    }
    if (writes.length > 0) {
      await Promise.all(writes);
    }
  }

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
  if (!c.env.DOWNLOAD_HMAC_SECRET || c.env.DOWNLOAD_HMAC_SECRET.length < 16 || !c.env.TX_CLAIM_LOCK) {
    return c.json({ error: 'SERVER_MISCONFIGURED', message: 'Missing DOWNLOAD_HMAC_SECRET or TX_CLAIM_LOCK.' }, 500);
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

  const dlStub = c.env.TX_CLAIM_LOCK.get(c.env.TX_CLAIM_LOCK.idFromName(`dl:${grantId}`));
  const redeemRes = await dlStub.fetch('https://do.internal/download/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  const redeemJson = (await redeemRes.json()) as {
    ok: boolean;
    error?: string;
    message?: string;
    grant?: DurableDownloadGrantRecord;
  };
  if (!redeemRes.ok || !redeemJson.ok || !redeemJson.grant) {
    return c.json(
      {
        error: redeemJson.error || 'DOWNLOAD_TOKEN_EXPIRED',
        message: redeemJson.message || 'Download grant expired or exhausted.'
      },
      403
    );
  }

  const grant = redeemJson.grant;

  const bundle = {
    ok: true,
    product: 'evalshield-copilot',
    licenseModel: 'ApexHive Dual Source-Available License (Solo local: Free · Team: 99 USDC · Enterprise: 499 USDC)',
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
