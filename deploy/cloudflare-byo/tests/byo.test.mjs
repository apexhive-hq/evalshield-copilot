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
            },
            async delete(keys) {
              if (Array.isArray(keys)) {
                let count = 0;
                for (const k of keys) {
                  if (mem.delete(k)) count += 1;
                }
                return count;
              }
              return mem.delete(keys);
            },
            async list(opts) {
              const prefix = opts?.prefix ?? '';
              const limit = opts?.limit ?? 1000;
              const out = new Map();
              for (const [k, v] of mem.entries()) {
                if (k.startsWith(prefix)) {
                  out.set(k, structuredClone(v));
                  if (out.size >= limit) break;
                }
              }
              return out;
            }
          }
        });
        map.set(id, {
          fetch(input, init) {
            return instance.fetch(input instanceof Request ? input : new Request(input, init));
          },
          __instance: instance,
          __mem: mem
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

test('BYO TradingView webhook fails closed (503) without secret, enforces 32KB cap (413), and prunes expired seen:* keys', async () => {
  const ns = createMemoryNamespace();
  const envNoSecret = {
    BYO_STATE: ns
  };

  // Fail-closed 503 SERVICE_UNCONFIGURED when TRADINGVIEW_WEBHOOK_SECRET is unset
  const res503 = await worker.fetch(
    new Request('https://byo.local/webhook/tradingview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tv-unconfigured', symbol: 'ES' })
    }),
    envNoSecret
  );
  assert.equal(res503.status, 503);
  assert.equal((await res503.json()).error, 'SERVICE_UNCONFIGURED');

  // 413 PAYLOAD_TOO_LARGE when > 32KB
  const envWithSecret = {
    BYO_STATE: ns,
    TRADINGVIEW_WEBHOOK_SECRET: 'byo-tv-secret-2026'
  };
  const res413 = await worker.fetch(
    new Request('https://byo.local/webhook/tradingview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'byo-tv-secret-2026' },
      body: JSON.stringify({ id: 'tv-big', pad: 'x'.repeat(40_000) })
    }),
    envWithSecret
  );
  assert.equal(res413.status, 413);
  assert.equal((await res413.json()).error, 'PAYLOAD_TOO_LARGE');

  // Expired seen:* key cleanup via BYOStateDO.pruneExpiredKeys / alarm()
  const stub = ns.get(ns.idFromName('global'));
  await stub.__mem.set('seen:stale-key', { ts: Date.now() - 4_000_000, expiresAt: Date.now() - 1_000 });
  await stub.__instance.alarm();
  assert.equal(stub.__mem.has('seen:stale-key'), false);

  // Streaming chunked request WITHOUT Content-Length exceeding 32KB aborts with 413 PAYLOAD_TOO_LARGE
  let chunksPulled = 0;
  const streamedReq = new Request('https://byo.local/webhook/tradingview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': 'byo-tv-secret-2026' },
    duplex: 'half',
    body: new ReadableStream({
      pull(controller) {
        chunksPulled += 1;
        if (chunksPulled <= 10) {
          controller.enqueue(new Uint8Array(8192).fill(0x78));
        } else {
          controller.close();
        }
      }
    })
  });
  const resChunk413 = await worker.fetch(streamedReq, envWithSecret);
  assert.equal(resChunk413.status, 413);
  assert.equal((await resChunk413.json()).error, 'PAYLOAD_TOO_LARGE');
  assert.ok(chunksPulled <= 6, `Expected early stream cancellation, pulled ${chunksPulled} chunks`);

  // Non-object JSON bodies ("null", "[1,2]", "123") return 400 INVALID_JSON (not 500)
  for (const nonObjBody of ['null', '[1,2]', '"hello"', '123']) {
    const nonObjRes = await worker.fetch(
      new Request('https://byo.local/webhook/tradingview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': 'byo-tv-secret-2026' },
        body: nonObjBody
      }),
      envWithSecret
    );
    assert.equal(nonObjRes.status, 400);
    assert.equal((await nonObjRes.json()).error, 'INVALID_JSON');
  }

  // Non-finite remainingBufferUsd ("N/A", "", null) rejected cleanly with 400 INVALID_PARAMS (no NaN fail-open!)
  for (const badBuf of ['N/A', '', null]) {
    const badBufRes = await worker.fetch(
      new Request('https://byo.local/webhook/tradingview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': 'byo-tv-secret-2026' },
        body: JSON.stringify({ id: 'tv-bad-buf', symbol: 'ES', remainingBufferUsd: badBuf })
      }),
      envWithSecret
    );
    assert.equal(badBufRes.status, 400);
    assert.equal((await badBufRes.json()).error, 'INVALID_PARAMS');
  }
});
