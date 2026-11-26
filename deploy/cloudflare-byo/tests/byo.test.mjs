import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { BYOStateDO, isUsEuDstMismatch, validateByoRelayUrl } from '../src/index.ts';

function createMemoryNamespace() {
  const map = new Map();
  return {
    idFromName(name) {
      return String(name);
    },
    get(id) {
      if (!map.has(id)) {
        const mem = new Map();
        const instance = new BYOStateDO({
          storage: {
            async get(k) {
              return mem.get(k);
            },
            async put(k, v) {
              mem.set(k, structuredClone(v));
            }
          }
        });
        map.set(id, {
          fetch(input, init) {
            return instance.fetch(input instanceof Request ? input : new Request(input, init));
          }
        });
      }
      return map.get(id);
    }
  };
}

test('BYO Self-Host validates relay URLs strictly & checks US/EU DST mismatch', () => {
  assert.ok(validateByoRelayUrl('https://discord.com/api/webhooks/123456/abcdef'));
  assert.ok(validateByoRelayUrl('https://api.telegram.org/bot123:ABC/sendMessage'));
  assert.equal(validateByoRelayUrl('http://127.0.0.1:8080/hook'), null);
  assert.equal(validateByoRelayUrl('https://evil.example/hook'), null);

  assert.equal(isUsEuDstMismatch(Date.UTC(2026, 2, 18, 14, 0, 0)), true);
  assert.equal(isUsEuDstMismatch(Date.UTC(2026, 5, 10, 14, 0, 0)), false);
});

test('BYO TradingView webhook authenticates, deduplicates, suppresses red-zone alerts, and scheduled Cron dispatches cleanly', async () => {
  const sentMessages = [];
  const mockFetch = async (input, init) => {
    const u = String(input);
    if (u.includes('api.hyperliquid.xyz/info')) {
      return Response.json([
        { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
        [
          { markPx: '95500', funding: '0.0008' },
          { markPx: '3450', funding: '0.0001' }
        ]
      ]);
    }
    if (u.includes('discord.com/api/webhooks')) {
      sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(null, { status: 204 });
    }
    return Response.json([]);
  };

  const env = {
    BYO_STATE: createMemoryNamespace(),
    POLL_COINS: 'BTC,ETH',
    BRIEF_UTC_HOUR: '13',
    EXTREME_FUNDING_HOURLY: '0.0005',
    ALERT_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456/token_abc',
    TRADINGVIEW_WEBHOOK_SECRET: 'byo-tv-secret-2026',
    __FETCH_OVERRIDE: mockFetch
  };

  // Unauthorized webhook rejected
  const unauth = await worker.fetch(
    new Request('https://byo.local/webhook/tradingview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tv-1', symbol: 'XAUUSD', side: 'LONG' })
    }),
    env
  );
  assert.equal(unauth.status, 401);

  // Authorized webhook dispatches once, duplicate skips cleanly, red-zone suppressed
  const authReq = () =>
    new Request('https://byo.local/webhook/tradingview', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': 'byo-tv-secret-2026'
      },
      body: JSON.stringify({ id: 'tv-1', symbol: 'XAUUSD', remainingBufferUsd: 850, message: 'London reclaim' })
    });
  const ok1 = await (await worker.fetch(authReq(), env)).json();
  assert.equal(ok1.dispatched, true);
  assert.equal(ok1.deduplicated, false);

  const okDup = await (await worker.fetch(authReq(), env)).json();
  assert.equal(okDup.deduplicated, true);

  const suppressed = await (
    await worker.fetch(
      new Request('https://byo.local/webhook/tradingview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': 'byo-tv-secret-2026' },
        body: JSON.stringify({ id: 'tv-2', symbol: 'ES', redZoneActive: true, remainingBufferUsd: 500 })
      }),
      env
    )
  ).json();
  assert.equal(suppressed.suppressedByRiskGuard, true);
  assert.equal(suppressed.dispatched, false);

  // Scheduled Cron sends extreme funding alert once per hour window
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 2, 18, 13, 0, 0) }, env);
  assert.equal(sentMessages.length, 2); // 1 TV alert + 1 Cron Hyperliquid alert
  assert.ok(sentMessages[1].embeds[0].title.includes('Extreme Funding Alert'));
});
