import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT_DIR = path.resolve(__dirname, '..');
const HQ_ROOT = path.resolve(STOREFRONT_DIR, '..', '..', '..');
const CACHES_DIR = existsSync(path.join(HQ_ROOT, 'departments', 'infra', '.caches'))
  ? path.join(HQ_ROOT, 'departments', 'infra', '.caches')
  : path.join(HQ_ROOT, '.caches');

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TREASURY = '0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206';
const BOOL_TRUE_HEX = '0x' + '0'.repeat(63) + '1';
const BOOL_FALSE_HEX = '0x' + '0'.repeat(64);

function resolveWranglerLaunch() {
  const localJs = path.join(STOREFRONT_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (existsSync(localJs)) {
    return { command: process.execPath, prefixArgs: [localJs], shell: false };
  }
  const localWin = path.join(STOREFRONT_DIR, 'node_modules', '.bin', 'wrangler.cmd');
  const localPosix = path.join(STOREFRONT_DIR, 'node_modules', '.bin', 'wrangler');
  if (process.platform === 'win32' && existsSync(localWin)) {
    return { command: localWin, prefixArgs: [], shell: true };
  }
  if (process.platform !== 'win32' && existsSync(localPosix)) {
    return { command: localPosix, prefixArgs: [], shell: false };
  }
  return {
    command: process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
    prefixArgs: [],
    shell: process.platform === 'win32'
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
  });
}

function encodeTransferLog({ from, to, amountAtomic }) {
  const topicSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const padAddr = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return {
    address: USDC_CONTRACT,
    topics: [topicSig, padAddr(from), padAddr(to)],
    data: '0x' + amountAtomic.toString(16).padStart(64, '0')
  };
}

async function generateEd25519Pair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return {
    privateJwkJson: JSON.stringify(privJwk),
    spkiB64: Buffer.from(spki).toString('base64')
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
    } else if (body.method === 'eth_call') {
      const data = String(body.params?.[0]?.data ?? '').toLowerCase();
      const ok = data.includes(state.smartWalletAddr.slice(2).toLowerCase()) && data.includes('cc'.repeat(32));
      result = ok ? BOOL_TRUE_HEX : BOOL_FALSE_HEX;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForHealth(baseUrl, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
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
  await new Promise((r) => setTimeout(r, 500));
}

test('End-to-end evalshield-copilot v2.0 Wrangler DO lock + ERC-1271 + Cloud Pro API + Playwright UI', async () => {
  const payer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const attacker = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const smartWalletAddr = '0x4444444444444444444444444444444444444444';
  const smartWalletSig = '0x' + 'cc'.repeat(256);

  const devVarsPath = path.join(STOREFRONT_DIR, '.dev.vars');
  const stateDir = path.join(STOREFRONT_DIR, '.wrangler-state');
  const preExistingDevVars = await fs.readFile(devVarsPath, 'utf8').catch(() => null);
  await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

  const { privateJwkJson, spkiB64 } = await generateEd25519Pair();
  const txSoloApi = '0x' + '11'.repeat(32);
  const txTeamMulti = '0x' + '22'.repeat(32);
  const txSmartRace = '0x' + '33'.repeat(32);
  const txUiSolo = '0x' + '44'.repeat(32);
  const txUiTeam = '0x' + '55'.repeat(32);

  const rpcState = {
    flakyHits: 0,
    headBlock: 100,
    smartWalletAddr,
    receipts: new Map([
      [
        txSoloApi,
        {
          status: '0x1',
          blockNumber: '0x64',
          logs: [encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 29_000_000n })]
        }
      ],
      [
        txTeamMulti,
        {
          status: '0x1',
          blockNumber: '0x62',
          logs: [
            encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 49_000_000n }),
            encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 50_000_000n })
          ]
        }
      ],
      [
        txSmartRace,
        {
          status: '0x1',
          blockNumber: '0x62',
          logs: [encodeTransferLog({ from: smartWalletAddr, to: TREASURY, amountAtomic: 99_000_000n })]
        }
      ],
      [
        txUiSolo,
        {
          status: '0x1',
          blockNumber: '0x62',
          logs: [encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 29_000_000n })]
        }
      ],
      [
        txUiTeam,
        {
          status: '0x1',
          blockNumber: '0x62',
          logs: [encodeTransferLog({ from: payer.address, to: TREASURY, amountAtomic: 99_000_000n })]
        }
      ]
    ])
  };

  const rpcServer = await startMockBaseRpc(rpcState);
  const rpcPort = rpcServer.address().port;
  const wranglerPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${wranglerPort}`;

  await fs.writeFile(
    devVarsPath,
    [
      `LICENSE_SIGNING_PRIVATE_JWK=${privateJwkJson}`,
      `LICENSE_SIGNING_PUBLIC_SPKI_B64=${spkiB64}`,
      `DOWNLOAD_HMAC_SECRET=e2e-evalshield-hmac-secret-32-bytes`,
      `BASE_RPC_URLS=http://127.0.0.1:${rpcPort}/flaky,http://127.0.0.1:${rpcPort}/ok`,
      `BASE_RPC_URL=http://127.0.0.1:${rpcPort}/ok`
    ].join('\n'),
    'utf8'
  );

  let wranglerProc = null;
  let browser = null;

  try {
    const wranglerLaunch = resolveWranglerLaunch();
    const wranglerEnv = {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false'
    };
    if (existsSync(CACHES_DIR)) {
      wranglerEnv.APPDATA = path.join(CACHES_DIR, 'roaming');
      wranglerEnv.LOCALAPPDATA = path.join(CACHES_DIR, 'local');
      wranglerEnv.XDG_CONFIG_HOME = path.join(CACHES_DIR, 'xdg');
    }

    wranglerProc = spawn(
      wranglerLaunch.command,
      [
        ...wranglerLaunch.prefixArgs,
        'dev',
        '--local',
        '--port',
        String(wranglerPort),
        '--ip',
        '127.0.0.1',
        '--persist-to',
        '.wrangler-state'
      ],
      {
        cwd: STOREFRONT_DIR,
        shell: wranglerLaunch.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: wranglerEnv
      }
    );
    const wranglerLogs = [];
    const pushLog = (chunk) => {
      wranglerLogs.push(String(chunk));
      if (wranglerLogs.length > 40) wranglerLogs.shift();
    };
    wranglerProc.stdout?.on('data', pushLog);
    wranglerProc.stderr?.on('data', pushLog);

    try {
      await waitForHealth(baseUrl);
    } catch (err) {
      throw new Error(`${err.message}\nWrangler logs:\n${wranglerLogs.join('')}`);
    }

    // 1. Health, config, charset & favicon checks
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.ok((healthRes.headers.get('content-type') || '').includes('charset=utf-8'));
    const healthJson = await healthRes.json();
    assert.equal(healthJson.readOnlyFirewall, true);
    assert.equal(healthJson.service, 'evalshield-copilot');
    assert.equal(healthJson.durableObjectLockBound, true);
    assert.deepEqual(healthJson.smartWalletSupport, ['EOA', 'ERC-1271', 'EIP-6492']);

    const cfgRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.supportEmail, 'apexhive.hq@proton.me');
    assert.equal(cfg.tiers.free.maxAccounts, null);
    assert.equal(cfg.tiers.solo.priceAtomic, '29000000');
    assert.equal(cfg.tiers.team.priceAtomic, '99000000');
    assert.equal((await fetch(`${baseUrl}/favicon.svg`)).status, 200);

    // 2. API Checkout: 1-conf retry preserving nonce, 3 downloads -> 403, reclaim, attacker 403, 99 USDC multi-log
    const chSolo = await (
      await fetch(`${baseUrl}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSoloApi, tier: 'solo' })
      })
    ).json();
    const sigSolo = await payer.signMessage({ message: chSolo.message });

    const conf1 = await fetch(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: txSoloApi, nonce: chSolo.nonce, signature: sigSolo, tier: 'solo' })
    });
    assert.equal(conf1.status, 403);
    assert.equal((await conf1.json()).error, 'INSUFFICIENT_CONFIRMATIONS');
    assert.ok(rpcState.flakyHits >= 2, 'Expected RPC failover across flaky 429/500 endpoints');

    rpcState.headBlock = 101;
    const conf2 = await fetch(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: txSoloApi, nonce: chSolo.nonce, signature: sigSolo, tier: 'solo' })
    });
    assert.equal(conf2.status, 200);
    const outSolo = await conf2.json();
    assert.equal(outSolo.tier, 'solo');
    assert.equal(outSolo.maxAccounts, 20);
    assert.ok(outSolo.licenseToken.startsWith('EVALSHIELD-PRO-v1.'));
    assert.ok(outSolo.activationCommand.startsWith('node apps/cli/dist/src/cli.js activate --token '));

    for (let i = 0; i < 3; i += 1) {
      const dl = await fetch(`${baseUrl}${outSolo.downloadUrl}`);
      assert.equal(dl.status, 200);
    }
    const dl4 = await fetch(`${baseUrl}${outSolo.downloadUrl}`);
    assert.equal(dl4.status, 403);

    const chReclaim = await (
      await fetch(`${baseUrl}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSoloApi, tier: 'solo' })
      })
    ).json();
    const reclaimRes = await fetch(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        txHash: txSoloApi,
        nonce: chReclaim.nonce,
        signature: await payer.signMessage({ message: chReclaim.message }),
        tier: 'solo'
      })
    });
    assert.equal(reclaimRes.status, 200);
    assert.equal((await reclaimRes.json()).reclaimed, true);

    const chAtk = await (
      await fetch(`${baseUrl}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSoloApi, tier: 'solo' })
      })
    ).json();
    const atkRes = await fetch(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        txHash: txSoloApi,
        nonce: chAtk.nonce,
        signature: await attacker.signMessage({ message: chAtk.message }),
        tier: 'solo'
      })
    });
    assert.equal(atkRes.status, 403);

    const chTeam = await (
      await fetch(`${baseUrl}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txTeamMulti, tier: 'team' })
      })
    ).json();
    const teamRes = await fetch(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        txHash: txTeamMulti,
        nonce: chTeam.nonce,
        signature: await payer.signMessage({ message: chTeam.message }),
        tier: 'team'
      })
    });
    assert.equal(teamRes.status, 200);
    const outTeam = await teamRes.json();
    assert.equal(outTeam.tier, 'team');
    assert.equal(outTeam.maxAccounts, null);
    assert.equal(outTeam.paidAtomic, '99000000');

    // 2b. Live Wrangler TxClaimLockDO concurrent Promise.all race with 256-byte ERC-1271 Smart Wallet
    const [swCh1, swCh2] = await Promise.all([
      (await fetch(`${baseUrl}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSmartRace, tier: 'solo' })
      })).json(),
      (await fetch(`${baseUrl}/api/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSmartRace, tier: 'team' })
      })).json()
    ]);
    const [swRes1, swRes2] = await Promise.all([
      fetch(`${baseUrl}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSmartRace, nonce: swCh1.nonce, signature: smartWalletSig, tier: 'solo' })
      }),
      fetch(`${baseUrl}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: txSmartRace, nonce: swCh2.nonce, signature: smartWalletSig, tier: 'team' })
      })
    ]);
    assert.deepEqual([swRes1.status, swRes2.status].sort((a, b) => a - b), [200, 403]);

    // 2c. Live Cloud Pro API checks against real Wrangler workerd
    const unauthMc = await fetch(`${baseUrl}/api/cloud/monte-carlo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: 5000 })
    });
    assert.equal(unauthMc.status, 401);

    const authMc = await fetch(`${baseUrl}/api/cloud/monte-carlo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${outSolo.licenseToken}`
      },
      body: JSON.stringify({ runs: 15000, accounts: 2, winRate: 50, rewardRiskRatio: 1.5, riskPerTradeUsd: 250 })
    });
    assert.equal(authMc.status, 200);
    const mcLive = await authMc.json();
    assert.equal(mcLive.runs, 15000);
    assert.equal(mcLive.accountsSimulated, 2);

    const calLive = await (
      await fetch(`${baseUrl}/api/cloud/blackout-calendar`, {
        headers: { authorization: `Bearer ${outTeam.licenseToken}` }
      })
    ).json();
    assert.equal(calLive.authenticated, true);
    assert.equal(calLive.tier, 'team');
    assert.ok(calLive.events.length >= 5);

    const relaySsrf = await fetch(`${baseUrl}/api/cloud/relay/alert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${outSolo.licenseToken}` },
      body: JSON.stringify({ alertType: 'TILT_LOCKOUT', dryRun: false, webhookUrl: 'http://127.0.0.1:4210/api/health' })
    });
    assert.equal(relaySsrf.status, 400);

    // 3. Playwright checks (resolve sandbox cache BEFORE dynamic import)
    const cachedPlaywrightDir = path.join(CACHES_DIR, 'ms-playwright');
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(cachedPlaywrightDir)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = cachedPlaywrightDir;
    }
    const { chromium } = await import('playwright');
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

      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      const hidden = await page.locator('#wallet-pay-btn').evaluate(
        (el) => el.hasAttribute('hidden') && getComputedStyle(el).display === 'none' && el.offsetParent === null
      );
      assert.equal(hidden, true);
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('apexhive.hq@proton.me'));
      assert.ok(bodyText.includes('Human-in-the-Loop Firewall'));
      await page.click('#cloud-blackouts-btn');
      await page.waitForFunction(() => document.getElementById('cloud-preview-output')?.textContent?.includes('preview'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      assert.deepEqual(errors, []);
      await ctx.close();
    }

    // 3b) Interactive Desktop & Mobile checks with Base EIP-1193 wallet
    for (const vp of [
      { width: 1440, height: 900, tag: 'desktop' },
      { width: 375, height: 812, tag: 'mobile' }
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
          }
        };
      }, payer.address);

      await page.goto(baseUrl, { waitUntil: 'networkidle' });

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
      await fs.writeFile(devVarsPath, preExistingDevVars, 'utf8').catch(() => {});
    } else {
      await fs.rm(devVarsPath, { force: true }).catch(() => {});
    }
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 }).catch(() => {});
  }
});
