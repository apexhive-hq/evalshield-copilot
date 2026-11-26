import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_DIR, '..', '..');
const HQ_ROOT = path.resolve(REPO_ROOT, '..', '..');
const CACHED_PLAYWRIGHT_DIR = path.join(HQ_ROOT, 'departments', 'infra', '.caches', 'ms-playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(CACHED_PLAYWRIGHT_DIR)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = CACHED_PLAYWRIGHT_DIR;
}
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(REPO_ROOT, 'storefront', 'node_modules', 'playwright'));

const TRADOVATE_FILLS_CSV = [
  'Fill ID,Order ID,Timestamp,_timestamp,Side,Quantity,Price,Contract,Commission',
  'F1,O1,2026-03-18 09:35:00,2026-03-18T13:35:00.000Z,Buy,1,5000.00,ESH6,2.25',
  'F2,O2,2026-03-18 09:42:00,2026-03-18T13:42:00.000Z,Sell,1,5005.00,ESH6,2.25',
].join('\n');

function signEd25519Token(privateKey, payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(null, Buffer.from(`EVALSHIELD-PRO-v1.${b64}`, 'utf8'), privateKey).toString('base64url');
  return `EVALSHIELD-PRO-v1.${b64}.${sig}`;
}

test('apps/web static dashboard integrates live SQLite journal, risk shield, CSV FIFO, license gate, and Monte Carlo', async () => {
  const journalDist = path.join(REPO_ROOT, 'packages', 'journal', 'dist', 'src', 'index.js');
  await fs.access(journalDist);
  const { createEvalShieldHttpServer, EvalShieldDb } = await import(new URL(`file:///${journalDist.replace(/\\/g, '/')}`).href);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeySpkiB64 = (publicKey.export({ type: 'spki', format: 'der' })).toString('base64');

  const db = new EvalShieldDb(':memory:');
  db.seedDefaultAccountIfEmpty();
  const server = createEvalShieldHttpServer({
    db,
    publicDirs: [path.join(WEB_DIR, 'public')],
    publicKeySpkiB64,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser = null;

  try {
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok((htmlRes.headers.get('content-type') || '').includes('charset=utf-8'));

    browser = await chromium.launch({ headless: true });

    for (const vp of [
      { width: 1440, height: 900, tag: 'desktop' },
      { width: 375, height: 812, tag: 'mobile' },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      assert.ok((await page.locator('#badge-routing').innerText()).includes('Disabled'));
      assert.equal(await page.locator('#mc-hist-svg rect').count(), 5);

      if (vp.tag === 'desktop') {
        // MIT Local Core allows unlimited local accounts & checks ($0 forever)
        await page.fill('#new-acc-name', 'Apex Eval #2');
        await page.click('#create-acc-btn');
        await page.waitForSelector('#account-status.ok:not([hidden])');

        // Activate Solo Cloud Pro token -> updates license badge cleanly
        const token = signEd25519Token(privateKey, {
          v: 1,
          product: 'evalshield-copilot',
          tier: 'solo',
          maxAccounts: 20,
          payer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
          txHash: '0x' + 'ab'.repeat(32),
          issuedAt: Math.floor(Date.now() / 1000) - 60,
          expiresAt: null,
        });
        await page.fill('#license-token-input', token);
        await page.click('#activate-license-btn');
        await page.waitForSelector('#license-status.ok:not([hidden])');
        assert.ok((await page.locator('#badge-license').innerText()).includes('Pro Solo'));

        // Evaluate risk check + Cross-market XAUUSD spread + Pre-Trade Thesis + CSV FIFO import
        await page.selectOption('#risk-symbol', 'XAUUSD');
        await page.fill('#risk-stop-ticks', '200');
        await page.fill('#risk-spread-ticks', '75');
        await page.click('#run-risk-btn');
        await page.waitForFunction(() => document.getElementById('out-contracts')?.textContent?.includes('XAUUSD'));

        await page.locator('details').first().click();
        await page.fill('#pt-thesis', 'London sweep reclaim v3 E2E');
        await page.click('#save-pretrade-btn');
        await page.waitForSelector('#pretrade-status.ok:not([hidden])');

        await page.selectOption('#risk-symbol', 'MNQ');
        await page.fill('#risk-spread-ticks', '0');
        await page.fill('#risk-stop-ticks', '16');
        await page.click('#run-risk-btn');
        await page.waitForFunction(() => document.getElementById('out-contracts')?.textContent?.includes('MNQ'));
        assert.ok((await page.locator('#out-contracts').innerText()).includes('MNQ'));

        await page.fill('#csv-text-input', TRADOVATE_FILLS_CSV);
        await page.click('#import-csv-btn');
        await page.waitForSelector('#journal-status.ok:not([hidden])');
        assert.equal((await page.locator('#sc-trades').innerText()).trim(), '1');
        assert.equal(await page.locator('#trades-tbody tr').count(), 1);
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
    server.close();
    db.close();
  }
});
