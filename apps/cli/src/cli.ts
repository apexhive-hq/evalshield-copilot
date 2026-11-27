#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFifteenSecondBrief,
  evaluatePortfolioGuard,
  evaluateRiskCheck,
  PROP_FIRM_PRESETS,
  type PropPresetId
} from '@evalshield/core';
import {
  createEvalShieldHttpServer,
  EvalShieldDb,
  type BrokerCsvFormat
} from '@evalshield/journal';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next && !next.startsWith('--')) {
          flags[token.slice(2)] = next;
          i += 1;
        } else {
          flags[token.slice(2)] = true;
        }
      }
    }
  }
  return { command, flags };
}

function getDbPath(flags: Record<string, string | boolean>): string {
  if (typeof flags.db === 'string' && flags.db.trim()) {
    return flags.db.trim();
  }
  return process.env.EVALSHIELD_DB_PATH || join(process.cwd(), 'data', 'evalshield.sqlite');
}

function numFlag(flags: Record<string, string | boolean>, key: string, fallback?: number): number | undefined {
  const val = flags[key];
  if (typeof val === 'string') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function strFlag(flags: Record<string, string | boolean>, key: string, fallback?: string): string | undefined {
  const val = flags[key];
  return typeof val === 'string' ? val : fallback;
}

function printHelp(): void {
  console.log(`evalshield — Read-Only Cross-Market Prop-Firm & Futures Risk Co-Pilot

Usage:
  evalshield check [--db path] [--account id] [--preset topstep_50k|ftmo_100k_2step|tradeify_50k_growth] [--symbol ES|XAUUSD|BTC-PERP] [--stop-ticks 10] [--spread-ticks 0] [--atr 2.5] [--risk-pct 0.2] [--skip-globex] [--json]
  evalshield pretrade --symbol <sym> --side LONG|SHORT --qty <n> --thesis "<note>" [--stop-ticks 10] [--account id] [--db path] [--json]
  evalshield brief [--slug <polymarket-slug>] [--coins BTC,ETH,SOL] [--db path] [--json]
  evalshield portfolio-check --positions '<jsonArray>' [--db path] [--json]
  evalshield import --file <csvPath> [--format auto|tradovate-fills|tradovate-perf|nt8-trades|nt8-execs|rithmic|tradingview] [--account id] [--db path] [--json]
  evalshield report [--account id] [--db path] [--json]
  evalshield activate --token <EVALSHIELD-PRO-v1...> [--db path] [--json]
  evalshield serve [--port 4200] [--host 127.0.0.1] [--token <secret>] [--db path]
`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const dbPath = getDbPath(flags);
  const db = new EvalShieldDb(dbPath);
  const asJson = Boolean(flags.json);

  try {
    if (command === 'check') {
      let accountId = strFlag(flags, 'account');
      if (!accountId) {
        const presetId = (strFlag(flags, 'preset', 'topstep_50k') ?? 'topstep_50k') as PropPresetId;
        if (db.listAccounts().length === 0) {
          accountId = db.createAccount({
            name: PROP_FIRM_PRESETS[presetId]?.label ?? 'Eval Account',
            presetId
          }).id;
        } else {
          accountId = db.listAccounts()[0]!.id;
        }
      }
      const account = db.getAccount(accountId);
      const scorecard = db.getDisciplineScorecard(accountId);
      const symbol = strFlag(flags, 'symbol', 'ES')!;
      const userStopTicks = numFlag(flags, 'stop-ticks', 10)!;
      const atr14 = numFlag(flags, 'atr');
      const spreadTicks = numFlag(flags, 'spread-ticks', 0);
      const maxRiskPerTradePct = numFlag(flags, 'risk-pct', 0.2);
      const customSpec = db.getCustomAssetProfile(symbol) ?? undefined;
      const result = evaluateRiskCheck(
        {
          account,
          symbol,
          userStopTicks,
          atr14,
          spreadTicks,
          maxRiskPerTradePct,
          sessionFilter: {
            consecutiveLossesToday: scorecard.consecutiveLossesToday,
            lastLossUtcMs: scorecard.lastLossUtcMs,
            skipGlobexCheck: Boolean(flags['skip-globex'])
          }
        },
        customSpec
      );

      if (asJson) {
        console.log(JSON.stringify({ ok: true, accountId, result }, null, 2));
      } else {
        console.log(
          `[${result.status}] ${account.name} (${result.symbol}) | Remaining Buffer: $${result.remainingBuffer} | Safe Profit Headroom: $${result.remainingSafeAdditionalProfitUsd} | Max Units: ${result.maxContractsAllowed}` +
            (result.microFallbackSymbol
              ? ` | Micro Fallback: ${result.microFallbackContracts} ${result.microFallbackSymbol}`
              : '') +
            ` | Session: ${result.session.sessionAction} (${result.session.sessionQualityScore}/100)`
        );
      }
      return;
    }

    if (command === 'pretrade') {
      const acc = strFlag(flags, 'account')
        ? db.getAccount(strFlag(flags, 'account')!)
        : db.seedDefaultAccountIfEmpty();
      const symbol = strFlag(flags, 'symbol', 'ES')!;
      const sideRaw = (strFlag(flags, 'side', 'LONG') ?? 'LONG').toUpperCase();
      if (sideRaw !== 'LONG' && sideRaw !== 'SHORT') {
        throw new Error('Invalid --side (expected LONG or SHORT)');
      }
      const plannedQty = numFlag(flags, 'qty', 1)!;
      const stopTicks = numFlag(flags, 'stop-ticks', 10);
      const thesisNote = strFlag(flags, 'thesis');
      if (!thesisNote) throw new Error('Missing --thesis "<raw pre-trade note>"');
      const audit = db.recordPretradeAudit({
        accountId: acc.id,
        symbol,
        side: sideRaw,
        plannedQty,
        stopTicks,
        thesisNote
      });
      if (asJson) {
        console.log(JSON.stringify({ ok: true, audit }, null, 2));
      } else {
        console.log(
          `[PRETRADE ${audit.id}] ${audit.symbol} ${audit.side} x${audit.plannedQty} | Buffer@$${audit.remainingBufferAtEntry} | SafeHeadroom=$${audit.consistencyHeadroomUsd} | Thesis="${audit.thesisNote}"`
        );
      }
      return;
    }

    if (command === 'brief') {
      const connectors = db.listConnectors().filter((c) => c.enabled);
      const slugFlag = strFlag(flags, 'slug');
      const slugs = [
        ...connectors.filter((c) => c.kind === 'polymarket_slug').map((c) => c.target),
        ...(slugFlag ? slugFlag.split(',').map((s) => s.trim()).filter(Boolean) : [])
      ];
      const coins = (strFlag(flags, 'coins', 'BTC,ETH,SOL') ?? 'BTC,ETH,SOL')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const rssSources = connectors
        .filter((c) => c.kind === 'rss')
        .map((c) => ({ url: c.target, label: c.label, keywords: c.keywords }));
      const brief = await buildFifteenSecondBrief({
        polymarketSlugs: slugs,
        hyperliquidCoins: coins,
        rssSources
      });
      if (asJson) {
        console.log(JSON.stringify({ ok: true, brief }, null, 2));
      } else {
        console.log(`=== 15s Brief (${brief.generatedAtUtc}) ===`);
        if (brief.dstMismatch.active) console.log(`DST ALERT: ${brief.dstMismatch.notice}`);
        console.log(`Rollover: ${brief.rolloverAdvisory}`);
        for (const hl of brief.hyperliquid) {
          console.log(
            `HL ${hl.coin}: $${hl.markPx} | Funding: ${hl.annualizedFundingPct}%/yr${hl.extremeFundingAlert ? ' [EXTREME]' : ''}`
          );
        }
        for (const pm of brief.polymarket) {
          console.log(
            `Polymarket [${pm.slug}]: ${pm.yesProbabilityPct ?? '-'}% YES${pm.expiredOrSettled ? ' [EXPIRED/SETTLED]' : ''}`
          );
        }
        for (const item of brief.rssHighlights.slice(0, 3)) {
          console.log(`RSS (${item.source}): ${item.title}`);
        }
      }
      return;
    }

    if (command === 'portfolio-check') {
      const rawPos = strFlag(flags, 'positions');
      if (!rawPos) throw new Error('Missing --positions \'[{"accountId":"...","symbol":"ES","side":"LONG","qty":2}]\'');
      const positions = JSON.parse(rawPos);
      const guard = evaluatePortfolioGuard(positions, db.listAccounts());
      if (asJson) {
        console.log(JSON.stringify({ ok: true, guard }, null, 2));
      } else {
        console.log(
          `[PORTFOLIO safe=${guard.safeToProceed}] CombinedBuffer=$${guard.totalRemainingBufferUsd ?? 0} | Alerts=${guard.alerts.length}`
        );
        for (const a of guard.alerts) {
          console.log(`  - [${a.severity}] ${a.code}: ${a.message}`);
        }
      }
      return;
    }

    if (command === 'import') {
      const filePath = strFlag(flags, 'file');
      if (!filePath) {
        throw new Error('Missing --file <csvPath>');
      }
      const csvText = readFileSync(filePath, 'utf8');
      const acc = strFlag(flags, 'account')
        ? db.getAccount(strFlag(flags, 'account')!)
        : db.seedDefaultAccountIfEmpty();
      const format = (strFlag(flags, 'format', 'auto') ?? 'auto') as BrokerCsvFormat;
      const imported = db.importCsv(acc.id, csvText, format);
      if (asJson) {
        console.log(JSON.stringify({ ok: true, ...imported }, null, 2));
      } else {
        console.log(
          `Imported ${imported.importedExecutions} row(s) (${imported.skippedDuplicates} duplicates skipped) via ${imported.formatUsed}. Balance: $${imported.account.realizedBalance} | Adherence: ${imported.scorecard.ruleAdherencePct}%`
        );
      }
      return;
    }

    if (command === 'report') {
      const acc = strFlag(flags, 'account')
        ? db.getAccount(strFlag(flags, 'account')!)
        : db.seedDefaultAccountIfEmpty();
      const scorecard = db.getDisciplineScorecard(acc.id);
      if (asJson) {
        console.log(JSON.stringify({ ok: true, account: acc, scorecard }, null, 2));
      } else {
        console.log(
          `${acc.name} | Balance: $${acc.realizedBalance} | Trades: ${scorecard.totalTrades} | WinRate: ${scorecard.winRatePct}% | Net PnL: $${scorecard.netPnlUsd} | Adherence: ${scorecard.ruleAdherencePct}% | Tilt Leakage: $${scorecard.tiltLeakageUsd}`
        );
      }
      return;
    }

    if (command === 'activate') {
      const token = strFlag(flags, 'token');
      if (!token) throw new Error('Missing --token <EVALSHIELD-PRO-v1...>');
      const license = db.activateLicense(token);
      if (asJson) {
        console.log(JSON.stringify({ ok: true, license }, null, 2));
      } else {
        console.log(`Activated tier=${license.tier} (maxAccounts=${license.maxAccounts ?? 'unlimited'})`);
      }
      return;
    }

    if (command === 'serve') {
      db.seedDefaultAccountIfEmpty();
      const host = strFlag(flags, 'host', '127.0.0.1')!;
      const port = numFlag(flags, 'port', 4200)!;
      const localAuthToken = strFlag(flags, 'token') ?? process.env.EVALSHIELD_LOCAL_TOKEN;
      const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
      if (!isLoopback && !localAuthToken && !flags['allow-unauth-remote']) {
        throw new Error(
          `Refusing to bind non-loopback host "${host}" without --token / EVALSHIELD_LOCAL_TOKEN.`
        );
      }
      const server = createEvalShieldHttpServer({ db, localAuthToken });
      await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
      console.log(`EvalShield Co-Pilot local server listening at http://${host}:${port} (read-only, zero order routing)`);
      const shutdown = () => {
        server.close(() => {
          db.close();
          process.exit(0);
        });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    if (command !== 'serve') {
      db.close();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
