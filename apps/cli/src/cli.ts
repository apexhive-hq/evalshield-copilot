#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
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
  console.log(`evalshield — Open-Core AI Futures & Prop-Firm Risk Co-Pilot (Read-Only / Human-in-the-Loop)

Usage:
  evalshield check [--db path] [--account id] [--preset topstep_50k] [--symbol ES] [--stop-ticks 10] [--atr 2.5] [--risk-pct 0.2] [--skip-globex] [--json]
  evalshield import --file <csvPath> [--format auto|tradovate-fills|tradovate-perf|nt8-trades|nt8-execs|rithmic|tradingview] [--account id] [--db path] [--json]
  evalshield report [--account id] [--db path] [--json]
  evalshield activate --token <EVALSHIELD-PRO-v1...> [--db path] [--json]
  evalshield serve [--port 4200] [--host 127.0.0.1] [--db path]
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
      const maxRiskPerTradePct = numFlag(flags, 'risk-pct', 0.2);
      const result = evaluateRiskCheck({
        account,
        symbol,
        userStopTicks,
        atr14,
        maxRiskPerTradePct,
        sessionFilter: {
          consecutiveLossesToday: scorecard.consecutiveLossesToday,
          lastLossUtcMs: scorecard.lastLossUtcMs,
          skipGlobexCheck: Boolean(flags['skip-globex'])
        }
      });

      if (asJson) {
        console.log(JSON.stringify({ ok: true, accountId, result }, null, 2));
      } else {
        console.log(
          `[${result.status}] ${account.name} (${result.symbol}) | Remaining Buffer: $${result.remainingBuffer} | Max Contracts: ${result.maxContractsAllowed}` +
            (result.microFallbackSymbol
              ? ` | Micro Fallback: ${result.microFallbackContracts} ${result.microFallbackSymbol}`
              : '') +
            ` | Session: ${result.session.sessionAction} (${result.session.sessionQualityScore}/100)`
        );
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
      const server = createEvalShieldHttpServer({ db });
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
