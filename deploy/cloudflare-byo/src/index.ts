import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ByoEnv {
  BYO_STATE: DurableObjectNamespace;
  POLL_COINS?: string;
  POLYMARKET_SLUGS?: string;
  NEWS_RESTRICTION?: string;
  BRIEF_UTC_HOUR?: string;
  EXTREME_FUNDING_HOURLY?: string;
  ALERT_WEBHOOK_URL?: string;
  TELEGRAM_CHAT_ID?: string;
  TRADINGVIEW_WEBHOOK_SECRET?: string;
  __FETCH_OVERRIDE?: typeof fetch;
}

const ALLOWED_RELAY_HOSTS = new Set(['discord.com', 'discordapp.com', 'api.telegram.org']);

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function validateByoRelayUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== '443') return null;
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_RELAY_HOSTS.has(host)) return null;
    if (host === 'api.telegram.org') {
      if (!/^\/bot[A-Za-z0-9:_-]+\/sendMessage$/.test(parsed.pathname)) return null;
    } else if (!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(parsed.pathname)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getTzOffsetMin(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
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
}

export function isUsEuDstMismatch(nowMs: number): boolean {
  const diff = Math.round(((getTzOffsetMin(nowMs, 'Europe/Berlin') - getTzOffsetMin(nowMs, 'America/New_York')) / 60) * 10) / 10;
  return Math.abs(diff - 6) > 0.05;
}

function verifyHmacOrBearer(rawBody: string, headerVal: string | null, secret: string): boolean {
  if (!headerVal) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(headerVal.trim())?.[1] ?? headerVal.trim();
  const a = Buffer.from(bearer, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.byteLength === b.byteLength && timingSafeEqual(a, b)) return true;

  const cleanHex = bearer.replace(/^sha256=/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const actual = Buffer.from(cleanHex, 'hex');
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export class BYOStateDO {
  private readonly ctx: {
    storage: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      put<T = unknown>(key: string, val: T): Promise<void>;
    };
  };

  constructor(ctx: {
    storage: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      put<T = unknown>(key: string, val: T): Promise<void>;
    };
  }) {
    this.ctx = ctx;
  }

  async fetch(input: Request | string): Promise<Response> {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/dedup') {
      const body = (await req.json()) as { key?: string; ttlMs?: number };
      const key = String(body.key ?? '').trim();
      if (!key) return Response.json({ ok: false, duplicate: false }, { status: 400 });
      const existing = await this.ctx.storage.get<{ ts: number }>(`seen:${key}`);
      const now = Date.now();
      const ttlMs = Math.max(60_000, Number(body.ttlMs ?? 3_600_000));
      if (existing && now - existing.ts < ttlMs) {
        return Response.json({ ok: true, duplicate: true });
      }
      await this.ctx.storage.put(`seen:${key}`, { ts: now });
      return Response.json({ ok: true, duplicate: false });
    }
    return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  }
}

export async function buildByoBrief(env: ByoEnv, nowMs = Date.now()) {
  const fetchFn = env.__FETCH_OVERRIDE ?? fetch;
  const coins = (env.POLL_COINS || 'BTC,ETH,SOL')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const slugs = (env.POLYMARKET_SLUGS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  const extremeThreshold = Math.max(0.0001, Number(env.EXTREME_FUNDING_HOURLY || '0.0005'));

  const hyperliquid: Array<{ coin: string; markPx: number; hourlyFunding: number; extreme: boolean }> = [];
  try {
    const res = await fetchFn('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(3500)
    });
    if (res.ok) {
      const json = (await res.json()) as [
        { universe?: Array<{ name?: string }> },
        Array<{ markPx?: string; funding?: string }>
      ];
      const wanted = new Set(coins);
      const uni = json?.[0]?.universe ?? [];
      const ctxs = json?.[1] ?? [];
      for (let i = 0; i < uni.length; i += 1) {
        const coin = uni[i]?.name?.toUpperCase();
        if (!coin || !wanted.has(coin)) continue;
        const row = ctxs[i] ?? {};
        const hourlyFunding = Number(row.funding ?? 0);
        hyperliquid.push({
          coin,
          markPx: Number(row.markPx ?? 0),
          hourlyFunding,
          extreme: Math.abs(hourlyFunding) >= extremeThreshold
        });
      }
    }
  } catch {
    // Non-fatal upstream timeout
  }

  const polymarket: Array<{ slug: string; question: string; yesPct: number | null; closed: boolean }> = [];
  for (const slug of slugs) {
    try {
      const res = await fetchFn(
        `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
        { signal: AbortSignal.timeout(3500) }
      );
      if (res.ok) {
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const m = rows?.[0];
        if (m) {
          const p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          polymarket.push({
            slug,
            question: String(m.question ?? slug),
            yesPct: Array.isArray(p) && p[0] !== undefined ? Math.round(Number(p[0]) * 1000) / 10 : null,
            closed: Boolean(m.closed)
          });
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    ok: true,
    mode: 'byo-self-host-solo',
    generatedAtUtc: new Date(nowMs).toISOString(),
    dstMismatch: isUsEuDstMismatch(nowMs),
    hyperliquid,
    polymarket
  };
}

async function sendRelayMessage(env: ByoEnv, title: string, lines: string[]): Promise<{ dispatched: boolean; status?: number }> {
  if (!env.ALERT_WEBHOOK_URL) return { dispatched: false };
  const target = validateByoRelayUrl(env.ALERT_WEBHOOK_URL);
  if (!target) {
    throw new Error('INVALID_ALERT_WEBHOOK_URL: Only HTTPS discord.com/api/webhooks/... or api.telegram.org/bot.../sendMessage allowed.');
  }
  const fetchFn = env.__FETCH_OVERRIDE ?? fetch;
  const isTg = target.hostname.toLowerCase() === 'api.telegram.org';
  const payload = isTg
    ? {
        ...(env.TELEGRAM_CHAT_ID ? { chat_id: env.TELEGRAM_CHAT_ID } : {}),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: `<b>${escapeHtml(title)}</b>\n${lines.map(escapeHtml).join('\n')}`
      }
    : {
        username: 'EvalShield BYO Sentinel (Solo)',
        embeds: [{ title, description: lines.join('\n'), color: 0x10b981 }]
      };

  const upstream = await fetchFn(target.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(4000)
  });
  return { dispatched: upstream.ok, status: upstream.status };
}

export default {
  async fetch(request: Request, env: ByoEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'evalshield-byo-sentinel',
        version: '3.0.2',
        costUsd: 0,
        orderRoutingEnabled: false
      });
    }

    if (request.method === 'GET' && url.pathname === '/brief') {
      return Response.json(await buildByoBrief(env));
    }

    if (request.method === 'POST' && url.pathname === '/webhook/tradingview') {
      const raw = await request.text();
      if (env.TRADINGVIEW_WEBHOOK_SECRET) {
        const hdr = request.headers.get('x-webhook-secret') ?? request.headers.get('authorization');
        if (!verifyHmacOrBearer(raw, hdr, env.TRADINGVIEW_WEBHOOK_SECRET)) {
          return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
        }
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return Response.json({ ok: false, error: 'INVALID_JSON' }, { status: 400 });
      }

      const eventKey = String(body.id ?? body.alertId ?? `${body.symbol ?? 'SYM'}:${body.side ?? 'ALERT'}:${body.time ?? ''}`).slice(0, 120);
      const stub = env.BYO_STATE.get(env.BYO_STATE.idFromName('global'));
      const dedupRes = await stub.fetch('https://do.internal/dedup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: `tv:${eventKey}`, ttlMs: 300_000 })
      });
      const dedup = (await dedupRes.json()) as { duplicate?: boolean };
      if (dedup.duplicate) {
        return Response.json({ ok: true, deduplicated: true, orderRoutingEnabled: false });
      }

      const remainingBuffer = Number(body.remainingBufferUsd ?? 999999);
      const inRedZone = Boolean(body.redZoneActive);
      const suppressed = remainingBuffer <= 0 || inRedZone;
      let dispatched = false;
      if (!suppressed && env.ALERT_WEBHOOK_URL) {
        const out = await sendRelayMessage(env, `[BYO Risk Alert] ${String(body.symbol ?? 'MARKET')}`, [
          `Message: ${String(body.message ?? 'Setup trigger inside safe buffer')}`,
          `Remaining Buffer: $${Math.round(remainingBuffer)} | Order Routing: DISABLED`
        ]);
        dispatched = out.dispatched;
      }

      return Response.json({
        ok: true,
        deduplicated: false,
        suppressedByRiskGuard: suppressed,
        dispatched,
        orderRoutingEnabled: false
      });
    }

    return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  },

  async scheduled(controller: { scheduledTime?: number }, env: ByoEnv): Promise<void> {
    const nowMs = controller.scheduledTime ?? Date.now();
    const brief = await buildByoBrief(env, nowMs);
    const extremeCoins = brief.hyperliquid.filter((h) => h.extreme);
    const utcDate = new Date(nowMs);
    const briefHour = Number(env.BRIEF_UTC_HOUR ?? '13');
    const isBriefSlot = utcDate.getUTCHours() === briefHour && utcDate.getUTCMinutes() < 15;

    if (extremeCoins.length === 0 && !isBriefSlot) {
      return;
    }

    const dedupKey = extremeCoins.length > 0
      ? `hl:${utcDate.toISOString().slice(0, 13)}:${extremeCoins.map((c) => c.coin).join(',')}`
      : `brief:${utcDate.toISOString().slice(0, 10)}`;
    const stub = env.BYO_STATE.get(env.BYO_STATE.idFromName('global'));
    const dedup = (await (
      await stub.fetch('https://do.internal/dedup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: dedupKey, ttlMs: 3_600_000 })
      })
    ).json()) as { duplicate?: boolean };
    if (dedup.duplicate) return;

    const lines = [
      brief.dstMismatch ? 'DST ALERT: US/EU 1-hour overlap shift active' : 'Clock Sync: Normal',
      ...brief.hyperliquid.map(
        (h) => `${h.coin}: $${h.markPx} (hourly funding ${(h.hourlyFunding * 100).toFixed(4)}%)${h.extreme ? ' [EXTREME]' : ''}`
      ),
      ...brief.polymarket.map((p) => `Polymarket ${p.slug}: ${p.yesPct ?? '-'}% YES`)
    ];
    await sendRelayMessage(
      env,
      extremeCoins.length > 0 ? '[EvalShield BYO] Extreme Funding Alert' : '[EvalShield BYO] 15s Morning Brief',
      lines
    );
  }
};
