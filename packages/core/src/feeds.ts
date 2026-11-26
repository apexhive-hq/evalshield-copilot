import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { isRolloverWideningWindowUtc, isUsEuDstMismatchWeek } from './session.js';
import type {
  FifteenSecondBrief,
  HyperliquidAssetCtx,
  PolymarketSignal,
  RssHeadlineItem
} from './types.js';

export type FetchLike = typeof fetch;
export type LookupAddress = { address: string; family: number };
export type LookupFn = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

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
  '::',
  '[::]',
  '::1',
  '[::1]',
  'metadata.google.internal'
]);

function parseIpv4Octets(raw: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isPrivateOrReservedIpv4Octets([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved
  return false;
}

function parseIpv6Groups(raw: string): number[] | null {
  const withoutZone = raw.split('%')[0] ?? '';
  if (!withoutZone) return null;

  let working = withoutZone.toLowerCase();
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const ipv4 = parseIpv4Octets(working.slice(lastColon + 1));
    if (!ipv4) return null;
    const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const dblIdx = working.indexOf('::');
  if (dblIdx !== -1) {
    if (working.indexOf('::', dblIdx + 2) !== -1) return null;
    const leftRaw = working.slice(0, dblIdx);
    const rightRaw = working.slice(dblIdx + 2);
    const left = leftRaw ? leftRaw.split(':') : [];
    const right = rightRaw ? rightRaw.split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    const expanded = [...left, ...Array(missing).fill('0'), ...right];
    if (expanded.length !== 8) return null;
    const nums = expanded.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN));
    return nums.some((n) => !Number.isInteger(n)) ? null : nums;
  }

  const parts = working.split(':');
  if (parts.length !== 8) return null;
  const nums = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN));
  return nums.some((n) => !Number.isInteger(n)) ? null : nums;
}

export function isPrivateOrReservedIp(hostOrIp: string): boolean {
  const clean = hostOrIp.replace(/^\[|\]$/g, '').split('%')[0]!.trim().toLowerCase();
  if (!clean) return true;

  const v4 = parseIpv4Octets(clean);
  if (v4) {
    return isPrivateOrReservedIpv4Octets(v4);
  }

  if (isIP(clean) === 6 || clean.includes(':')) {
    const g = parseIpv6Groups(clean);
    if (!g) return true; // Malformed IPv6 literal treated as unsafe

    // Unspecified (::) and Loopback (::1)
    const firstSixZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
    if (firstSixZero && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return true;
    }

    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96)
    if (
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0 &&
      (g[5] === 0xffff || g[5] === 0x0000)
    ) {
      const unpacked: [number, number, number, number] = [
        (g[6]! >> 8) & 0xff,
        g[6]! & 0xff,
        (g[7]! >> 8) & 0xff,
        g[7]! & 0xff
      ];
      return isPrivateOrReservedIpv4Octets(unpacked);
    }

    // NAT64 (64:ff9b::/96 & 64:ff9b:1::/48)
    if (g[0] === 0x0064 && g[1] === 0xff9b && (g[2] === 0x0001 || (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0))) {
      return true;
    }

    // 6to4 (2002::/16) -> check embedded IPv4
    if (g[0] === 0x2002) {
      const unpacked: [number, number, number, number] = [
        (g[1]! >> 8) & 0xff,
        g[1]! & 0xff,
        (g[2]! >> 8) & 0xff,
        g[2]! & 0xff
      ];
      if (isPrivateOrReservedIpv4Octets(unpacked)) return true;
    }

    // Teredo (2001:0000::/32), Documentation (2001:db8::/32), Discard (100::/64)
    if (g[0] === 0x2001 && (g[1] === 0x0000 || g[1] === 0x0db8)) return true;
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

    // ULA fc00::/7, Link-local fe80::/10, Site-local fec0::/10, Multicast ff00::/8
    if ((g[0]! & 0xfe00) === 0xfc00) return true;
    if ((g[0]! & 0xffc0) === 0xfe80) return true;
    if ((g[0]! & 0xffc0) === 0xfec0) return true;
    if ((g[0]! & 0xff00) === 0xff00) return true;

    return false;
  }

  return false;
}

/**
 * Validates user-supplied BYO connector URLs with strict SSRF and policy rules:
 * HTTPS-only, zero credentials, zero LAN/metadata IPs (IPv4 & IPv6 + IPv4-mapped IPv6),
 * and no X/Twitter or geo-blocked exchange scraping.
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

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const bareHost = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const isLoopback =
    bareHost === '127.0.0.1' ||
    bareHost === '::1' ||
    bareHost === '::ffff:127.0.0.1' ||
    bareHost === 'localhost';
  if (options?.allowLoopbackForTest && isLoopback && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return parsed;
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Connector URL must use HTTPS (got ${parsed.protocol})`);
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error(`Connector URL must use default HTTPS port 443 (got ${parsed.port})`);
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
    BLOCKED_EXACT_HOSTS.has(bareHost) ||
    bareHost.endsWith('.local') ||
    bareHost.endsWith('.internal') ||
    isPrivateOrReservedIp(bareHost)
  ) {
    throw new Error(`SSRF_BLOCKED_HOST: Disallowed private or reserved host (${host})`);
  }

  return parsed;
}

/**
 * Resolves DNS for the connector host and verifies EVERY returned IP address is public/global,
 * guarding against DNS-to-internal-IP and DNS rebinding attacks.
 */
export async function resolveAndValidateSafeConnectorUrl(
  rawUrl: string,
  options?: { allowLoopbackForTest?: boolean; lookupFn?: LookupFn }
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const parsed = validateSafeConnectorUrl(rawUrl, options);
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');

  if (options?.allowLoopbackForTest && (bareHost === '127.0.0.1' || bareHost === '::1' || bareHost === 'localhost')) {
    return {
      url: parsed,
      addresses: [{ address: bareHost === '::1' ? '::1' : '127.0.0.1', family: bareHost === '::1' ? 6 : 4 }]
    };
  }

  const literalFamily = isIP(bareHost);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isPrivateOrReservedIp(bareHost)) {
      throw new Error(`SSRF_BLOCKED_HOST: Disallowed private or reserved IP (${bareHost})`);
    }
    return { url: parsed, addresses: [{ address: bareHost, family: literalFamily }] };
  }

  const lookupFn = options?.lookupFn ?? ((h, opts) => dnsLookup(h, opts));
  const addresses = await lookupFn(bareHost, { all: true });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`SSRF_BLOCKED_DNS: DNS resolution returned no addresses for ${bareHost}`);
  }
  for (const entry of addresses) {
    if (!entry?.address || isPrivateOrReservedIp(entry.address)) {
      throw new Error(`SSRF_BLOCKED_DNS: Host ${bareHost} resolved to disallowed IP (${entry?.address ?? 'empty'})`);
    }
  }
  return { url: parsed, addresses };
}

export function createPinnedLookup(addresses: LookupAddress[]) {
  const normalized = addresses.map((a) => ({
    address: a.address,
    family: a.family || (isIP(a.address) === 6 ? 6 : 4)
  }));
  const chosen = normalized[0]!;
  return (
    _host: string,
    opts: { all?: boolean } | number | undefined,
    cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
  ) => {
    if (typeof opts === 'object' && opts !== null && opts.all) {
      cb(null, normalized);
      return;
    }
    cb(null, chosen.address, chosen.family);
  };
}

export async function fetchPinnedHttpsText(
  safeUrl: URL,
  addresses: LookupAddress[],
  timeoutMs: number,
  options?: { maxBytes?: number; agent?: https.Agent }
): Promise<{ status: number; text: string }> {
  const maxBytes = options?.maxBytes ?? 512 * 1024;
  const pinnedLookup = createPinnedLookup(addresses);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (val: { status: number; text: string }) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: safeUrl.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, ''),
        port: 443,
        path: `${safeUrl.pathname}${safeUrl.search}`,
        method: 'GET',
        servername: safeUrl.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, ''),
        agent: options?.agent,
        headers: {
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          Host: safeUrl.host
        },
        lookup: pinnedLookup as never
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          finishResolve({ status, text: '' });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            const err = new Error(`Connector response exceeded ${maxBytes} bytes`);
            res.destroy();
            req.destroy();
            finishReject(err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          finishResolve({ status, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', finishReject);
      }
    );
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Connector request timed out after ${timeoutMs}ms`);
      req.destroy();
      finishReject(err);
    });
    req.on('error', finishReject);
    req.end();
  });
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
          headers: { Accept: 'application/json', 'User-Agent': 'EvalShield-Copilot/3.0.2' },
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
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'EvalShield-Copilot/3.0.2' },
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
  options?: { fetchFn?: FetchLike; lookupFn?: LookupFn; timeoutMs?: number; allowLoopbackForTest?: boolean }
): Promise<{ items: RssHeadlineItem[]; warnings: string[] }> {
  const fetchFn = options?.fetchFn;
  const timeoutMs = options?.timeoutMs ?? 3_500;
  const items: RssHeadlineItem[] = [];
  const warnings: string[] = [];

  for (const src of sources.slice(0, 4)) {
    if (items.length >= 3) break;
    try {
      let safeUrl: URL;
      let resolvedAddresses: LookupAddress[] = [];
      if (!fetchFn || options?.lookupFn) {
        const resolved = await resolveAndValidateSafeConnectorUrl(src.url, {
          allowLoopbackForTest: options?.allowLoopbackForTest,
          lookupFn: options?.lookupFn
        });
        safeUrl = resolved.url;
        resolvedAddresses = resolved.addresses;
      } else {
        safeUrl = validateSafeConnectorUrl(src.url, {
          allowLoopbackForTest: options?.allowLoopbackForTest
        });
      }

      if (fetchFn) {
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
      } else {
        const pinned = await fetchPinnedHttpsText(safeUrl, resolvedAddresses, timeoutMs);
        if (pinned.status >= 300 && pinned.status < 400) {
          warnings.push(`RSS feed "${src.label}" skipped cross-origin HTTP ${pinned.status} redirect.`);
          continue;
        }
        if (pinned.status < 200 || pinned.status >= 300) {
          warnings.push(`RSS feed "${src.label}" returned HTTP ${pinned.status}.`);
          continue;
        }
        const parsed = parseRssAtomHeadlineBrief(pinned.text, src.keywords, src.label, 3 - items.length);
        items.push(...parsed);
      }
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
  lookupFn?: LookupFn;
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
      lookupFn: options?.lookupFn,
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
