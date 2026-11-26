import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  computeDrawdownState,
  evaluateRiskCheck,
  getMaxAllowedAccounts,
  normalizeSymbolRoot,
  PROP_FIRM_PRESETS,
  validateSafeConnectorUrl,
  verifyEvalShieldLicenseToken,
  type AccountRiskProfile,
  type AccountStage,
  type ByoConnectorConfig,
  type ByoConnectorKind,
  type ContractSpec,
  type DrawdownMode,
  type EvalShieldTier,
  type PropPresetId
} from '@evalshield/core';
import {
  pairExecutionsFifo,
  parseBrokerCsv,
  type BrokerCsvFormat,
  type NormalizedExecution,
  type PairedTradeInput
} from './csv.js';

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface CreateAccountInput {
  name: string;
  presetId: PropPresetId;
  accountStage?: AccountStage;
  startingBalance?: number;
  drawdownMode?: DrawdownMode;
  maxDrawdown?: number;
  dailyLossLimit?: number | null;
  alphaSoftDll?: number;
  safetyReserve?: number;
  lockCap?: number | null;
  maxContractsCap?: number;
  consistencyCap?: number;
  profitTarget?: number;
}

export interface PretradeAuditRecord {
  id: string;
  accountId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  plannedQty: number;
  stopTicks: number;
  remainingBufferAtEntry: number;
  consistencyHeadroomUsd: number;
  newsRiskStatus: string;
  thesisNote: string;
  createdAt: string;
}

export interface CreatePretradeAuditInput {
  accountId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  plannedQty: number;
  stopTicks?: number;
  thesisNote: string;
  nowUtcMs?: number;
}

export interface DisciplineScorecard {
  accountId: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number | null;
  netPnlUsd: number;
  ruleAdherencePct: number;
  tiltLeakageUsd: number;
  consecutiveLossesToday: number;
  lastLossUtcMs: number | null;
  empiricalNetPnls: number[];
}

export interface PairedTradeRecord extends PairedTradeInput {
  id: string;
  ruleAdherent: boolean;
  violationReason: string | null;
}

export interface LicenseStatusRecord {
  tier: EvalShieldTier;
  valid: boolean;
  maxAccounts: number | null;
  payer: string | null;
  txHash: string | null;
  activatedAt: string | null;
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function escapeCsvCell(raw: unknown): string {
  let str = String(raw ?? '');
  if (/^(?:[=+\-@\t\r\n]|\s+[=+\-@])/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function quoteRawCsvField(raw: unknown): string {
  const str = String(raw ?? '').replace(/[\r\n]+/g, ' ');
  if (/[",]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function toEtTradingDate(utcMs: number): string {
  return ET_DATE_FMT.format(new Date(utcMs));
}

export class EvalShieldDb {
  readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  withTx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        starting_balance REAL NOT NULL,
        realized_balance REAL NOT NULL,
        open_unrealized_pnl REAL NOT NULL DEFAULT 0,
        hwm REAL NOT NULL,
        day_realized_pnl REAL NOT NULL DEFAULT 0,
        drawdown_mode TEXT NOT NULL,
        max_drawdown REAL NOT NULL,
        daily_loss_limit REAL,
        alpha_soft_dll REAL NOT NULL DEFAULT 0.8,
        safety_reserve REAL NOT NULL DEFAULT 0,
        lock_cap REAL,
        max_contracts_cap INTEGER NOT NULL,
        consistency_cap REAL NOT NULL,
        profit_target REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        broker TEXT NOT NULL,
        exec_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        root_symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty REAL NOT NULL,
        price REAL NOT NULL,
        commission REAL NOT NULL,
        ts_utc TEXT NOT NULL,
        ts_utc_ms INTEGER NOT NULL,
        dedup_hash TEXT NOT NULL UNIQUE,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paired_trades (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        root_symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        qty REAL NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        entry_ts_utc TEXT NOT NULL,
        exit_ts_utc TEXT NOT NULL,
        entry_ts_ms INTEGER NOT NULL,
        exit_ts_ms INTEGER NOT NULL,
        gross_pnl_usd REAL NOT NULL,
        commission_usd REAL NOT NULL,
        net_pnl_usd REAL NOT NULL,
        hold_sec INTEGER NOT NULL,
        mae_usd REAL,
        mfe_usd REAL,
        rule_adherent INTEGER NOT NULL DEFAULT 1,
        violation_reason TEXT,
        dedup_hash TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS market_context (
        symbol TEXT PRIMARY KEY,
        atr14 REAL NOT NULL,
        atr20d_median REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS license_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        tier TEXT NOT NULL,
        max_accounts INTEGER,
        payer TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        activated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pretrade_audits (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        planned_qty REAL NOT NULL,
        stop_ticks INTEGER NOT NULL DEFAULT 10,
        remaining_buffer_at_entry REAL NOT NULL,
        consistency_headroom_usd REAL NOT NULL,
        news_risk_status TEXT NOT NULL,
        thesis_note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS byo_connectors (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        target TEXT NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        meta_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const cols = this.db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'account_stage')) {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN account_stage TEXT NOT NULL DEFAULT 'EVAL'`);
    }
  }

  getLicenseStatus(publicKeySpkiB64?: string): LicenseStatusRecord {
    const row = this.db
      .prepare('SELECT token, activated_at FROM license_state WHERE id = 1')
      .get() as { token: string; activated_at: string } | undefined;
    if (!row) {
      return {
        tier: 'free',
        valid: false,
        maxAccounts: null,
        payer: null,
        txHash: null,
        activatedAt: null
      };
    }
    const verified = verifyEvalShieldLicenseToken(row.token, { publicKeySpkiB64 });
    if (!verified.valid || !verified.payload) {
      return {
        tier: 'free',
        valid: false,
        maxAccounts: null,
        payer: null,
        txHash: null,
        activatedAt: null
      };
    }
    return {
      tier: verified.tier,
      valid: true,
      maxAccounts: getMaxAllowedAccounts(verified),
      payer: verified.payload.payer,
      txHash: verified.payload.txHash,
      activatedAt: row.activated_at
    };
  }

  activateLicense(token: string, publicKeySpkiB64?: string): LicenseStatusRecord {
    const verified = verifyEvalShieldLicenseToken(token, { publicKeySpkiB64 });
    if (!verified.valid || !verified.payload) {
      throw new DomainError(
        403,
        'INVALID_LICENSE_TOKEN',
        verified.reason ?? 'License verification failed.'
      );
    }
    const now = new Date().toISOString();
    const maxAcc = getMaxAllowedAccounts(verified);
    this.db
      .prepare(
        `INSERT INTO license_state (id, token, tier, max_accounts, payer, tx_hash, activated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           token = excluded.token,
           tier = excluded.tier,
           max_accounts = excluded.max_accounts,
           payer = excluded.payer,
           tx_hash = excluded.tx_hash,
           activated_at = excluded.activated_at`
      )
      .run(
        token.trim(),
        verified.tier,
        maxAcc,
        verified.payload.payer,
        verified.payload.txHash,
        now
      );
    return {
      tier: verified.tier,
      valid: true,
      maxAccounts: maxAcc,
      payer: verified.payload.payer,
      txHash: verified.payload.txHash,
      activatedAt: now
    };
  }

  listAccounts(): AccountRiskProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapAccountRow(r));
  }

  getAccount(accountId: string): AccountRiskProfile {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new DomainError(404, 'ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
    }
    return this.mapAccountRow(row);
  }

  private mapAccountRow(r: Record<string, unknown>): AccountRiskProfile {
    const accountId = String(r.id);
    const trades = this.db
      .prepare('SELECT exit_ts_ms, net_pnl_usd FROM paired_trades WHERE account_id = ?')
      .all(accountId) as Array<{ exit_ts_ms: number; net_pnl_usd: number }>;

    const byDay = new Map<string, number>();
    for (const t of trades) {
      const d = toEtTradingDate(t.exit_ts_ms);
      byDay.set(d, (byDay.get(d) ?? 0) + t.net_pnl_usd);
    }

    const presetId = String(r.preset_id) as PropPresetId;
    const preset = PROP_FIRM_PRESETS[presetId] ?? PROP_FIRM_PRESETS.custom;
    return {
      id: accountId,
      name: String(r.name),
      presetId,
      accountStage: (String(r.account_stage ?? 'EVAL') === 'FUNDED' ? 'FUNDED' : 'EVAL') as AccountStage,
      newsRestriction: preset.newsRestriction,
      antiHedgingBanned: preset.antiHedgingBanned,
      rolloverResetTimeZone: preset.rolloverResetTimeZone,
      startingBalance: Number(r.starting_balance),
      realizedBalance: Number(r.realized_balance),
      openUnrealizedPnl: Number(r.open_unrealized_pnl),
      hwm: Number(r.hwm),
      dayRealizedPnl: Number(r.day_realized_pnl),
      drawdownMode: String(r.drawdown_mode) as DrawdownMode,
      maxDrawdown: Number(r.max_drawdown),
      dailyLossLimit: r.daily_loss_limit === null ? null : Number(r.daily_loss_limit),
      alphaSoftDll: Number(r.alpha_soft_dll),
      safetyReserve: Number(r.safety_reserve),
      lockCap: r.lock_cap === null ? null : Number(r.lock_cap),
      maxContractsCap: Number(r.max_contracts_cap),
      consistencyCap: Number(r.consistency_cap),
      profitTarget: Number(r.profit_target),
      dailyRealizedPnls: Array.from(byDay.values()).map((v) => Math.round(v * 100) / 100)
    };
  }

  createAccount(
    input: CreateAccountInput,
    options?: { headerLicenseToken?: string; publicKeySpkiB64?: string }
  ): AccountRiskProfile {
    return this.withTx(() => {
      if (options?.headerLicenseToken) {
        const hdr = verifyEvalShieldLicenseToken(options.headerLicenseToken, {
          publicKeySpkiB64: options.publicKeySpkiB64
        });
        if (!hdr.valid) {
          throw new DomainError(403, 'INVALID_LICENSE_TOKEN', hdr.reason ?? 'Invalid license header.');
        }
      }

      const preset = PROP_FIRM_PRESETS[input.presetId];
      const id = makeId('acc');
      const now = new Date().toISOString();
      const startingBalance = input.startingBalance ?? preset.startingBalance;

      this.db
        .prepare(
          `INSERT INTO accounts (
            id, name, preset_id, account_stage, starting_balance, realized_balance, open_unrealized_pnl,
            hwm, day_realized_pnl, drawdown_mode, max_drawdown, daily_loss_limit,
            alpha_soft_dll, safety_reserve, lock_cap, max_contracts_cap, consistency_cap,
            profit_target, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.name.trim(),
          input.presetId,
          input.accountStage ?? 'EVAL',
          startingBalance,
          startingBalance,
          startingBalance,
          input.drawdownMode ?? preset.drawdownMode,
          input.maxDrawdown ?? preset.maxDrawdown,
          input.dailyLossLimit === undefined ? preset.dailyLossLimit : input.dailyLossLimit,
          input.alphaSoftDll ?? 0.8,
          input.safetyReserve ?? 0,
          input.lockCap === undefined ? preset.lockCap : input.lockCap,
          input.maxContractsCap ?? preset.maxContractsCap,
          input.consistencyCap ?? preset.consistencyCap,
          input.profitTarget ?? preset.profitTarget,
          now,
          now
        );

      return this.getAccount(id);
    });
  }

  updateAccountState(
    accountId: string,
    patch: Partial<{
      name: string;
      accountStage: AccountStage;
      realizedBalance: number;
      openUnrealizedPnl: number;
      hwm: number;
      dayRealizedPnl: number;
      alphaSoftDll: number;
      safetyReserve: number;
      dailyLossLimit: number | null;
      consistencyCap: number;
    }>
  ): AccountRiskProfile {
    this.getAccount(accountId);
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name.trim());
    }
    if (patch.accountStage !== undefined) {
      sets.push('account_stage = ?');
      params.push(patch.accountStage);
    }
    if (patch.realizedBalance !== undefined) {
      sets.push('realized_balance = ?');
      params.push(patch.realizedBalance);
    }
    if (patch.openUnrealizedPnl !== undefined) {
      sets.push('open_unrealized_pnl = ?');
      params.push(patch.openUnrealizedPnl);
    }
    if (patch.hwm !== undefined) {
      sets.push('hwm = ?');
      params.push(patch.hwm);
    }
    if (patch.dayRealizedPnl !== undefined) {
      sets.push('day_realized_pnl = ?');
      params.push(patch.dayRealizedPnl);
    }
    if (patch.alphaSoftDll !== undefined) {
      sets.push('alpha_soft_dll = ?');
      params.push(patch.alphaSoftDll);
    }
    if (patch.safetyReserve !== undefined) {
      sets.push('safety_reserve = ?');
      params.push(patch.safetyReserve);
    }
    if (patch.dailyLossLimit !== undefined) {
      sets.push('daily_loss_limit = ?');
      params.push(patch.dailyLossLimit);
    }
    if (patch.consistencyCap !== undefined) {
      sets.push('consistency_cap = ?');
      params.push(patch.consistencyCap);
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(accountId);
      this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    return this.getAccount(accountId);
  }

  deleteAccount(accountId: string): void {
    const info = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    if (info.changes === 0) {
      throw new DomainError(404, 'ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
    }
  }

  seedDefaultAccountIfEmpty(): AccountRiskProfile {
    const existing = this.listAccounts();
    if (existing.length > 0) {
      return existing[0]!;
    }
    return this.createAccount({ name: 'Topstep $50K Eval #1', presetId: 'topstep_50k' });
  }

  importCsv(
    accountId: string,
    csvText: string,
    format: BrokerCsvFormat = 'auto',
    options?: { maxAllowedContracts?: number }
  ): {
    formatUsed: string;
    importedExecutions: number;
    skippedDuplicates: number;
    pairedTradesCount: number;
    warnings: string[];
    account: AccountRiskProfile;
    scorecard: DisciplineScorecard;
  } {
    const account = this.getAccount(accountId);
    const parsed = parseBrokerCsv(csvText, format, accountId);

    return this.withTx(() => {
      let importedExecutions = 0;
      let skippedDuplicates = 0;

      const insertExec = this.db.prepare(
        `INSERT INTO executions (
          id, account_id, broker, exec_id, symbol, root_symbol, side, qty, price,
          commission, ts_utc, ts_utc_ms, dedup_hash, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_hash) DO NOTHING`
      );

      for (const ex of parsed.executions) {
        const res = insertExec.run(
          makeId('ex'),
          ex.accountId,
          ex.broker,
          ex.execId,
          ex.symbol,
          ex.rootSymbol,
          ex.side,
          ex.qty,
          ex.price,
          ex.commission,
          ex.tsUtc,
          ex.tsUtcMs,
          ex.dedupHash,
          ex.rawJson
        );
        if (res.changes > 0) importedExecutions += 1;
        else skippedDuplicates += 1;
      }

      // Rebuild FIFO paired trades from all stored executions for this account cleanly
      const allExecRows = this.db
        .prepare('SELECT * FROM executions WHERE account_id = ? ORDER BY ts_utc_ms ASC')
        .all(accountId) as Array<Record<string, unknown>>;

      const execs: NormalizedExecution[] = allExecRows.map((r) => ({
        accountId: String(r.account_id),
        broker: String(r.broker) as Exclude<BrokerCsvFormat, 'auto'>,
        execId: String(r.exec_id),
        symbol: String(r.symbol),
        rootSymbol: String(r.root_symbol),
        side: String(r.side) as 'BUY' | 'SELL',
        qty: Number(r.qty),
        price: Number(r.price),
        commission: Number(r.commission),
        tsUtc: String(r.ts_utc),
        tsUtcMs: Number(r.ts_utc_ms),
        dedupHash: String(r.dedup_hash),
        rawJson: String(r.raw_json)
      }));

      const fifoTrades = pairExecutionsFifo(execs);
      const insertTrade = this.db.prepare(
        `INSERT INTO paired_trades (
          id, account_id, root_symbol, direction, qty, entry_price, exit_price,
          entry_ts_utc, exit_ts_utc, entry_ts_ms, exit_ts_ms,
          gross_pnl_usd, commission_usd, net_pnl_usd, hold_sec, mae_usd, mfe_usd,
          rule_adherent, violation_reason, dedup_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_hash) DO NOTHING`
      );

      const maxCap = options?.maxAllowedContracts ?? account.maxContractsCap;

      for (const t of fifoTrades) {
        const oversized = t.qty > maxCap;
        const ruleAdherent = oversized ? 0 : 1;
        const violationReason = oversized ? `QTY_EXCEEDED_CAP (${t.qty} > ${maxCap})` : null;
        insertTrade.run(
          makeId('tr'),
          t.accountId,
          t.rootSymbol,
          t.direction,
          t.qty,
          t.entryPrice,
          t.exitPrice,
          t.entryTsUtc,
          t.exitTsUtc,
          t.entryTsMs,
          t.exitTsMs,
          t.grossPnlUsd,
          t.commissionUsd,
          t.netPnlUsd,
          t.holdSec,
          t.maeUsd,
          t.mfeUsd,
          ruleAdherent,
          violationReason,
          t.dedupHash
        );
      }

      for (const t of parsed.directTrades) {
        const oversized = t.qty > maxCap;
        const ruleAdherent = oversized ? 0 : 1;
        const violationReason = oversized ? `QTY_EXCEEDED_CAP (${t.qty} > ${maxCap})` : null;
        const r = insertTrade.run(
          makeId('tr'),
          t.accountId,
          t.rootSymbol,
          t.direction,
          t.qty,
          t.entryPrice,
          t.exitPrice,
          t.entryTsUtc,
          t.exitTsUtc,
          t.entryTsMs,
          t.exitTsMs,
          t.grossPnlUsd,
          t.commissionUsd,
          t.netPnlUsd,
          t.holdSec,
          t.maeUsd,
          t.mfeUsd,
          ruleAdherent,
          violationReason,
          t.dedupHash
        );
        if (r.changes > 0) importedExecutions += 1;
        else skippedDuplicates += 1;
      }

      const updatedAccount = this.recalculateAccountFromTrades(accountId);
      const scorecard = this.getDisciplineScorecard(accountId);
      return {
        formatUsed: parsed.formatUsed,
        importedExecutions,
        skippedDuplicates,
        pairedTradesCount: scorecard.totalTrades,
        warnings: parsed.warnings,
        account: updatedAccount,
        scorecard
      };
    });
  }

  ingestReadOnlyWebhook(input: {
    accountId: string;
    eventType: 'fill' | 'atr_bar';
    symbol: string;
    side?: 'BUY' | 'SELL';
    qty?: number;
    price?: number;
    commission?: number;
    execId?: string;
    tsUtc?: string;
    atr14?: number;
    atr20dMedian?: number;
  }): { ok: true; eventId: string; account?: AccountRiskProfile } {
    return this.withTx(() => {
      const now = new Date().toISOString();
      const eventId = makeId('wh');
      this.db
        .prepare(
          'INSERT INTO webhook_events (id, account_id, event_type, payload_json, received_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(eventId, input.accountId, input.eventType, JSON.stringify(input), now);

      if (input.eventType === 'atr_bar' && input.atr14 !== undefined) {
        this.db
          .prepare(
            `INSERT INTO market_context (symbol, atr14, atr20d_median, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(symbol) DO UPDATE SET
               atr14 = excluded.atr14,
               atr20d_median = excluded.atr20d_median,
               updated_at = excluded.updated_at`
          )
          .run(
            input.symbol.trim().toUpperCase(),
            input.atr14,
            input.atr20dMedian ?? input.atr14,
            now
          );
        return { ok: true as const, eventId };
      }

      if (input.eventType === 'fill') {
        const account = this.getAccount(input.accountId);
        const tsMs = input.tsUtc ? Date.parse(input.tsUtc) : Date.now();
        const tsIso = new Date(Number.isFinite(tsMs) ? tsMs : Date.now()).toISOString();
        const qty = input.qty ?? 1;
        const price = input.price ?? 0;
        const side = input.side ?? 'BUY';
        const execId = input.execId ?? eventId;
        const csvLine = [
          quoteRawCsvField(execId),
          quoteRawCsvField(execId),
          quoteRawCsvField(tsIso),
          quoteRawCsvField(tsIso),
          quoteRawCsvField(side),
          quoteRawCsvField(qty),
          quoteRawCsvField(price),
          quoteRawCsvField(input.symbol),
          quoteRawCsvField(input.commission ?? 0)
        ].join(',');
        const header = 'Fill ID,Order ID,Timestamp,_timestamp,Side,Quantity,Price,Contract,Commission';
        const imported = this.importCsv(account.id, `${header}\n${csvLine}`, 'tradovate-fills');
        return { ok: true as const, eventId, account: imported.account };
      }

      return { ok: true as const, eventId };
    });
  }

  getMarketContext(symbol: string): { symbol: string; atr14: number; atr20dMedian: number; updatedAt: string } | null {
    const row = this.db
      .prepare('SELECT symbol, atr14, atr20d_median, updated_at FROM market_context WHERE symbol = ?')
      .get(symbol.trim().toUpperCase()) as
      | { symbol: string; atr14: number; atr20d_median: number; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      symbol: row.symbol,
      atr14: row.atr14,
      atr20dMedian: row.atr20d_median,
      updatedAt: row.updated_at
    };
  }

  private recalculateAccountFromTrades(accountId: string): AccountRiskProfile {
    const acc = this.getAccount(accountId);
    const trades = this.listTrades(accountId);
    const totalNet = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const realizedBalance = Math.round((acc.startingBalance + totalNet) * 100) / 100;

    // Group daily realized PnLs in ET to compute latest day PnL and EOD vs Intraday HWM
    const dailyMap = new Map<string, number>();
    for (const t of trades) {
      const d = toEtTradingDate(t.exitTsMs);
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + t.netPnlUsd);
    }

    const sortedDays = Array.from(dailyMap.entries()).sort(([a], [b]) => a.localeCompare(b));
    const todayEt = toEtTradingDate(Date.now());
    const todayEntry = sortedDays.find(([d]) => d === todayEt);
    const dayRealizedPnl = todayEntry ? todayEntry[1] : 0;

    let running = acc.startingBalance;
    let hwm = acc.startingBalance;
    if (acc.drawdownMode === 'EOD_TRAILING') {
      // Advance HWM strictly across closed days prior to today's open session
      for (const [dayKey, dayPnl] of sortedDays) {
        if (dayKey === todayEt) continue;
        running += dayPnl;
        hwm = Math.max(hwm, running);
      }
    } else if (acc.drawdownMode === 'INTRADAY_TRAILING') {
      for (const t of trades) {
        running += t.netPnlUsd;
        hwm = Math.max(hwm, running);
      }
    }

    return this.updateAccountState(accountId, {
      realizedBalance,
      hwm: Math.round(hwm * 100) / 100,
      dayRealizedPnl: Math.round(dayRealizedPnl * 100) / 100
    });
  }

  listTrades(accountId: string): PairedTradeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM paired_trades WHERE account_id = ? ORDER BY exit_ts_ms ASC')
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      rootSymbol: String(r.root_symbol),
      direction: String(r.direction) as 'LONG' | 'SHORT',
      qty: Number(r.qty),
      entryPrice: Number(r.entry_price),
      exitPrice: Number(r.exit_price),
      entryTsUtc: String(r.entry_ts_utc),
      exitTsUtc: String(r.exit_ts_utc),
      entryTsMs: Number(r.entry_ts_ms),
      exitTsMs: Number(r.exit_ts_ms),
      grossPnlUsd: Number(r.gross_pnl_usd),
      commissionUsd: Number(r.commission_usd),
      netPnlUsd: Number(r.net_pnl_usd),
      holdSec: Number(r.hold_sec),
      maeUsd: r.mae_usd === null ? null : Number(r.mae_usd),
      mfeUsd: r.mfe_usd === null ? null : Number(r.mfe_usd),
      ruleAdherent: Number(r.rule_adherent) === 1,
      violationReason: r.violation_reason === null ? null : String(r.violation_reason),
      dedupHash: String(r.dedup_hash)
    }));
  }

  getDisciplineScorecard(accountId: string): DisciplineScorecard {
    this.getAccount(accountId);
    const trades = this.listTrades(accountId);
    const totalTrades = trades.length;
    const wins = trades.filter((t) => t.netPnlUsd > 0).length;
    const losses = trades.filter((t) => t.netPnlUsd < 0).length;
    const grossWins = trades.filter((t) => t.netPnlUsd > 0).reduce((s, t) => s + t.netPnlUsd, 0);
    const grossLossesAbs = Math.abs(
      trades.filter((t) => t.netPnlUsd < 0).reduce((s, t) => s + t.netPnlUsd, 0)
    );
    const netPnlUsd = Math.round(trades.reduce((s, t) => s + t.netPnlUsd, 0) * 100) / 100;
    const adherentCount = trades.filter((t) => t.ruleAdherent).length;
    const tiltLeakageUsd =
      Math.round(
        trades
          .filter((t) => !t.ruleAdherent && t.netPnlUsd < 0)
          .reduce((s, t) => s + Math.abs(t.netPnlUsd), 0) * 100
      ) / 100;

    let consecutiveLossesToday = 0;
    let lastLossUtcMs: number | null = null;
    if (trades.length > 0) {
      const latestDay = toEtTradingDate(trades[trades.length - 1]!.exitTsMs);
      for (let i = trades.length - 1; i >= 0; i -= 1) {
        const t = trades[i]!;
        if (toEtTradingDate(t.exitTsMs) !== latestDay) break;
        if (t.netPnlUsd < 0) {
          consecutiveLossesToday += 1;
          if (lastLossUtcMs === null) {
            lastLossUtcMs = t.exitTsMs;
          }
        } else {
          break;
        }
      }
    }

    return {
      accountId,
      totalTrades,
      wins,
      losses,
      winRatePct: totalTrades > 0 ? Math.round((wins / totalTrades) * 10000) / 100 : 0,
      profitFactor:
        grossLossesAbs > 0 ? Math.round((grossWins / grossLossesAbs) * 100) / 100 : null,
      netPnlUsd,
      ruleAdherencePct:
        totalTrades > 0 ? Math.round((adherentCount / totalTrades) * 10000) / 100 : 100,
      tiltLeakageUsd,
      consecutiveLossesToday,
      lastLossUtcMs,
      empiricalNetPnls: trades.map((t) => t.netPnlUsd)
    };
  }

  exportTradesCsv(accountId: string): string {
    const trades = this.listTrades(accountId);
    const headers = [
      'id',
      'root_symbol',
      'direction',
      'qty',
      'entry_price',
      'exit_price',
      'entry_ts_utc',
      'exit_ts_utc',
      'gross_pnl_usd',
      'commission_usd',
      'net_pnl_usd',
      'hold_sec',
      'rule_adherent',
      'violation_reason'
    ];
    const lines = [headers.join(',')];
    for (const t of trades) {
      lines.push(
        [
          escapeCsvCell(t.id),
          escapeCsvCell(t.rootSymbol),
          escapeCsvCell(t.direction),
          escapeCsvCell(t.qty),
          escapeCsvCell(t.entryPrice),
          escapeCsvCell(t.exitPrice),
          escapeCsvCell(t.entryTsUtc),
          escapeCsvCell(t.exitTsUtc),
          escapeCsvCell(t.grossPnlUsd),
          escapeCsvCell(t.commissionUsd),
          escapeCsvCell(t.netPnlUsd),
          escapeCsvCell(t.holdSec),
          escapeCsvCell(t.ruleAdherent),
          escapeCsvCell(t.violationReason ?? '')
        ].join(',')
      );
    }
    return lines.join('\n');
  }

  recordPretradeAudit(input: CreatePretradeAuditInput): PretradeAuditRecord {
    const account = this.getAccount(input.accountId);
    const customSpec = this.getCustomAssetProfile(input.symbol) ?? undefined;
    const stopTicks = Math.max(1, Math.floor(input.stopTicks ?? 10));
    const check = evaluateRiskCheck(
      {
        account,
        symbol: input.symbol,
        userStopTicks: stopTicks,
        sessionFilter: {
          nowUtcMs: input.nowUtcMs,
          skipGlobexCheck: true
        }
      },
      customSpec
    );
    const dd = computeDrawdownState(account);
    const newsRiskStatus = check.session.flags.join(',') || check.session.sessionAction;
    const id = makeId('pt');
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO pretrade_audits (
          id, account_id, symbol, side, planned_qty, stop_ticks,
          remaining_buffer_at_entry, consistency_headroom_usd, news_risk_status,
          thesis_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        account.id,
        check.symbol,
        input.side,
        input.plannedQty,
        stopTicks,
        dd.remainingBuffer,
        check.remainingSafeAdditionalProfitUsd,
        newsRiskStatus,
        input.thesisNote.trim(),
        createdAt
      );

    return {
      id,
      accountId: account.id,
      symbol: check.symbol,
      side: input.side,
      plannedQty: input.plannedQty,
      stopTicks,
      remainingBufferAtEntry: dd.remainingBuffer,
      consistencyHeadroomUsd: check.remainingSafeAdditionalProfitUsd,
      newsRiskStatus,
      thesisNote: input.thesisNote.trim(),
      createdAt
    };
  }

  listPretradeAudits(accountId: string, limit = 50): PretradeAuditRecord[] {
    this.getAccount(accountId);
    const rows = this.db
      .prepare('SELECT * FROM pretrade_audits WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(accountId, Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      symbol: String(r.symbol),
      side: String(r.side) as 'LONG' | 'SHORT',
      plannedQty: Number(r.planned_qty),
      stopTicks: Number(r.stop_ticks),
      remainingBufferAtEntry: Number(r.remaining_buffer_at_entry),
      consistencyHeadroomUsd: Number(r.consistency_headroom_usd),
      newsRiskStatus: String(r.news_risk_status),
      thesisNote: String(r.thesis_note),
      createdAt: String(r.created_at)
    }));
  }

  createConnector(
    input: {
      kind: ByoConnectorKind;
      label: string;
      target: string;
      keywords?: string[];
      enabled?: boolean;
      metaJson?: Record<string, unknown>;
    },
    options?: { allowLoopbackForTest?: boolean }
  ): ByoConnectorConfig {
    if (input.kind === 'rss') {
      try {
        validateSafeConnectorUrl(input.target, {
          allowLoopbackForTest: options?.allowLoopbackForTest
        });
      } catch (err) {
        throw new DomainError(
          400,
          'DISALLOWED_CONNECTOR_URL',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    const id = makeId('conn');
    const now = new Date().toISOString();
    const keywords = (input.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 12);
    const metaJson = input.metaJson ?? {};
    const enabled = input.enabled ?? true;
    const targetClean =
      input.kind === 'custom_asset' ? normalizeSymbolRoot(input.target) : input.target.trim();

    this.db
      .prepare(
        `INSERT INTO byo_connectors (
          id, kind, label, target, keywords_json, enabled, meta_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.label.trim(),
        targetClean,
        JSON.stringify(keywords),
        enabled ? 1 : 0,
        JSON.stringify(metaJson),
        now,
        now
      );

    return {
      id,
      kind: input.kind,
      label: input.label.trim(),
      target: targetClean,
      keywords,
      enabled,
      metaJson,
      createdAt: now,
      updatedAt: now
    };
  }

  listConnectors(): ByoConnectorConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM byo_connectors ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as ByoConnectorKind,
      label: String(r.label),
      target: String(r.target),
      keywords: JSON.parse(String(r.keywords_json || '[]')) as string[],
      enabled: Number(r.enabled) === 1,
      metaJson: JSON.parse(String(r.meta_json || '{}')) as Record<string, unknown>,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at)
    }));
  }

  deleteConnector(connectorId: string): void {
    const info = this.db.prepare('DELETE FROM byo_connectors WHERE id = ?').run(connectorId);
    if (info.changes === 0) {
      throw new DomainError(404, 'CONNECTOR_NOT_FOUND', `Connector not found: ${connectorId}`);
    }
  }

  getCustomAssetProfile(symbolOrRaw: string): ContractSpec | null {
    const clean = symbolOrRaw.trim().toUpperCase().replace(/^.*:/, '').split(/\s+/)[0] ?? '';
    const connectors = this.listConnectors().filter((c) => c.kind === 'custom_asset' && c.enabled);
    const match = connectors.find(
      (c) => c.target.toUpperCase() === clean || c.target.toUpperCase() === normalizeSymbolRoot(symbolOrRaw)
    );
    if (!match || !match.metaJson) return null;
    const m = match.metaJson;
    const tickSize = Number(m.tickSize);
    const tickValue = Number(m.tickValue);
    if (!Number.isFinite(tickSize) || tickSize <= 0 || !Number.isFinite(tickValue) || tickValue <= 0) {
      return null;
    }
    const pointValue = Number(m.pointValue);
    return {
      symbol: match.target.toUpperCase(),
      name: match.label,
      assetClass: 'CUSTOM',
      tickSize,
      tickValue,
      pointValue: Number.isFinite(pointValue) && pointValue > 0 ? pointValue : tickValue / tickSize,
      defaultRoundTripCommission: Number(m.defaultRoundTripCommission ?? 0) || 0,
      makerFeeBps: typeof m.makerFeeBps === 'number' ? m.makerFeeBps : undefined,
      takerFeeBps: typeof m.takerFeeBps === 'number' ? m.takerFeeBps : undefined
    };
  }
}
