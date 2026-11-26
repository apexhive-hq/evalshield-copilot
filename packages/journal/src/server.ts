import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ALL_MARKET_CONTRACTS,
  buildFifteenSecondBrief,
  CME_CONTRACTS,
  DEFAULT_EVALSHIELD_PUBLIC_KEY_SPKI_B64,
  evaluatePortfolioGuard,
  evaluateRiskCheck,
  fetchSafeRssBrief,
  PROP_FIRM_PRESETS,
  TOKEN_PREFIX,
  validateSafeConnectorUrl
} from '@evalshield/core';
import { DomainError, EvalShieldDb } from './db.js';

const MAX_JSON_BYTES = 262_144;
const MAX_CSV_BYTES = 2_097_152;
const MAX_WEBHOOK_BYTES = 65_536;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIRS = [
  join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public'),
  join(__dirname, '..', '..', '..', 'apps', 'web', 'public')
];

const STATIC_ALLOWLIST: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'application/javascript; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', contentType: 'image/svg+xml; charset=utf-8' },
  '/favicon.ico': { file: 'favicon.svg', contentType: 'image/svg+xml; charset=utf-8' }
};

export interface ServerOptions {
  db: EvalShieldDb;
  publicDirs?: string[];
  webhookSecret?: string;
  publicKeySpkiB64?: string;
  allowedOrigins?: string[];
  fetchFn?: typeof fetch;
  allowLoopbackConnectorsForTest?: boolean;
}

function resolveAllowedOriginSet(explicit?: string[]): Set<string> {
  const fromEnv = (process.env.EVALSHIELD_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...(explicit ?? []), ...fromEnv]);
}

function isLoopbackOrAllowedOrigin(origin: string, explicitAllowed: Set<string>): boolean {
  if (explicitAllowed.has(origin)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function evaluateRequestCors(
  req: IncomingMessage,
  explicitAllowed: Set<string>
): { hasOrigin: boolean; allowed: boolean; allowOriginHeader: string | null } {
  const raw = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!raw) {
    return { hasOrigin: false, allowed: true, allowOriginHeader: null };
  }
  const allowed = isLoopbackOrAllowedOrigin(raw, explicitAllowed);
  return {
    hasOrigin: true,
    allowed,
    allowOriginHeader: allowed ? raw : null
  };
}

function resolveStaticAsset(fileName: string, publicDirs: string[]): Buffer | null {
  for (const dir of publicDirs) {
    const full = join(dir, fileName);
    if (existsSync(full)) {
      return readFileSync(full);
    }
  }
  return null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  allowOriginHeader: string | null = null
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-EvalShield-License, X-Webhook-Secret'
  };
  if (allowOriginHeader) {
    headers['access-control-allow-origin'] = allowOriginHeader;
  }
  if (status === 413) {
    headers.connection = 'close';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(new DomainError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${maxBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function parseJsonBuffer<T>(buf: Buffer, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new DomainError(400, 'INVALID_JSON', 'Malformed JSON body.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid input.');
  }
  return parsed.data;
}

function verifyWebhookHmac(rawBody: Buffer, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader) return false;
  const cleaned = sigHeader.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(cleaned, 'hex');
  if (expected.byteLength !== actual.byteLength) return false;
  return timingSafeEqual(expected, actual);
}

const CreateAccountSchema = z.object({
  name: z.string().min(1).max(120),
  presetId: z.enum([
    'topstep_50k',
    'topstep_150k',
    'apex_50k_intraday',
    'apex_50k_eod',
    'mffu_50k_starter',
    'ftmo_100k_2step',
    'ftmo_100k_1step',
    'tradeify_50k_growth',
    'tradeify_50k_straight',
    'custom'
  ]),
  accountStage: z.enum(['EVAL', 'FUNDED']).optional(),
  startingBalance: z.number().positive().optional(),
  drawdownMode: z.enum(['INTRADAY_TRAILING', 'EOD_TRAILING', 'STATIC']).optional(),
  maxDrawdown: z.number().positive().optional(),
  dailyLossLimit: z.number().positive().nullable().optional(),
  alphaSoftDll: z.number().positive().max(1).optional(),
  safetyReserve: z.number().min(0).optional(),
  lockCap: z.number().positive().nullable().optional(),
  maxContractsCap: z.number().int().positive().optional(),
  consistencyCap: z.number().positive().max(1).optional(),
  profitTarget: z.number().positive().optional()
});

const PatchAccountSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  accountStage: z.enum(['EVAL', 'FUNDED']).optional(),
  realizedBalance: z.number().positive().optional(),
  openUnrealizedPnl: z.number().finite().optional(),
  hwm: z.number().positive().optional(),
  dayRealizedPnl: z.number().finite().optional(),
  alphaSoftDll: z.number().positive().max(1).optional(),
  safetyReserve: z.number().min(0).optional(),
  dailyLossLimit: z.number().positive().nullable().optional(),
  consistencyCap: z.number().positive().max(1).optional()
});

const RiskCheckSchema = z.object({
  accountId: z.string().min(1),
  symbol: z.string().min(1).max(32),
  userStopTicks: z.number().int().min(0),
  atr14: z.number().min(0).optional(),
  kAtr: z.number().positive().optional(),
  roundTripCommission: z.number().min(0).optional(),
  slippageTicks: z.number().min(0).optional(),
  spreadTicks: z.number().min(0).optional(),
  notionalUsd: z.number().positive().optional(),
  isMakerOrder: z.boolean().optional(),
  fundingRateHourly: z.number().finite().optional(),
  expectedHoldHours: z.number().min(0).optional(),
  maxRiskPerTradePct: z.number().positive().max(1).optional(),
  maxRiskPerTradeUsd: z.number().positive().optional(),
  runwayTrades: z.number().int().min(1).optional(),
  sessionFilter: z
    .object({
      nowUtcMs: z.number().finite().optional(),
      atr14: z.number().min(0).optional(),
      atr20dMedian: z.number().min(0).optional(),
      consecutiveLossesToday: z.number().int().min(0).optional(),
      maxConsecLosses: z.number().int().min(1).optional(),
      cooldownMinutes: z.number().int().min(1).optional(),
      lastLossUtcMs: z.number().finite().nullable().optional(),
      tradesLast15Min: z.number().int().min(0).optional(),
      tradesToday: z.number().int().min(0).optional(),
      skipGlobexCheck: z.boolean().optional(),
      eventWindows: z
        .array(
          z.object({
            name: z.string().min(1),
            timestampUtcMs: z.number().finite(),
            bufferMinutesBefore: z.number().min(0).optional(),
            bufferMinutesAfter: z.number().min(0).optional()
          })
        )
        .optional()
    })
    .optional()
});

const CsvImportSchema = z.object({
  accountId: z.string().min(1),
  format: z
    .enum([
      'auto',
      'tradovate-fills',
      'tradovate-perf',
      'nt8-trades',
      'nt8-execs',
      'rithmic',
      'tradingview'
    ])
    .default('auto'),
  csvText: z.string().min(1),
  maxAllowedContracts: z.number().int().positive().optional()
});

const WebhookSchema = z.object({
  accountId: z.string().min(1),
  eventType: z.enum(['fill', 'atr_bar']),
  symbol: z.string().min(1).max(24),
  side: z.enum(['BUY', 'SELL']).optional(),
  qty: z.number().positive().optional(),
  price: z.number().positive().optional(),
  commission: z.number().min(0).optional(),
  execId: z.string().min(1).optional(),
  tsUtc: z.string().min(1).optional(),
  atr14: z.number().positive().optional(),
  atr20dMedian: z.number().positive().optional()
});

const LicenseActivateSchema = z.object({
  token: z.string().min(10)
});

const PretradeAuditSchema = z.object({
  accountId: z.string().min(1),
  symbol: z.string().min(1).max(32),
  side: z.enum(['LONG', 'SHORT']),
  plannedQty: z.number().positive(),
  stopTicks: z.number().int().positive().optional(),
  thesisNote: z.string().min(1).max(1000)
});

const CreateConnectorSchema = z.object({
  kind: z.enum(['rss', 'polymarket_slug', 'custom_asset', 'webhook']),
  label: z.string().min(1).max(120),
  target: z.string().min(1).max(500),
  keywords: z.array(z.string().max(40)).max(12).optional(),
  enabled: z.boolean().optional(),
  metaJson: z.record(z.unknown()).optional()
});

const TestConnectorSchema = z.object({
  kind: z.enum(['rss', 'polymarket_slug', 'custom_asset']),
  label: z.string().min(1).max(120).optional(),
  target: z.string().min(1).max(500),
  keywords: z.array(z.string().max(40)).max(12).optional()
});

const PortfolioGuardSchema = z
  .object({
    positions: z
      .array(
        z
          .object({
            accountId: z.string().min(1),
            accountName: z.string().min(1).optional(),
            symbol: z.string().min(1).max(32),
            side: z.enum(['LONG', 'SHORT']),
            qty: z.number().positive(),
            riskUsd: z.number().positive().optional(),
            antiHedgingBanned: z.boolean().optional()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict();

export function createEvalShieldHttpServer(options: ServerOptions): http.Server {
  const { db } = options;
  const publicDirs = options.publicDirs ?? DEFAULT_PUBLIC_DIRS;
  const publicKeySpkiB64 =
    options.publicKeySpkiB64 ||
    process.env.EVALSHIELD_PUBLIC_KEY ||
    DEFAULT_EVALSHIELD_PUBLIC_KEY_SPKI_B64;

  return http.createServer(async (req, res) => {
    const allowedOriginSet = resolveAllowedOriginSet(options.allowedOrigins);
    const cors = evaluateRequestCors(req, allowedOriginSet);
    const corsOrigin = cors.allowOriginHeader;
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (cors.hasOrigin && !cors.allowed && method !== 'GET' && method !== 'HEAD') {
        sendJson(
          res,
          403,
          {
            ok: false,
            error: 'ORIGIN_NOT_ALLOWED',
            message: 'Cross-origin write requests require loopback Origin or EVALSHIELD_ALLOWED_ORIGINS.'
          },
          null
        );
        return;
      }

      if (method === 'OPTIONS') {
        const optHeaders: Record<string, string> = {
          vary: 'Origin',
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'Content-Type, X-EvalShield-License, X-Webhook-Secret'
        };
        if (corsOrigin) {
          optHeaders['access-control-allow-origin'] = corsOrigin;
        }
        res.writeHead(204, optHeaders);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (method === 'GET' && STATIC_ALLOWLIST[path]) {
        const entry = STATIC_ALLOWLIST[path]!;
        const bytes = resolveStaticAsset(entry.file, publicDirs);
        if (bytes) {
          const headers: Record<string, string> = {
            'content-type': entry.contentType,
            vary: 'Origin'
          };
          if (corsOrigin) {
            headers['access-control-allow-origin'] = corsOrigin;
          }
          res.writeHead(200, headers);
          res.end(bytes);
          return;
        }
        if (path === '/' || path === '/index.html') {
          const headers: Record<string, string> = {
            'content-type': 'text/html; charset=utf-8',
            vary: 'Origin'
          };
          if (corsOrigin) {
            headers['access-control-allow-origin'] = corsOrigin;
          }
          res.writeHead(200, headers);
          res.end(
            '<!doctype html><html><head><meta charset="utf-8"><title>EvalShield Co-Pilot API</title></head><body><h1>EvalShield Co-Pilot Local Server</h1><p>API ready on 127.0.0.1. Build apps/web/public to load the dashboard UI.</p></body></html>'
          );
          return;
        }
        sendJson(res, 404, { ok: false, error: 'ASSET_NOT_FOUND' }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/health') {
        sendJson(
          res,
          200,
          {
            ok: true,
            service: 'evalshield-copilot',
            dbMode: 'node:sqlite-wal',
            orderRoutingEnabled: false
          },
          corsOrigin
        );
        return;
      }

      if (method === 'GET' && path === '/api/config') {
        sendJson(
          res,
          200,
          {
            ok: true,
            brand: 'ApexHive Labs',
            productId: 'evalshield-copilot',
            tokenPrefix: TOKEN_PREFIX,
            licensePublicKeySpkiB64: publicKeySpkiB64,
            supportEmail: 'apexhive.hq@proton.me',
            mode: 'sqlite-server',
            orderRoutingEnabled: false,
            winrarLicenseModel: {
              solo: '0 USDC (Full 300-pt Local Engine)',
              teamEarlyBird: '99 USDC (2-99 seats)',
              enterpriseEarlyBird: '499 USDC (100+ seats)'
            },
            cmeContracts: Object.values(CME_CONTRACTS),
            marketContracts: Object.values(ALL_MARKET_CONTRACTS),
            propPresets: Object.values(PROP_FIRM_PRESETS)
          },
          corsOrigin
        );
        return;
      }

      if (method === 'GET' && path === '/api/license/status') {
        sendJson(res, 200, { ok: true, license: db.getLicenseStatus(publicKeySpkiB64) }, corsOrigin);
        return;
      }

      if (method === 'POST' && path === '/api/license/activate') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), LicenseActivateSchema);
        const license = db.activateLicense(body.token, publicKeySpkiB64);
        sendJson(res, 200, { ok: true, license }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/accounts') {
        sendJson(
          res,
          200,
          {
            ok: true,
            accounts: db.listAccounts(),
            license: db.getLicenseStatus(publicKeySpkiB64)
          },
          corsOrigin
        );
        return;
      }

      if (method === 'POST' && path === '/api/accounts') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), CreateAccountSchema);
        const headerToken = req.headers['x-evalshield-license'];
        const account = db.createAccount(body, {
          headerLicenseToken: typeof headerToken === 'string' ? headerToken : undefined,
          publicKeySpkiB64
        });
        sendJson(res, 201, { ok: true, account }, corsOrigin);
        return;
      }

      const accMatch = /^\/api\/accounts\/([A-Za-z0-9_-]+)$/.exec(path);
      if (accMatch) {
        const accountId = accMatch[1]!;
        if (method === 'PATCH') {
          const patch = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), PatchAccountSchema);
          const account = db.updateAccountState(accountId, patch);
          sendJson(res, 200, { ok: true, account }, corsOrigin);
          return;
        }
        if (method === 'DELETE') {
          db.deleteAccount(accountId);
          sendJson(res, 200, { ok: true, deletedId: accountId }, corsOrigin);
          return;
        }
      }

      if (method === 'POST' && path === '/api/risk/check') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), RiskCheckSchema);
        const account = db.getAccount(body.accountId);
        const scorecard = db.getDisciplineScorecard(body.accountId);
        const marketCtx = db.getMarketContext(body.symbol);
        const customSpec = db.getCustomAssetProfile(body.symbol) ?? undefined;
        const result = evaluateRiskCheck(
          {
            account,
            symbol: body.symbol,
            userStopTicks: body.userStopTicks,
            atr14: body.atr14 ?? marketCtx?.atr14,
            kAtr: body.kAtr,
            roundTripCommission: body.roundTripCommission,
            slippageTicks: body.slippageTicks,
            spreadTicks: body.spreadTicks,
            notionalUsd: body.notionalUsd,
            isMakerOrder: body.isMakerOrder,
            fundingRateHourly: body.fundingRateHourly,
            expectedHoldHours: body.expectedHoldHours,
            maxRiskPerTradePct: body.maxRiskPerTradePct,
            maxRiskPerTradeUsd: body.maxRiskPerTradeUsd,
            runwayTrades: body.runwayTrades,
            sessionFilter: {
              consecutiveLossesToday: scorecard.consecutiveLossesToday,
              lastLossUtcMs: scorecard.lastLossUtcMs,
              atr20dMedian: marketCtx?.atr20dMedian,
              ...body.sessionFilter
            }
          },
          customSpec
        );
        sendJson(res, 200, { ok: true, result }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/journal/pretrade') {
        const accountId = url.searchParams.get('accountId') ?? db.listAccounts()[0]?.id ?? '';
        if (!accountId) {
          throw new DomainError(404, 'ACCOUNT_NOT_FOUND', 'No account available.');
        }
        const audits = db.listPretradeAudits(accountId);
        sendJson(res, 200, { ok: true, accountId, audits }, corsOrigin);
        return;
      }

      if (method === 'POST' && path === '/api/journal/pretrade') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), PretradeAuditSchema);
        const audit = db.recordPretradeAudit(body);
        sendJson(res, 201, { ok: true, audit }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/connectors') {
        sendJson(res, 200, { ok: true, connectors: db.listConnectors() }, corsOrigin);
        return;
      }

      if (method === 'POST' && path === '/api/connectors') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), CreateConnectorSchema);
        const connector = db.createConnector(body, {
          allowLoopbackForTest: options.allowLoopbackConnectorsForTest
        });
        sendJson(res, 201, { ok: true, connector }, corsOrigin);
        return;
      }

      const connMatch = /^\/api\/connectors\/([A-Za-z0-9_-]+)$/.exec(path);
      if (connMatch && method === 'DELETE') {
        db.deleteConnector(connMatch[1]!);
        sendJson(res, 200, { ok: true, deletedId: connMatch[1]! }, corsOrigin);
        return;
      }

      if (method === 'POST' && path === '/api/connectors/test') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), TestConnectorSchema);
        if (body.kind === 'rss') {
          try {
            validateSafeConnectorUrl(body.target, {
              allowLoopbackForTest: options.allowLoopbackConnectorsForTest
            });
          } catch (err) {
            throw new DomainError(
              400,
              'DISALLOWED_CONNECTOR_URL',
              err instanceof Error ? err.message : String(err)
            );
          }
          const out = await fetchSafeRssBrief(
            [{ url: body.target, label: body.label ?? 'BYO RSS', keywords: body.keywords ?? [] }],
            { fetchFn: options.fetchFn, allowLoopbackForTest: options.allowLoopbackConnectorsForTest }
          );
          sendJson(res, 200, { ok: true, ...out }, corsOrigin);
          return;
        }
        sendJson(res, 200, { ok: true, target: body.target, kind: body.kind }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/brief') {
        const connectors = db.listConnectors().filter((c) => c.enabled);
        const polymarketSlugs = connectors
          .filter((c) => c.kind === 'polymarket_slug')
          .map((c) => c.target);
        const rssSources = connectors
          .filter((c) => c.kind === 'rss')
          .map((c) => ({ url: c.target, label: c.label, keywords: c.keywords }));
        const nowParam = url.searchParams.get('nowUtcMs');
        const parsedNow = nowParam ? Number(nowParam) : undefined;
        const brief = await buildFifteenSecondBrief({
          nowMs: parsedNow && Number.isFinite(parsedNow) ? parsedNow : undefined,
          polymarketSlugs,
          hyperliquidCoins: ['BTC', 'ETH', 'SOL'],
          rssSources,
          fetchFn: options.fetchFn,
          allowLoopbackForTest: options.allowLoopbackConnectorsForTest
        });
        sendJson(res, 200, { ok: true, brief }, corsOrigin);
        return;
      }

      if (method === 'POST' && path === '/api/portfolio/guard') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_JSON_BYTES), PortfolioGuardSchema);
        const accounts = db.listAccounts();
        const enriched = body.positions.map((p) => {
          const acc = accounts.find((a) => a.id === p.accountId);
          return {
            ...p,
            antiHedgingBanned: p.antiHedgingBanned ?? acc?.antiHedgingBanned ?? true
          };
        });
        const guard = evaluatePortfolioGuard(enriched, accounts);
        sendJson(res, 200, { ok: true, guard }, corsOrigin);
        return;
      }

      if (method === 'POST' && path === '/api/journal/import') {
        const body = parseJsonBuffer(await readRawBody(req, MAX_CSV_BYTES), CsvImportSchema);
        const imported = db.importCsv(body.accountId, body.csvText, body.format, {
          maxAllowedContracts: body.maxAllowedContracts
        });
        sendJson(res, 200, { ok: true, ...imported }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/journal/trades') {
        const accountId = url.searchParams.get('accountId') ?? db.listAccounts()[0]?.id ?? '';
        if (!accountId) {
          throw new DomainError(404, 'ACCOUNT_NOT_FOUND', 'No account available.');
        }
        db.getAccount(accountId);
        const trades = db.listTrades(accountId);
        sendJson(res, 200, { ok: true, accountId, trades }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/journal/report') {
        const accountId = url.searchParams.get('accountId') ?? db.listAccounts()[0]?.id ?? '';
        if (!accountId) {
          throw new DomainError(404, 'ACCOUNT_NOT_FOUND', 'No account available.');
        }
        const account = db.getAccount(accountId);
        const scorecard = db.getDisciplineScorecard(accountId);
        sendJson(res, 200, { ok: true, account, scorecard }, corsOrigin);
        return;
      }

      if (method === 'GET' && path === '/api/journal/export.csv') {
        const accountId = url.searchParams.get('accountId') ?? db.listAccounts()[0]?.id ?? '';
        if (!accountId) {
          throw new DomainError(404, 'ACCOUNT_NOT_FOUND', 'No account available.');
        }
        const csv = db.exportTradesCsv(accountId);
        const exportHeaders: Record<string, string> = {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="evalshield-${accountId}.csv"`,
          vary: 'Origin'
        };
        if (corsOrigin) {
          exportHeaders['access-control-allow-origin'] = corsOrigin;
        }
        res.writeHead(200, exportHeaders);
        res.end(csv);
        return;
      }

      if (method === 'POST' && path === '/api/ingest/webhook') {
        const secret = options.webhookSecret ?? process.env.EVALSHIELD_WEBHOOK_SECRET;
        if (!secret) {
          throw new DomainError(
            503,
            'WEBHOOK_SECRET_NOT_CONFIGURED',
            'EVALSHIELD_WEBHOOK_SECRET must be configured before accepting read-only webhook ingestion.'
          );
        }
        const rawBuf = await readRawBody(req, MAX_WEBHOOK_BYTES);
        const sigHeader = req.headers['x-webhook-secret'];
        if (
          typeof sigHeader !== 'string' ||
          !verifyWebhookHmac(rawBuf, sigHeader, secret)
        ) {
          throw new DomainError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid X-Webhook-Secret HMAC.');
        }
        const payload = parseJsonBuffer(rawBuf, WebhookSchema);
        const result = db.ingestReadOnlyWebhook(payload);
        sendJson(res, 200, { ...result, orderRoutingEnabled: false }, corsOrigin);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' }, corsOrigin);
    } catch (err) {
      if (err instanceof DomainError) {
        sendJson(res, err.status, { ok: false, error: err.code, message: err.message }, corsOrigin);
        return;
      }
      sendJson(
        res,
        500,
        {
          ok: false,
          error: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err)
        },
        corsOrigin
      );
    }
  });
}
