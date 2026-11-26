import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import app, { TxClaimLockDO } from '../src/index.ts';

const BOOL_TRUE_HEX = '0x' + '0'.repeat(63) + '1';
const BOOL_FALSE_HEX = '0x' + '0'.repeat(64);

function createMemoryKv() {
  const store = new Map();
  let getCount = 0;
  let putCount = 0;
  let deleteCount = 0;
  return {
    get counts() {
      return { getCount, putCount, deleteCount };
    },
    async get(key) {
      getCount += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val) {
      putCount += 1;
      store.set(key, String(val));
    },
    async delete(key) {
      deleteCount += 1;
      store.delete(key);
    }
  };
}

function createMemoryTxClaimLockNamespace() {
  const instances = new Map();
  return {
    idFromName(name) {
      return String(name);
    },
    get(id) {
      const key = String(id);
      if (!instances.has(key)) {
        const storageMap = new Map();
        const ctx = {
          storage: {
            async get(k) {
              return storageMap.get(k);
            },
            async put(k, v) {
              await Promise.resolve();
              storageMap.set(k, structuredClone(v));
            },
            async delete(k) {
              return storageMap.delete(k);
            }
          }
        };
        const instance = new TxClaimLockDO(ctx);
        instances.set(key, {
          fetch(input, init) {
            return instance.fetch(input instanceof Request ? input : new Request(input, init));
          }
        });
      }
      return instances.get(key);
    }
  };
}

async function generateEd25519TestKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return {
    privateJwkJson: JSON.stringify(privJwk),
    spkiB64: Buffer.from(spki).toString('base64')
  };
}

function encodeTransferLog({ usdcContract, from, to, amountAtomic }) {
  const topicSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const padAddr = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return {
    address: usdcContract,
    topics: [topicSig, padAddr(from), padAddr(to)],
    data: '0x' + amountAtomic.toString(16).padStart(64, '0')
  };
}

async function signTestProToken(privateJwkJson, overrides = {}) {
  const payload = {
    v: 1,
    product: 'evalshield-copilot',
    tier: 'solo',
    maxAccounts: 20,
    payer: '0x2222222222222222222222222222222222222222',
    txHash: '0x' + 'aa'.repeat(32),
    issuedAt: Date.now() - 5000,
    expiresAt: null,
    ...overrides
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = new TextEncoder().encode(`EVALSHIELD-PRO-v1.${b64}`);
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privateJwkJson), { name: 'Ed25519' }, false, ['sign']);
  const sig = await crypto.subtle.sign('Ed25519', key, signingInput);
  return `EVALSHIELD-PRO-v1.${b64}.${Buffer.from(sig).toString('base64url')}`;
}

test('Config, health, fail-closed 500 (missing TX_CLAIM_LOCK/secrets), 413 bound, strict tier & cross-product replay block', async () => {
  const licensesKv = createMemoryKv();
  const globalKv = createMemoryKv();
  const { privateJwkJson, spkiB64 } = await generateEd25519TestKeys();
  const payer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const txHash = '0x' + 'ef'.repeat(32);

  const misconfiguredEnv = {
    BRAND_NAME: 'ApexHive Labs',
    PRODUCT_ID: 'evalshield-copilot',
    TOKEN_PREFIX: 'EVALSHIELD-PRO-v1.',
    PAY_TO_EVM_ADDRESS: '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206',
    BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    BASE_CHAIN_ID: '8453',
    BASE_RPC_URL: 'http://127.0.0.1:1/dead',
    TEAM_PRICE_USDC_ATOMIC: '99000000',
    ENTERPRISE_PRICE_USDC_ATOMIC: '499000000',
    MIN_CONFIRMATIONS: '2',
    CHALLENGE_TTL_SECONDS: '300',
    DOWNLOAD_TTL_SECONDS: '600',
    LICENSES_KV: licensesKv,
    GLOBAL_CLAIMED_TX_KV: globalKv,
    LICENSE_SIGNING_PRIVATE_JWK: privateJwkJson,
    LICENSE_SIGNING_PUBLIC_SPKI_B64: spkiB64,
    DOWNLOAD_HMAC_SECRET: '0123456789abcdef0123456789abcdef'
    // Intentionally omit TX_CLAIM_LOCK -> must fail-closed 500!
  };

    const verify500 = await app.request(
    'https://evalshield.test/api/verify',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, nonce: 'n1', signature: '0x' + '11'.repeat(65), tier: 'team' })
    },
    misconfiguredEnv
  );
  assert.equal(verify500.status, 500);
  assert.equal(licensesKv.counts.getCount, 0);

  const env = {
    ...misconfiguredEnv,
    TX_CLAIM_LOCK: createMemoryTxClaimLockNamespace()
  };

  const healthRes = await app.request('https://evalshield.test/api/health', {}, env);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.durableObjectLockBound, true);
  assert.deepEqual(health.smartWalletSupport, ['EOA', 'ERC-1271', 'EIP-6492']);

  const cfgRes = await app.request('https://evalshield.test/api/config', {}, env);
  assert.equal(cfgRes.status, 200);
  const cfg = await cfgRes.json();
  assert.equal(cfg.supportEmail, 'apexhive.hq@proton.me');
  assert.equal(cfg.tiers.solo.priceUsd, '0');
  assert.equal(cfg.tiers.solo.maxAccounts, null);
  assert.equal(cfg.tiers.team.priceAtomic, '99000000');
  assert.equal(cfg.tiers.enterprise.priceAtomic, '499000000');
  assert.equal(cfg.altTreasury, undefined);

  const bigBody = await app.request(
    'https://evalshield.test/api/challenge',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, tier: 'team', pad: 'x'.repeat(40_000) })
    },
    env
  );
  assert.equal(bigBody.status, 413);

  const badTierCh = await app.request(
    'https://evalshield.test/api/challenge',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, tier: 'solo' })
    },
    env
  );
  assert.equal(badTierCh.status, 400);
  assert.equal((await badTierCh.json()).error, 'INVALID_TIER');

  const badDl = await app.request(
    `https://evalshield.test/api/download?token=${'aa'.repeat(16)}.${'bb'.repeat(32)}`,
    {},
    env
  );
  assert.equal(badDl.status, 403);
  assert.equal((await badDl.json()).error, 'INVALID_DOWNLOAD_TOKEN');
  assert.equal(licensesKv.counts.getCount, 0);

  // Cross-product replay block from open-center-os -> evalshield-copilot
  await globalKv.put(
    `global_tx:${txHash}`,
    JSON.stringify({
      scope: 'storefront:open-center-os',
      payer: payer.address.toLowerCase(),
      tier: 'team',
      txHash,
      claimedAt: Date.now()
    })
  );

  const chRes = await app.request(
    'https://evalshield.test/api/challenge',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, tier: 'team' })
    },
    env
  );
  assert.equal(chRes.status, 200);
  const { nonce, message } = await chRes.json();
  const signature = await payer.signMessage({ message });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:1/dead')) {
      const rpcReq = JSON.parse(String(init?.body ?? '{}'));
      if (rpcReq.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: rpcReq.id, result: '0x64' });
      if (rpcReq.method === 'eth_getTransactionReceipt') {
        return Response.json({
          jsonrpc: '2.0',
          id: rpcReq.id,
          result: {
            status: '0x1',
            blockNumber: '0x60',
            logs: [
              encodeTransferLog({
                usdcContract: env.BASE_USDC_CONTRACT,
                from: payer.address,
                to: env.PAY_TO_EVM_ADDRESS,
                amountAtomic: 99_000_000n
              })
            ]
          }
        });
      }
    }
    return origFetch(url, init);
  };

  try {
    const replayRes = await app.request(
      'https://evalshield.test/api/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, nonce, signature, tier: 'team' })
      },
      env
    );
    assert.equal(replayRes.status, 403);
    assert.equal((await replayRes.json()).error, 'TX_ALREADY_CLAIMED_ELSEWHERE');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ERC-1271 / EIP-6492 256-byte Smart Wallet verification and Promise.all DO atomic claim lock', async () => {
  const licensesKv = createMemoryKv();
  const globalKv = createMemoryKv();
  const { privateJwkJson, spkiB64 } = await generateEd25519TestKeys();
  const smartWallet = '0x3333333333333333333333333333333333333333';
  const txHash = '0x' + 'cd'.repeat(32);
  const smartWalletSig = '0x' + 'ab'.repeat(256); // 256-byte variable-length ABI signature

  const env = {
    BRAND_NAME: 'ApexHive Labs',
    PRODUCT_ID: 'evalshield-copilot',
    TOKEN_PREFIX: 'EVALSHIELD-PRO-v1.',
    PAY_TO_EVM_ADDRESS: '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206',
    BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    BASE_CHAIN_ID: '8453',
    BASE_RPC_URL: 'http://127.0.0.1:1/dead',
    TEAM_PRICE_USDC_ATOMIC: '99000000',
    ENTERPRISE_PRICE_USDC_ATOMIC: '499000000',
    MIN_CONFIRMATIONS: '2',
    CHALLENGE_TTL_SECONDS: '300',
    DOWNLOAD_TTL_SECONDS: '600',
    LICENSES_KV: licensesKv,
    GLOBAL_CLAIMED_TX_KV: globalKv,
    TX_CLAIM_LOCK: createMemoryTxClaimLockNamespace(),
    LICENSE_SIGNING_PRIVATE_JWK: privateJwkJson,
    LICENSE_SIGNING_PUBLIC_SPKI_B64: spkiB64,
    DOWNLOAD_HMAC_SECRET: '0123456789abcdef0123456789abcdef'
  };

  const validPrefix = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes' }],
    [smartWallet, pad('0x1234', { size: 32 }), smartWalletSig]
  ).slice(2);
  let capturedCallData = '';

  const [chTeam, chEnt] = await Promise.all([
    (await app.request(
      'https://evalshield.test/api/challenge',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, tier: 'team' }) },
      env
    )).json(),
    (await app.request(
      'https://evalshield.test/api/challenge',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, tier: 'enterprise' }) },
      env
    )).json()
  ]);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:1/dead')) {
      const rpcReq = JSON.parse(String(init?.body ?? '{}'));
      if (rpcReq.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: rpcReq.id, result: '0x64' });
      if (rpcReq.method === 'eth_getTransactionReceipt') {
        return Response.json({
          jsonrpc: '2.0',
          id: rpcReq.id,
          result: {
            status: '0x1',
            blockNumber: '0x60',
            logs: [
              encodeTransferLog({
                usdcContract: env.BASE_USDC_CONTRACT,
                from: smartWallet,
                to: env.PAY_TO_EVM_ADDRESS,
                amountAtomic: 499_000_000n
              })
            ]
          }
        });
      }
      if (rpcReq.method === 'eth_call') {
        const callData = String(rpcReq.params?.[0]?.data ?? '').toLowerCase();
        capturedCallData = callData;
        const ok = callData.includes(smartWallet.slice(2).toLowerCase()) && callData.includes('ab'.repeat(32));
        return Response.json({ jsonrpc: '2.0', id: rpcReq.id, result: ok ? BOOL_TRUE_HEX : BOOL_FALSE_HEX });
      }
    }
    return origFetch(url, init);
  };

  try {
    // Concurrent conflicting tier race on same settled txHash: DO serializes cleanly (1 passes, 1 denied 403)!
    const [r1, r2] = await Promise.all([
      app.request(
        'https://evalshield.test/api/verify',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ txHash, nonce: chTeam.nonce, signature: smartWalletSig, tier: 'team' })
        },
        env
      ),
      app.request(
        'https://evalshield.test/api/verify',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ txHash, nonce: chEnt.nonce, signature: smartWalletSig, tier: 'enterprise' })
        },
        env
      )
    ]);

    assert.ok(capturedCallData.length >= 200, 'Expected ERC-1271/EIP-6492 eth_call payload');
    assert.ok(validPrefix.length > 0);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 403]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Open Risk Sandbox opens analytical APIs at $0 while rejecting solo on Commercial Relay, enforcing CORS & security headers, and verifying official 2026-2027 calendar + DST', async () => {
  const licensesKv = createMemoryKv();
  const { privateJwkJson, spkiB64 } = await generateEd25519TestKeys();
  const env = {
    BRAND_NAME: 'ApexHive Labs',
    PRODUCT_ID: 'evalshield-copilot',
    TOKEN_PREFIX: 'EVALSHIELD-PRO-v1.',
    PAY_TO_EVM_ADDRESS: '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206',
    BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    BASE_CHAIN_ID: '8453',
    BASE_RPC_URL: 'http://127.0.0.1:1/dead',
    TEAM_PRICE_USDC_ATOMIC: '99000000',
    ENTERPRISE_PRICE_USDC_ATOMIC: '499000000',
    MIN_CONFIRMATIONS: '2',
    CHALLENGE_TTL_SECONDS: '300',
    DOWNLOAD_TTL_SECONDS: '600',
    ALLOWED_ORIGINS: 'https://trusted.evalshield.example',
    LICENSES_KV: licensesKv,
    GLOBAL_CLAIMED_TX_KV: createMemoryKv(),
    TX_CLAIM_LOCK: createMemoryTxClaimLockNamespace(),
    LICENSE_SIGNING_PRIVATE_JWK: privateJwkJson,
    LICENSE_SIGNING_PUBLIC_SPKI_B64: spkiB64,
    DOWNLOAD_HMAC_SECRET: '0123456789abcdef0123456789abcdef'
  };

  const soloToken = await signTestProToken(privateJwkJson, { tier: 'solo', maxAccounts: null });
  const teamToken = await signTestProToken(privateJwkJson, { tier: 'team', maxAccounts: null });
  const enterpriseToken = await signTestProToken(privateJwkJson, { tier: 'enterprise', maxAccounts: null });
  const expiredToken = await signTestProToken(privateJwkJson, { tier: 'team', expiresAt: Date.now() - 10_000 });

  // 0. Security headers & ALLOWED_ORIGINS non-wildcard CORS enforcement
  const healthSecRes = await app.request('https://evalshield.test/api/health', { headers: { origin: 'https://any.example' } }, env);
  assert.equal(healthSecRes.headers.get('access-control-allow-origin'), '*');
  assert.equal(healthSecRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(healthSecRes.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((healthSecRes.headers.get('content-security-policy') || '').includes("script-src 'self'"));
  assert.ok((healthSecRes.headers.get('strict-transport-security') || '').includes('max-age='));

  const blockedCorsPost = await app.request(
    'https://evalshield.test/api/challenge',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ txHash: '0x' + '11'.repeat(32), tier: 'team' })
    },
    env
  );
  assert.equal(blockedCorsPost.status, 403);
  assert.equal((await blockedCorsPost.json()).error, 'ORIGIN_NOT_ALLOWED');
  assert.equal(blockedCorsPost.headers.get('access-control-allow-origin'), null);

  const allowedCorsGet = await app.request(
    'https://evalshield.test/api/config',
    { headers: { origin: 'https://trusted.evalshield.example' } },
    env
  );
  assert.equal(allowedCorsGet.status, 200);
  assert.equal(allowedCorsGet.headers.get('access-control-allow-origin'), 'https://trusted.evalshield.example');

  // 1. Blackout calendar & Presets are 100% open at $0 (Solo-Free), verified 2026-2027 official FOMC/CPI/NFP + exact DST, while invalid tokens fail closed (403)
  const calPublic = await (await app.request('https://evalshield.test/api/cloud/blackout-calendar', {}, env)).json();
  assert.equal(calPublic.openAccess, true);
  assert.equal(calPublic.tier, 'solo_free');
  assert.ok(Array.isArray(calPublic.events) && calPublic.events.length >= 15);
  assert.ok(calPublic.events.some((e) => typeof e.scheduledUtc === 'string' && e.scheduledUtc >= '2027-02-01'));
  assert.ok(calPublic.events.some((e) => e.id === 'cme-daily-maint'));

  // Official 2026-07-02 NFP (Thu July 4th adj.), 2026-05-12 CPI, and exact DST boundary (2026-03-06 EST 13:30Z vs 2026-03-11 EDT 12:30Z)
  const { buildBlackoutCalendarResponse } = await import('../src/cloud-pro.ts');
  const cal2026 = buildBlackoutCalendarResponse({ provided: false, authenticated: false }, new Date('2026-01-15T00:00:00Z'));
  const nfpMar2026 = cal2026.events.find((e) => e.id === 'us-nfp-2026-03');
  const cpiMar2026 = cal2026.events.find((e) => e.id === 'us-cpi-2026-03');
  const cpiMay2026 = cal2026.events.find((e) => e.id === 'us-cpi-2026-05');
  const nfpJul2026 = cal2026.events.find((e) => e.id === 'us-nfp-2026-07');
  const fomcMar2026 = cal2026.events.find((e) => e.id === 'fomc-rate-2026-03');
  assert.equal(nfpMar2026?.scheduledUtc, '2026-03-06T13:30:00Z');
  assert.equal(nfpMar2026?.isEstimated, false);
  assert.equal(cpiMar2026?.scheduledUtc, '2026-03-11T12:30:00Z');
  assert.equal(cpiMay2026?.scheduledUtc, '2026-05-12T12:30:00Z');
  assert.equal(nfpJul2026?.scheduledUtc, '2026-07-02T12:30:00Z');
  assert.equal(fomcMar2026?.scheduledUtc, '2026-03-18T18:00:00Z');

  // 2027-10-27 is tagged accurately as FOMC Monetary Policy Strategy Session (no rate decision/press conference)
  const cal2027 = buildBlackoutCalendarResponse({ provided: false, authenticated: false }, new Date('2027-01-15T00:00:00Z'));
  const fomcOct2027 = cal2027.events.find((e) => e.id === 'fomc-rate-2027-10');
  assert.ok(fomcOct2027?.name.includes('Strategy Session'));
  assert.equal(fomcOct2027?.impact, 'MODERATE');

  // Beyond published 2026-2027 window -> explicitly tagged ESTIMATED_PRELIMINARY_SCHEDULE
  const cal2028 = buildBlackoutCalendarResponse({ provided: false, authenticated: false }, new Date('2028-06-01T00:00:00Z'));
  const estCpi2028 = cal2028.events.find((e) => e.id === 'us-cpi-est-2028-06');
  assert.equal(estCpi2028?.isEstimated, true);
  assert.equal(estCpi2028?.scheduleStatus, 'ESTIMATED_PRELIMINARY_SCHEDULE');

  const calBad = await app.request(
    'https://evalshield.test/api/cloud/blackout-calendar',
    { headers: { authorization: 'Bearer EVALSHIELD-PRO-v1.invalid.sig' } },
    env
  );
  assert.equal(calBad.status, 403);

  const presetsPublic = await (await app.request('https://evalshield.test/api/cloud/presets', {}, env)).json();
  assert.equal(presetsPublic.openAccess, true);
  assert.equal(presetsPublic.tier, 'solo_free');
  assert.notEqual(presetsPublic.updatedAtUtc, '2026-11-26T00:00:00Z');
  assert.ok(presetsPublic.presets.some((p) => p.id === 'ftmo_100k_2step'));
  assert.ok(presetsPublic.presets.some((p) => p.id === 'tradeify_50k_growth'));
  assert.ok(presetsPublic.deskTemplates);

  const presetsEnt = await (
    await app.request(
      'https://evalshield.test/api/cloud/presets',
      { headers: { authorization: `Bearer ${enterpriseToken}` } },
      env
    )
  ).json();
  assert.equal(presetsEnt.tier, 'enterprise');

  // 2. Public 25k Monte Carlo ($0 unauth works!) + expired token still rejected (403)
  const mcPublic = await app.request(
    'https://evalshield.test/api/cloud/monte-carlo',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runs: 25000,
        accounts: 4,
        winRate: 52,
        rewardRiskRatio: 1.5,
        riskPerTradeUsd: 250,
        profitTargetUsd: 3000,
        maxDrawdownUsd: 2000,
        drawdownMode: 'INTRADAY_TRAILING'
      })
    },
    env
  );
  assert.equal(mcPublic.status, 200);
  const mcData = await mcPublic.json();
  assert.equal(mcData.runs, 25000);
  assert.equal(mcData.accountsSimulated, 4);
  assert.ok(mcData.passProbabilityPct > 0);

  const mcExp = await app.request(
    'https://evalshield.test/api/cloud/monte-carlo',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${expiredToken}` },
      body: JSON.stringify({ runs: 5000 })
    },
    env
  );
  assert.equal(mcExp.status, 403);
  assert.equal((await mcExp.json()).error, 'PRO_TOKEN_EXPIRED');

  // 3. Portfolio guard ($0 open) & Brief (mocked Hyperliquid/Gamma)
  const portRes = await app.request(
    'https://evalshield.test/api/cloud/portfolio-guard',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        positions: [
          { accountId: 'acc1', symbol: 'ES', side: 'LONG', qty: 2 },
          { accountId: 'acc2', symbol: 'NQ', side: 'SHORT', qty: 2 }
        ]
      })
    },
    env
  );
  assert.equal(portRes.status, 200);
  const portJson = await portRes.json();
  assert.equal(portJson.safeToProceed, false);
  assert.ok(portJson.alerts.some((a) => a.code === 'CROSS_ACCOUNT_ANTI_HEDGE_VIOLATION'));

  // 3b. Portfolio guard MUST Fail-Closed (400 INVALID_PARAMS) on misspelled/missing position fields or empty array
  for (const badBody of [
    { positions: [] },
    { positions: [{ accountId: 'acc1', symbol: 'ES', direction: 'LONG', qty: 1 }] },
    { positions: [{ accountId: 'acc1', symbol: 'ES', side: 'LONG' }] }
  ]) {
    const badRes = await app.request(
      'https://evalshield.test/api/cloud/portfolio-guard',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(badBody) },
      env
    );
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).error, 'INVALID_PARAMS');
  }

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.hyperliquid.xyz/info')) {
      return Response.json([
        { universe: [{ name: 'BTC' }] },
        [{ markPx: '95000', funding: '0.0007', openInterest: '40000' }]
      ]);
    }
    if (u.includes('gamma-api.polymarket.com')) {
      return Response.json([{ slug: 'fed-cut', question: 'Fed cut?', outcomePrices: '["0.75","0.25"]', volume24hr: 500000, closed: false }]);
    }
    return origFetch(url);
  };
  try {
    const briefJson = await (
      await app.request('https://evalshield.test/api/cloud/brief?slug=fed-cut&coins=BTC', {}, env)
    ).json();
    assert.equal(briefJson.openAccess, true);
    assert.equal(briefJson.hyperliquid[0].extremeFundingAlert, true);
    assert.equal(briefJson.polymarket[0].yesProbabilityPct, 75);

    const briefDefaultJson = await (
      await app.request('https://evalshield.test/api/cloud/brief?coins=BTC', {}, env)
    ).json();
    assert.ok(briefDefaultJson.polymarket.length >= 1);
  } finally {
    globalThis.fetch = origFetch;
  }

  // 4. Relay alert: dryRun preview open at $0, live outbound relay (!dryRun) gated 401 unauth + SSRF blocked
  const relayDryPublic = await app.request(
    'https://evalshield.test/api/cloud/relay/alert',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        alertType: 'TILT_LOCKOUT',
        accountName: 'Apex <script>alert(1)</script>',
        symbol: 'MNQ',
        remainingBufferUsd: 350,
        maxContractsAllowed: 0,
        consecutiveLosses: 3,
        dryRun: true
      })
    },
    env
  );
  assert.equal(relayDryPublic.status, 200);
  const relayJson = await relayDryPublic.json();
  assert.equal(relayJson.dryRun, true);
  assert.equal(relayJson.telegramPayload.text.includes('<script>'), false);

  const relayLive401 = await app.request(
    'https://evalshield.test/api/cloud/relay/alert',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alertType: 'TILT_LOCKOUT', dryRun: false, webhookUrl: 'https://discord.com/api/webhooks/1/a' })
    },
    env
  );
  assert.equal(relayLive401.status, 401);

  // Solo tier token MUST be rejected (403 TEAM_OR_ENTERPRISE_REQUIRED) on Commercial Relay
  const relaySolo403 = await app.request(
    'https://evalshield.test/api/cloud/relay/alert',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${soloToken}` },
      body: JSON.stringify({ alertType: 'TILT_LOCKOUT', dryRun: false, webhookUrl: 'https://discord.com/api/webhooks/1/a' })
    },
    env
  );
  assert.equal(relaySolo403.status, 403);
  assert.equal((await relaySolo403.json()).error, 'TEAM_OR_ENTERPRISE_REQUIRED');

  for (const ssrfUrl of [
    'http://127.0.0.1:8080/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://evil.example/api/webhooks/1/abc'
  ]) {
    const ssrfRes = await app.request(
      'https://evalshield.test/api/cloud/relay/alert',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${teamToken}` },
        body: JSON.stringify({ alertType: 'TILT_LOCKOUT', dryRun: false, webhookUrl: ssrfUrl })
      },
      env
    );
    assert.equal(ssrfRes.status, 400);
    assert.equal((await ssrfRes.json()).error, 'INVALID_WEBHOOK_TARGET');
  }
});

test('Durable Object serializes challenge nonce consumption and concurrent /api/download grant decrements', async () => {
  const { privateJwkJson, spkiB64 } = await generateEd25519TestKeys();
  const payer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const txHash = '0x' + '99'.repeat(32);

  const env = {
    BRAND_NAME: 'ApexHive Labs',
    PRODUCT_ID: 'evalshield-copilot',
    TOKEN_PREFIX: 'EVALSHIELD-PRO-v1.',
    PAY_TO_EVM_ADDRESS: '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206',
    BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    BASE_CHAIN_ID: '8453',
    BASE_RPC_URL: 'http://127.0.0.1:1/dead',
    TEAM_PRICE_USDC_ATOMIC: '99000000',
    ENTERPRISE_PRICE_USDC_ATOMIC: '499000000',
    MIN_CONFIRMATIONS: '2',
    CHALLENGE_TTL_SECONDS: '300',
    DOWNLOAD_TTL_SECONDS: '600',
    TX_CLAIM_LOCK: createMemoryTxClaimLockNamespace(),
    LICENSE_SIGNING_PRIVATE_JWK: privateJwkJson,
    LICENSE_SIGNING_PUBLIC_SPKI_B64: spkiB64,
    DOWNLOAD_HMAC_SECRET: '0123456789abcdef0123456789abcdef'
  };

  const chRes = await app.request(
    'https://evalshield.test/api/challenge',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, tier: 'team' }) },
    env
  );
  assert.equal(chRes.status, 200);
  const { nonce, message } = await chRes.json();
  const signature = await payer.signMessage({ message });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:1/dead')) {
      const rpcReq = JSON.parse(String(init?.body ?? '{}'));
      if (rpcReq.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: rpcReq.id, result: '0x64' });
      if (rpcReq.method === 'eth_getTransactionReceipt') {
        return Response.json({
          jsonrpc: '2.0',
          id: rpcReq.id,
          result: {
            status: '0x1',
            blockNumber: '0x60',
            logs: [
              encodeTransferLog({
                usdcContract: env.BASE_USDC_CONTRACT,
                from: payer.address,
                to: env.PAY_TO_EVM_ADDRESS,
                amountAtomic: 99_000_000n
              })
            ]
          }
        });
      }
    }
    return origFetch(url, init);
  };

  try {
    // Concurrent reuse of the SAME challenge nonce -> exactly 1 succeeds (200), 1 rejected (403)
    const [v1, v2] = await Promise.all([
      app.request(
        'https://evalshield.test/api/verify',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, nonce, signature, tier: 'team' }) },
        env
      ),
      app.request(
        'https://evalshield.test/api/verify',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, nonce, signature, tier: 'team' }) },
        env
      )
    ]);
    assert.deepEqual([v1.status, v2.status].sort((a, b) => a - b), [200, 403]);
    const okVerify = v1.status === 200 ? await v1.json() : await v2.json();

    // Concurrent Promise.all on /api/download (max 3 downloads): 4 parallel calls -> strictly 3 x 200 and 1 x 403
    const dls = await Promise.all(
      [1, 2, 3, 4].map(() => app.request(`https://evalshield.test${okVerify.downloadUrl}`, {}, env))
    );
    const dlStatuses = dls.map((r) => r.status).sort((a, b) => a - b);
    assert.deepEqual(dlStatuses, [200, 200, 200, 403]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('eth_call RPC outage returns 502 preserving DO nonce, streaming >32KB aborts 413, CL/MCL map to ENERGY, and DO alarm prunes expired entries', async () => {
  const { privateJwkJson, spkiB64 } = await generateEd25519TestKeys();
  const smartWallet = '0x5555555555555555555555555555555555555555';
  const txHash = '0x' + '88'.repeat(32);
  const smartSig = '0x' + 'de'.repeat(128);

  const txLockNs = createMemoryTxClaimLockNamespace();
  const env = {
    BRAND_NAME: 'ApexHive Labs',
    PRODUCT_ID: 'evalshield-copilot',
    TOKEN_PREFIX: 'EVALSHIELD-PRO-v1.',
    PAY_TO_EVM_ADDRESS: '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206',
    BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    BASE_CHAIN_ID: '8453',
    BASE_RPC_URL: 'http://127.0.0.1:1/dead',
    TEAM_PRICE_USDC_ATOMIC: '99000000',
    ENTERPRISE_PRICE_USDC_ATOMIC: '499000000',
    MIN_CONFIRMATIONS: 'abc',
    CHALLENGE_TTL_SECONDS: 'not-a-number',
    DOWNLOAD_TTL_SECONDS: 'xyz',
    TX_CLAIM_LOCK: txLockNs,
    LICENSE_SIGNING_PRIVATE_JWK: privateJwkJson,
    LICENSE_SIGNING_PUBLIC_SPKI_B64: spkiB64,
    DOWNLOAD_HMAC_SECRET: '0123456789abcdef0123456789abcdef'
  };

  // 1. Streaming >32KB without Content-Length aborts cleanly with 413
  let chunksPulled = 0;
  const chunkedReq = new Request('https://evalshield.test/api/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    duplex: 'half',
    body: new ReadableStream({
      pull(controller) {
        chunksPulled += 1;
        if (chunksPulled <= 10) controller.enqueue(new Uint8Array(8192).fill(0x61));
        else controller.close();
      }
    })
  });
  const chunkRes = await app.fetch(chunkedReq, env);
  assert.equal(chunkRes.status, 413);
  assert.ok(chunksPulled <= 6);

  // 2. CL + MCL map to ENERGY bucket in /api/cloud/portfolio-guard
  const energyRes = await app.request(
    'https://evalshield.test/api/cloud/portfolio-guard',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        positions: [
          { accountId: 'acc1', symbol: 'CL', side: 'LONG', qty: 1 },
          { accountId: 'acc2', symbol: 'MCL', side: 'SHORT', qty: 1 }
        ]
      })
    },
    env
  );
  assert.equal(energyRes.status, 200);
  const energyJson = await energyRes.json();
  assert.ok(energyJson.correlatedBuckets.ENERGY);
  assert.equal(energyJson.safeToProceed, false);

  // 3. eth_call outage returns 502 RPC_UNAVAILABLE and preserves challenge nonce for retry
  const chRes = await app.request(
    'https://evalshield.test/api/challenge',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, tier: 'team' }) },
    env
  );
  assert.equal(chRes.status, 200);
  const { nonce } = await chRes.json();

  let failEthCall = true;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:1/dead')) {
      const rpcReq = JSON.parse(String(init?.body ?? '{}'));
      if (rpcReq.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: rpcReq.id, result: '0x64' });
      if (rpcReq.method === 'eth_getTransactionReceipt') {
        return Response.json({
          jsonrpc: '2.0',
          id: rpcReq.id,
          result: {
            status: '0x1',
            blockNumber: '0x60',
            logs: [
              encodeTransferLog({
                usdcContract: env.BASE_USDC_CONTRACT,
                from: smartWallet,
                to: env.PAY_TO_EVM_ADDRESS,
                amountAtomic: 99_000_000n
              })
            ]
          }
        });
      }
      if (rpcReq.method === 'eth_call') {
        if (failEthCall) {
          return new Response('Upstream RPC down', { status: 503 });
        }
        return Response.json({ jsonrpc: '2.0', id: rpcReq.id, result: BOOL_TRUE_HEX });
      }
    }
    return origFetch(url, init);
  };

  try {
    const r502 = await app.request(
      'https://evalshield.test/api/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, nonce, signature: smartSig, tier: 'team' })
      },
      env
    );
    assert.equal(r502.status, 502);
    assert.equal((await r502.json()).error, 'RPC_UNAVAILABLE');

    // Nonce MUST still be valid when RPC recovers
    failEthCall = false;
    const r200 = await app.request(
      'https://evalshield.test/api/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, nonce, signature: smartSig, tier: 'team' })
      },
      env
    );
    assert.equal(r200.status, 200);
  } finally {
    globalThis.fetch = origFetch;
  }

  // 4. DO alarm() cleans up expired challenge/grant records
  const doMem = new Map();
  const alarmDo = new TxClaimLockDO({
    storage: {
      async get(k) { return doMem.get(k); },
      async put(k, v) { doMem.set(k, v); },
      async delete(k) { return doMem.delete(k); }
    }
  });
  doMem.set('challenge', {
    nonce: 'n-old',
    txHash: '0x' + '11'.repeat(32),
    tier: 'team',
    ts: 1,
    message: 'm',
    expiresAtMs: Date.now() - 1000,
    consumed: false
  });
  doMem.set('grant', {
    txHash: '0x' + '11'.repeat(32),
    payer: smartWallet,
    tier: 'team',
    remainingDownloads: 2,
    createdAt: 1,
    expiresAtMs: Date.now() - 1000,
    licenseToken: 'tok'
  });
  await alarmDo.alarm();
  assert.equal(doMem.has('challenge'), false);
  assert.equal(doMem.has('grant'), false);
});
