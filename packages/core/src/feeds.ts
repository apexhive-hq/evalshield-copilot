import { isRolloverWideningWindowUtc, isUsEuDstMismatchWeek } from './session.js';
import type {
  FifteenSecondBrief,
  HyperliquidAssetCtx,
  PolymarketSignal,
  RssHeadlineItem
} from './types.js';

export type FetchLike = typeof fetch;

const BLOCKED_EXACT_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'api.twitter.com',
  'mobile.twitter.com',
  'api.binance.com',
  'fapi.binance.com',
  'dapi.binance.com',
  'api.bybit.com',
  'localhost',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal'
]);

function isPrivateOrLoopbackIp(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean === '::1' || clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd')) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Validates user-supplied BYO connector URLs with strict SSRF and policy rules:
 * HTTPS-only, zero credentials, zero LAN/metadata IPs, and no X/Twitter or geo-blocked exchange scraping.
 */
export function validateSafeConnectorUrl(
  rawUrl: string,
  options?: { allowLoopbackForTest?: boolean }
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid connector URL: ${rawUrl}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Connector URL must not embed credentials');
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
  if (options?.allowLoopbackForTest && isLoopback && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return parsed;
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Connector URL must use HTTPS (got ${parsed.protocol})`);
  }

  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    throw new Error('X_SCRAPING_DISALLOWED: X/Twitter scraping is banned by architecture policy.');
  }
  if (
    host === 'binance.com' ||
    host.endsWith('.binance.com') ||
    host === 'bybit.com' ||
    host.endsWith('.bybit.com')
  ) {
    throw new Error('GEO_RESTRICTED_EXCHANGE_ENDPOINT: Use Hyperliquid /info instead of geo-blocked Binance/Bybit APIs.');
  }
  if (
    BLOCKED_EXACT_HOSTS.has(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateOrLoopbackIp(host)
  ) {
    throw new Error(`SSRF_BLOCKED_HOST: Disallowed private or reserved host (${host})`);
  }

  return parsed;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  return m?.[1] ? decodeXmlEntities(m[1]) : '';
}

/**
 * Parses standard RSS 2.0 or Atom feeds, applies keyword whitelist filtering,
 * and caps output to at most maxItems (hard ceiling 3) so the UI never bloats.
 */
export function parseRssAtomHeadlineBrief(
  xmlText: string,
  keywords: string[] = [],
  sourceLabel = 'BYO Feed',
  maxItems = 3
): RssHeadlineItem[] {
  const cap = Math.min(3, Math.max(1, maxItems));
  const boundedXml = xmlText.slice(0, 262_144);
  const blocks: string[] = [];

  const itemRe = /<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(boundedXml)) !== null) {
    blocks.push(match[0]);
    if (blocks.length >= 60) break;
  }

  const cleanKeywords = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const out: RssHeadlineItem[] = [];

  for (const blk of blocks) {
    const title = extractTag(blk, 'title');
    if (!title) continue;
    if (cleanKeywords.length > 0) {
      const lower = title.toLowerCase();
      if (!cleanKeywords.some((kw) => lower.includes(kw))) continue;
    }
    let link = extractTag(blk, 'link');
    if (!link) {
      const atomHref = /<link[^>]+href=["']([^"']+)["']/i.exec(blk);
      link = atomHref?.[1] ?? '';
    }
    const publishedAt = extractTag(blk, 'pubDate') || extractTag(blk, 'updated') || null;
    out.push({ source: sourceLabel, title, link, publishedAt });
    if (out.length >= cap) break;
  }

  return out;
}

export async function fetchPolymarketGammaWatchlist(
  slugs: string[],
  options?: { fetchFn?: FetchLike; timeoutMs?: number; nowMs?: number }
): Promise<{ signals: PolymarketSignal[]; warnings: string[] }> {
  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3_500;
  const nowMs = options?.nowMs ?? Date.now();
  const signals: PolymarketSignal[] = [];
  const warnings: string[] = [];

  const cleanSlugs = Array.from(new Set(slugs.map((s) => s.trim()).filter(Boolean))).slice(0, 8);
  for (const slug of cleanSlugs) {
    try {
      const res = await fetchFn(
        `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': 'EvalShield-Copilot/3.0' },
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      if (!res.ok) {
        warnings.push(`Polymarket Gamma returned HTTP ${res.status} for slug "${slug}".`);
        continue;
      }
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      const market = Array.isArray(rows) ? rows[0] : null;
      if (!market) {
        warnings.push(`Polymarket slug "${slug}" returned no active/archived market.`);
        continue;
      }
      let yesPct: number | null = null;
      const rawPrices = market.outcomePrices;
      const parsedPrices: unknown =
        typeof rawPrices === 'string' ? JSON.parse(rawPrices) : rawPrices;
      if (Array.isArray(parsedPrices) && parsedPrices.length > 0) {
        const p = Number(parsedPrices[0]);
        if (Number.isFinite(p)) yesPct = Math.round(p * 1000) / 10;
      }
      const oneDay = Number(market.oneDayPriceChange ?? Number.NaN);
      const vol24 = Number(market.volume24hr ?? Number.NaN);
      const closed = Boolean(market.closed);
      const endDate = typeof market.endDate === 'string' ? market.endDate : null;
      const endMs = endDate ? Date.parse(endDate) : Number.NaN;
      const expiredOrSettled = closed || (Number.isFinite(endMs) && endMs < nowMs);

      signals.push({
        slug,
        question: String(market.question ?? slug),
        yesProbabilityPct: yesPct,
        oneDayChangePct: Number.isFinite(oneDay) ? Math.round(oneDay * 1000) / 10 : null,
        volume24hUsd: Number.isFinite(vol24) ? Math.round(vol24) : null,
        closed,
        endDate,
        expiredOrSettled
      });
    } catch (err) {
      warnings.push(
        `Polymarket slug "${slug}" fetch error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { signals, warnings };
}

export async function fetchHyperliquidPerpsSnapshot(
  coins: string[] = ['BTC', 'ETH', 'SOL'],
  options?: { fetchFn?: FetchLike; timeoutMs?: number }
): Promise<{ contexts: HyperliquidAssetCtx[]; warnings: string[] }> {
  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3_500;
  const wanted = new Set(coins.map((c) => c.trim().toUpperCase()));
  const contexts: HyperliquidAssetCtx[] = [];
  const warnings: string[] = [];

  try {
    const res = await fetchFn('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'EvalShield-Copilot/3.0' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      warnings.push(`Hyperliquid /info returned HTTP ${res.status}.`);
      return { contexts, warnings };
    }
    const payload = (await res.json()) as [
      { universe?: Array<{ name?: string }> },
      Array<{ markPx?: string; funding?: string; openInterest?: string; dayNtlVlm?: string }>
    ];
    const universe = payload?.[0]?.universe ?? [];
    const ctxRows = payload?.[1] ?? [];
    for (let i = 0; i < universe.length; i += 1) {
      const coin = universe[i]?.name?.toUpperCase();
      if (!coin || !wanted.has(coin)) continue;
      const row = ctxRows[i] ?? {};
      const markPx = Number(row.markPx ?? 0);
      const hourlyFunding = Number(row.funding ?? 0);
      const annualizedFundingPct = Math.round(hourlyFunding * 24 * 365 * 10000) / 100;
      contexts.push({
        coin,
        markPx,
        hourlyFundingRate: hourlyFunding,
        annualizedFundingPct,
        openInterest: Number(row.openInterest ?? 0),
        dayNotionalVolumeUsd: Math.round(Number(row.dayNtlVlm ?? 0)),
        extremeFundingAlert: Math.abs(hourlyFunding) >= 0.0005
      });
    }
  } catch (err) {
    warnings.push(`Hyperliquid /info fetch error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { contexts, warnings };
}

export async function fetchSafeRssBrief(
  sources: Array<{ url: string; label: string; keywords: string[] }>,
  options?: { fetchFn?: FetchLike; timeoutMs?: number; allowLoopbackForTest?: boolean }
): Promise<{ items: RssHeadlineItem[]; warnings: string[] }> {
  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3_500;
  const items: RssHeadlineItem[] = [];
  const warnings: string[] = [];

  for (const src of sources.slice(0, 4)) {
    if (items.length >= 3) break;
    try {
      const safeUrl = validateSafeConnectorUrl(src.url, {
        allowLoopbackForTest: options?.allowLoopbackForTest
      });
      const res = await fetchFn(safeUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status >= 300 && res.status < 400) {
        warnings.push(`RSS feed "${src.label}" skipped cross-origin HTTP ${res.status} redirect.`);
        continue;
      }
      if (!res.ok) {
        warnings.push(`RSS feed "${src.label}" returned HTTP ${res.status}.`);
        continue;
      }
      const xml = await res.text();
      const parsed = parseRssAtomHeadlineBrief(xml, src.keywords, src.label, 3 - items.length);
      items.push(...parsed);
    } catch (err) {
      warnings.push(
        `RSS feed "${src.label}" error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { items: items.slice(0, 3), warnings };
}

export async function buildFifteenSecondBrief(options?: {
  nowMs?: number;
  polymarketSlugs?: string[];
  hyperliquidCoins?: string[];
  rssSources?: Array<{ url: string; label: string; keywords: string[] }>;
  fetchFn?: FetchLike;
  allowLoopbackForTest?: boolean;
}): Promise<FifteenSecondBrief> {
  const nowMs = options?.nowMs ?? Date.now();
  const dstMismatch = isUsEuDstMismatchWeek(nowMs);
  const isRollover = isRolloverWideningWindowUtc(nowMs);
  const slugs = options?.polymarketSlugs ?? [];
  const coins = options?.hyperliquidCoins ?? ['BTC', 'ETH', 'SOL'];
  const rssSources = options?.rssSources ?? [];

  const [polyRes, hlRes, rssRes] = await Promise.all([
    fetchPolymarketGammaWatchlist(slugs, { fetchFn: options?.fetchFn, nowMs }),
    fetchHyperliquidPerpsSnapshot(coins, { fetchFn: options?.fetchFn }),
    fetchSafeRssBrief(rssSources, {
      fetchFn: options?.fetchFn,
      allowLoopbackForTest: options?.allowLoopbackForTest
    })
  ]);

  const rolloverAdvisory = isRollover
    ? 'ACTIVE 17:00 ET Rollover Window: Expect XAUUSD/FX spread widening & CME Globex daily break.'
    : 'Normal session liquidity outside 17:00 ET daily rollover; monitor XAUUSD spread against Stop-Loss R before entry.';

  return {
    generatedAtUtc: new Date(nowMs).toISOString(),
    dstMismatch,
    rolloverAdvisory,
    polymarket: polyRes.signals,
    hyperliquid: hlRes.contexts,
    rssHighlights: rssRes.items.slice(0, 3),
    warnings: [...polyRes.warnings, ...hlRes.warnings, ...rssRes.warnings]
  };
}
