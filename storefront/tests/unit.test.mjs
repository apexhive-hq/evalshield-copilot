import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import app from '../src/index.ts';

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

test('Config, health, fail-closed 500 secrets, strict tier, pre-KV HMAC download, and cross-product replay block', async () => {
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
    SOLO_PRICE_USDC_ATOMIC: '29000000',
    TEAM_PRICE_USDC_ATOMIC: '99000000',
    MIN_CONFIRMATIONS: '2',
    CHALLENGE_TTL_SECONDS: '300',
    DOWNLOAD_TTL_SECONDS: '600',
    LICENSES_KV: licensesKv,
    GLOBAL_CLAIMED_TX_KV: globalKv
  };

  const verify500 = await app.request(
    'https://evalshield.test/api/verify',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, nonce: 'n1', signature: '0x' + '11'.repeat(65), tier: 'solo' })
    },
    misconfiguredEnv
  );
  assert.equal(verify500.status, 500);
  assert.equal(licensesKv.counts.getCount, 0);

  const env = {
    ...misconfiguredEnv,
    LICENSE_SIGNING_PRIVATE_JWK: privateJwkJson,
    LICENSE_SIGNING_PUBLIC_SPKI_B64: spkiB64,
    DOWNLOAD_HMAC_SECRET: '0123456789abcdef0123456789abcdef'
  };

  const cfgRes = await app.request('https://evalshield.test/api/config', {}, env);
  assert.equal(cfgRes.status, 200);
  const cfg = await cfgRes.json();
  assert.equal(cfg.supportEmail, 'apexhive.hq@proton.me');
  assert.equal(cfg.tiers.solo.priceAtomic, '29000000');
  assert.equal(cfg.tiers.team.priceAtomic, '99000000');

  const badTierCh = await app.request(
    'https://evalshield.test/api/challenge',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, tier: 'enterprise' })
    },
    env
  );
  assert.equal(badTierCh.status, 400);
  assert.equal((await badTierCh.json()).error, 'INVALID_TIER');

  const badTierVf = await app.request(
    'https://evalshield.test/api/verify',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash, nonce: 'n1', signature: '0x' + '11'.repeat(65), tier: 'enterprise' })
    },
    env
  );
  assert.equal(badTierVf.status, 400);
  assert.equal((await badTierVf.json()).error, 'INVALID_TIER');
  assert.equal(licensesKv.counts.getCount, 0);

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
      body: JSON.stringify({ txHash, tier: 'solo' })
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
                amountAtomic: 29_000_000n
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
        body: JSON.stringify({ txHash, nonce, signature, tier: 'solo' })
      },
      env
    );
    assert.equal(replayRes.status, 403);
    assert.equal((await replayRes.json()).error, 'TX_ALREADY_CLAIMED_ELSEWHERE');
  } finally {
    globalThis.fetch = originalFetchSafe(origFetch);
  }
});

function originalFetchSafe(orig) {
  return orig;
}
