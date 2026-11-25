import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT_DIR = path.resolve(__dirname, '..');
const WRANGLER_PORT = 4210;
const RPC_PORT = 4211;
const BASE_URL = `http://127.0.0.1:${WRANGLER_PORT}`;
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TREASURY = '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206';

function encodeTransferLog({ from, to, amountAtomic }) {
  const topicSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const padAddr = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return {
    address: USDC_CONTRACT,
    topics: [topicSig, padAddr(from), padAddr(to)],
    data: '0x' + amountAtomic.toString(16).padStart(64, '0'),
  };
}

async function generateEd25519Pair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return {
    privateJwkJson: JSON.stringify(privJwk),
    spkiB64: Buffer.from(spki).toString('base64'),
  };
}

function startMockBaseRpc(state) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/flaky') {
      state.flakyHits += 1;
      const status = state.flakyHits % 2 === 1 ? 429 : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `simulated flaky HTTP ${status}` }));
      return;
    }
    if (req.url !== '/ok' || req.method !== 'POST') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let result = null;
    if (body.method === 'eth_blockNumber') {
      result = '0x' + state.headBlock.toString(16);
    } else if (body.method === 'eth_getTransactionReceipt') {
      result = state.receipts.get(String(body.params?.[0] ?? '').toLowerCase()) ?? null;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(RPC_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return;
    } catch {
      // poll until healthy
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('wrangler dev timed out waiting for /api/health');
}

async function killProcessTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(proc.pid), '/T', '/F']).catch(() => {});
  } else {
    proc.kill('SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 350));
}

test('End-to-end evalshield-copilot Wrangler + RPC failover + 29/99 USDC + Playwright Desktop/Mobile', async () => {
  const payer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const attacker = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

  const devVarsPath = path.join(STOREFRONT_DIR, '.dev.vars');
  const stateDir = path.join(STOREFRONT_DIR, '.wrangler-state');
  const preExistingDevVars = await fs.readFile(devVarsPath, 'utf8').catch(() => null);
  await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

  const { privateJwkJson, spkiB64 } = await generateEd25519Pair();
  const txSoloApi = '0x' + '11'.repeat(32);
  const txTeamMulti = '0x' + '22'.repeat(32);
  const txUiSolo = '0x' + '44'.repeat(32);
  const txUiTeam = '0x' + '55'.repeat(32);

  const rpcState = {
    flakyHits: 0,
    headBlock: 100,
    receipts: new Map([
      [
        txSoloApi,
        {
          status: '0x1',
          blockNumber: '0x64',
          logs: [encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 29_000_000n })],
        },
      ],
      [
        txTeamMulti,
        {
          status: '0x1',
          blockNumber: '0x62',
          logs: [
            encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 49_000_000n }),
            encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 50_000_000n }),
          ],
        },
      ],
      [
        txUiSolo,
        {
          status: '0x1',
          blockNumber: '0x62',
          logs: [encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 29_000_000n })],
        },
      ],
      [
        txUiTeam,
        {
          status: '0x1',
          blockNumber: '0x62',
          logs: [encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 99_000_000n })],
        },
      ],
    ]),
  };

  await fs.writeFile(
    devVarsPath,
    [
      `LICENSE_SIGNING_PRIVATE_JWK=${privateJwkJson}`,
      `LICENSE_SIGNING_PUBLIC_SPKI_B64=${spkiB64}`,
      `DOWNLOAD_HMAC_SECRET=e2e-evalshield-hmac-secret-32-bytes`,
      `BASE_RPC_URLS=http://127.0.0.1:${RPC_PORT}/flaky,http://127.0.0.1:${RPC_PORT}/ok`,
      `BASE_RPC_URL=http://127.0.0.1:${RPC_PORT}/ok`,
    ].join('\n'),
    'utf8'
  );

  const rpcServer = await startMockBaseRpc(rpcState);
  let wranglerProc = null;
  let browser = null;

  try {
    const wranglerArgs = [
      'dev',
      '--local',
      '--port',
      String(WRANGLER_PORT),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      '.wrangler-state',
    ];
    wranglerProc =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', 'wrangler', ...wranglerArgs], {
            cwd: STOREFRONT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
          })
        : spawn('wrangler', wranglerArgs, {
            cwd: STOREFRONT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
          });

    await waitForHealth();

    // 1. Health, config, charset & favicon checks
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.ok((healthRes.headers.get('content-type') || '').includes('charset=utf-8'));
    const healthJson = await healthRes.json();
    assert.equal(healthJson.readOnlyFirewall, true);
    assert.equal(healthJson.service, 'evalshield-copilot');

    const cfgRes = await fetch(`${BASE_URL}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.supportEmail, 'apexhive.hq@proton.me');
    assert.equal(cfg.tiers.solo.priceAtomic, '29000000');
    assert.equal(cfg.tiers.team.priceAtomic, '99000000');
    assert.equal((await fetch(`${BASE_URL}/favicon.svg`)).status, 200);

    // 2. API Checkout: 1-conf retry preserving nonce, 3 downloads -> 403, reclaim, attacker 403, 99 USDC multi-log
    const chSolo = await (
      await fetch(`${BASE_URL}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSoloApi, tier: 'solo' }),
      })
    ).json();
    const sigSolo = await payer.signMessage({ message: chSolo.message });

    const conf1 = await fetch(`${BASE_URL}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: txSoloApi, nonce: chSolo.nonce, signature: sigSolo, tier: 'solo' }),
    });
    assert.equal(conf1.status, 403);
    assert.equal((await conf1.json()).error, 'INSUFFICIENT_CONFIRMATIONS');
    assert.ok(rpcState.flakyHits >= 2, 'Expected RPC failover across flaky 429/500 endpoints');

    rpcState.headBlock = 101;
    const conf2 = await fetch(`${BASE_URL}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: txSoloApi, nonce: chSolo.nonce, signature: sigSolo, tier: 'solo' }),
    });
    assert.equal(conf2.status, 200);
    const outSolo = await conf2.json();
    assert.equal(outSolo.tier, 'solo');
    assert.equal(outSolo.maxAccounts, 20);
    assert.ok(outSolo.licenseToken.startsWith('EVALSHIELD-PRO-v1.'));
    assert.ok(outSolo.activationCommand.startsWith('node apps/cli/dist/src/cli.js activate --token '));

    for (let i = 0; i < 3; i += 1) {
      const dl = await fetch(`${BASE_URL}${outSolo.downloadUrl}`);
      assert.equal(dl.status, 200);
    }
    const dl4 = await fetch(`${BASE_URL}${outSolo.downloadUrl}`);
    assert.equal(dl4.status, 403);

    const chReclaim = await (
      await fetch(`${BASE_URL}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSoloApi, tier: 'solo' }),
      })
    ).json();
    const reclaimRes = await fetch(`${BASE_URL}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        txHash: txSoloApi,
        nonce: chReclaim.nonce,
        signature: await payer.signMessage({ message: chReclaim.message }),
        tier: 'solo',
      }),
    });
    assert.equal(reclaimRes.status, 200);
    assert.equal((await reclaimRes.json()).reclaimed, true);

    const chAtk = await (
      await fetch(`${BASE_URL}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSoloApi, tier: 'solo' }),
      })
    ).json();
    const atkRes = await fetch(`${BASE_URL}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        txHash: txSoloApi,
        nonce: chAtk.nonce,
        signature: await attacker.signMessage({ message: chAtk.message }),
        tier: 'solo',
      }),
    });
    assert.equal(atkRes.status, 403);

    const chTeam = await (
      await fetch(`${BASE_URL}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txTeamMulti, tier: 'team' }),
      })
    ).json();
    const teamRes = await fetch(`${BASE_URL}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        txHash: txTeamMulti,
        nonce: chTeam.nonce,
        signature: await payer.signMessage({ message: chTeam.message }),
        tier: 'team',
      }),
    });
    assert.equal(teamRes.status, 200);
    const outTeam = await teamRes.json();
    assert.equal(outTeam.tier, 'team');
    assert.equal(outTeam.maxAccounts, null);
    assert.equal(outTeam.paidAtomic, '99000000');

    // 3. Playwright checks (no-wallet + desktop 1440x900 + mobile 375x812)
    browser = await chromium.launch({ headless: true });

    // 3a) No-wallet desktop check: #wallet-pay-btn must remain CSS hidden
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      const hidden = await page.locator('#wallet-pay-btn').evaluate(
        (el) => el.hasAttribute('hidden') && getComputedStyle(el).display === 'none' && el.offsetParent === null
      );
      assert.equal(hidden, true);
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('apexhive.hq@proton.me'));
      assert.ok(bodyText.includes('Human-in-the-Loop Firewall'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      assert.deepEqual(errors, []);
      await ctx.close();
    }

    // 3b) Interactive Desktop & Mobile checks with Base EIP-1193 wallet
    for (const vp of [
      { width: 1440, height: 900, tag: 'desktop' },
      { width: 375, height: 812, tag: 'mobile' },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const errors = [];
      const sentTxs = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));

      await page.exposeFunction('__signEip191', async (msg) => payer.signMessage({ message: msg }));
      await page.exposeFunction('__dispatchMockTx', async (txReq) => {
        sentTxs.push(txReq);
        const d = String(txReq.data || '').toLowerCase();
        if (d.endsWith(99_000_000n.toString(16).padStart(64, '0'))) return txUiTeam;
        return txUiSolo;
      });

      await page.addInitScript((addr) => {
        window.ethereum = {
          isMetaMask: true,
          async request({ method, params }) {
            if (method === 'eth_chainId') return '0x2105';
            if (method === 'eth_requestAccounts') return [addr];
            if (method === 'eth_sendTransaction') return window.__dispatchMockTx(params[0]);
            if (method === 'personal_sign') return window.__signEip191(params[0]);
            throw new Error('Unsupported wallet method: ' + method);
          },
        };
      }, payer.address);

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });

      // Module A & B Shield calculator preset + tilt lockout
      await page.click('[data-preset="apex50k"]');
      assert.equal(await page.locator('#inp-mode').inputValue(), 'INTRADAY_TRAILING');
      assert.ok((await page.locator('#out-floor').innerText()).includes('49,300'));
      await page.fill('#inp-losses', '3');
      await page.dispatchEvent('#inp-losses', 'input');
      assert.equal((await page.locator('#out-contracts').innerText()).startsWith('0 '), true);
      assert.ok((await page.locator('#out-advisory').innerText()).includes('TILT_COOLDOWN_ACTIVE'));

      // Reset losses and verify Monte Carlo 10k simulation SVG bars
      await page.fill('#inp-losses', '0');
      await page.dispatchEvent('#inp-losses', 'input');
      await page.click('#mc-run-btn');
      assert.equal(await page.locator('#mc-hist-svg rect').count(), 5);
      assert.ok((await page.locator('#mc-pass-pct').innerText()).endsWith('%'));

      if (vp.tag === 'desktop') {
        // 1-click Base USDC Solo (29 USDC) -> Team (99 USDC)
        await page.selectOption('#tier-select', 'solo');
        await page.click('#wallet-pay-btn');
        await page.waitForSelector('#checkout-result:not([hidden])');
        const tokSolo = (await page.locator('#license-token-text').innerText()).trim();
        assert.ok(tokSolo.startsWith('EVALSHIELD-PRO-v1.'));
        assert.ok(sentTxs[0].data.toLowerCase().endsWith(29_000_000n.toString(16).padStart(64, '0')));

        await page.selectOption('#tier-select', 'team');
        await page.click('#wallet-pay-btn');
        await page.waitForSelector('#checkout-result:not([hidden])');
        const tokTeam = (await page.locator('#license-token-text').innerText()).trim();
        assert.notEqual(tokTeam, tokSolo);
        assert.ok(sentTxs[1].data.toLowerCase().endsWith(99_000_000n.toString(16).padStart(64, '0')));
      }

      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
        `Horizontal overflow detected on ${vp.tag}`
      );
      assert.deepEqual(errors, [], `Console/page errors on ${vp.tag}: ${errors.join('; ')}`);
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await killProcessTree(wranglerProc);
    rpcServer.close();
    if (preExistingDevVars !== null) {
      await fs.writeFile(devVarsPath, preExistingDevVars, 'utf8');
    } else {
      await fs.rm(devVarsPath, { force: true });
    }
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  }
});
