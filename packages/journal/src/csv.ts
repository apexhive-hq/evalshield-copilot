import { createHash } from 'node:crypto';
import { getContractSpec, normalizeSymbolRoot } from '@evalshield/core';

export type BrokerCsvFormat =
  | 'auto'
  | 'tradovate-fills'
  | 'tradovate-perf'
  | 'nt8-trades'
  | 'nt8-execs'
  | 'rithmic'
  | 'tradingview';

export interface NormalizedExecution {
  accountId: string;
  broker: Exclude<BrokerCsvFormat, 'auto'>;
  execId: string;
  symbol: string;
  rootSymbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  commission: number;
  tsUtc: string;
  tsUtcMs: number;
  dedupHash: string;
  rawJson: string;
}

export interface PairedTradeInput {
  accountId: string;
  rootSymbol: string;
  direction: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTsUtc: string;
  exitTsUtc: string;
  entryTsMs: number;
  exitTsMs: number;
  grossPnlUsd: number;
  commissionUsd: number;
  netPnlUsd: number;
  holdSec: number;
  maeUsd: number | null;
  mfeUsd: number | null;
  dedupHash: string;
}

export interface ParsedCsvImport {
  formatUsed: Exclude<BrokerCsvFormat, 'auto'>;
  executions: NormalizedExecution[];
  directTrades: PairedTradeInput[];
  warnings: string[];
}

/**
 * RFC-4180 compliant CSV parser supporting BOM, CRLF/LF, and quoted fields with embedded commas/newlines.
 */
export function parseCsvMatrix(rawText: string): string[][] {
  const text = rawText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1;
      }
      row.push(cell.trim());
      if (row.some((v) => v.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.trim());
      if (row.some((v) => v.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((v) => v.length > 0)) {
      rows.push(row);
    }
  }
  return rows;
}

export function parseCsvObjects(rawText: string): { headers: string[]; rows: Record<string, string>[] } {
  const matrix = parseCsvMatrix(rawText);
  if (matrix.length < 2) {
    return { headers: matrix[0] ?? [], rows: [] };
  }
  const headers = matrix[0]!.map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const vals = matrix[i]!;
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c]!;
      rec[key] = vals[c] ?? '';
    }
    rows.push(rec);
  }
  return { headers, rows };
}

function parseMoneyNumber(raw: string | undefined): number {
  if (!raw) return 0;
  let s = raw.trim().replace(/[$,\s]/g, '');
  if (s.startsWith('(') && s.endsWith(')')) {
    s = `-${s.slice(1, -1)}`;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseTimestampUtc(raw: string | undefined): { iso: string; ms: number } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new Error('Missing execution timestamp in CSV row.');
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`Unparseable timestamp: ${trimmed}`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}

function computeDedupHash(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function normalizeSide(raw: string | undefined): 'BUY' | 'SELL' {
  const s = (raw ?? '').trim().toUpperCase();
  if (s === 'BUY' || s === 'B' || s === 'LONG' || s === 'BOT') return 'BUY';
  if (s === 'SELL' || s === 'S' || s === 'SHORT' || s === 'SLD') return 'SELL';
  throw new Error(`Unrecognized trade side: ${raw}`);
}

export function detectCsvFormat(headers: string[]): Exclude<BrokerCsvFormat, 'auto'> {
  const set = new Set(headers.map((h) => h.trim()));
  if (set.has('Fill ID') && set.has('Order ID') && set.has('Contract')) {
    return 'tradovate-fills';
  }
  if (set.has('Contract') && set.has('Entry Price') && set.has('Exit Price') && set.has('P&L')) {
    return 'tradovate-perf';
  }
  if (set.has('Instrument') && set.has('Market Position') && set.has('Entry Time')) {
    return 'nt8-trades';
  }
  if (set.has('Instrument') && set.has('Execution ID') && set.has('Action')) {
    return 'nt8-execs';
  }
  if (set.has('Buy/Sell') && set.has('Qty Filled') && set.has('Avg Fill Price')) {
    return 'rithmic';
  }
  if (set.has('Symbol') && set.has('Side') && (set.has('Profit / Loss') || set.has('Avg entry price'))) {
    return 'tradingview';
  }
  throw new Error(
    `Unable to auto-detect broker CSV format from headers: ${headers.join(', ')}`
  );
}

export function parseBrokerCsv(
  csvText: string,
  format: BrokerCsvFormat,
  accountId: string
): ParsedCsvImport {
  const { headers, rows } = parseCsvObjects(csvText);
  if (headers.length === 0) {
    throw new Error('CSV contains no header row.');
  }
  const resolved = format === 'auto' ? detectCsvFormat(headers) : format;
  const warnings: string[] = [];
  const executions: NormalizedExecution[] = [];
  const directTrades: PairedTradeInput[] = [];

  if (resolved === 'rithmic') {
    const required = ['Status', 'Buy/Sell', 'Symbol', 'Qty Filled', 'Avg Fill Price'];
    const headerSet = new Set(headers);
    const missing = required.filter((col) => !headerSet.has(col));
    if (!headerSet.has('Create Time') && !headerSet.has('Update Time')) {
      missing.push('Create Time or Update Time');
    }
    if (missing.length > 0) {
      throw new Error(
        `Rithmic CSV is missing required grid columns (${missing.join(', ')}). Enable them via Add/Remove Columns in R | Trader Pro before exporting.`
      );
    }
  }

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx]!;
    if (resolved === 'tradovate-fills') {
      const symbol = row['Contract'] ?? '';
      const rootSymbol = normalizeSymbolRoot(symbol);
      const side = normalizeSide(row['Side']);
      const qty = Math.abs(parseMoneyNumber(row['Quantity']));
      const price = parseMoneyNumber(row['Price']);
      const commission = Math.abs(parseMoneyNumber(row['Commission']));
      const execId = row['Fill ID'] || row['Order ID'] || `tvf_${idx}`;
      const ts = parseTimestampUtc(row['_timestamp'] || row['Timestamp']);
      executions.push({
        accountId,
        broker: resolved,
        execId,
        symbol,
        rootSymbol,
        side,
        qty,
        price,
        commission,
        tsUtc: ts.iso,
        tsUtcMs: ts.ms,
        dedupHash: computeDedupHash([resolved, accountId, execId, ts.iso, rootSymbol, side, qty, price]),
        rawJson: JSON.stringify(row)
      });
    } else if (resolved === 'tradovate-perf') {
      const symbol = row['Contract'] ?? '';
      const rootSymbol = normalizeSymbolRoot(symbol);
      const spec = getContractSpec(rootSymbol);
      const rawSize = parseMoneyNumber(row['Size']);
      const qty = Math.abs(rawSize);
      const entryPrice = parseMoneyNumber(row['Entry Price']);
      const exitPrice = parseMoneyNumber(row['Exit Price']);
      const pnl = parseMoneyNumber(row['P&L']);
      const direction: 'LONG' | 'SHORT' =
        rawSize < 0 ? 'SHORT' : (exitPrice - entryPrice) * pnl >= 0 ? 'LONG' : 'SHORT';
      const nowIso = parseTimestampUtc(row['Timestamp'] || row['Exit Time'] || new Date().toISOString());
      const grossPnlUsd =
        (exitPrice - entryPrice) * (direction === 'LONG' ? 1 : -1) * qty * spec.pointValue;
      directTrades.push({
        accountId,
        rootSymbol,
        direction,
        qty,
        entryPrice,
        exitPrice,
        entryTsUtc: nowIso.iso,
        exitTsUtc: nowIso.iso,
        entryTsMs: nowIso.ms,
        exitTsMs: nowIso.ms,
        grossPnlUsd: Math.round(grossPnlUsd * 100) / 100,
        commissionUsd: 0,
        netPnlUsd: Math.round(pnl * 100) / 100,
        holdSec: 0,
        maeUsd: null,
        mfeUsd: null,
        dedupHash: computeDedupHash([resolved, accountId, idx, rootSymbol, qty, entryPrice, exitPrice, pnl])
      });
      if (idx === 0) {
        warnings.push('Tradovate Performance CSV omits commissions; import Cash History or Fills CSV for fee-adjusted net PnL.');
      }
    } else if (resolved === 'nt8-execs') {
      const symbol = row['Instrument'] ?? '';
      const rootSymbol = normalizeSymbolRoot(symbol);
      const side = normalizeSide(row['Action']);
      const qty = Math.abs(parseMoneyNumber(row['Quantity']));
      const price = parseMoneyNumber(row['Price']);
      const commission = Math.abs(parseMoneyNumber(row['Commission']));
      const execId = row['Execution ID'] || `nt8e_${idx}`;
      const ts = parseTimestampUtc(row['Time']);
      executions.push({
        accountId,
        broker: resolved,
        execId,
        symbol,
        rootSymbol,
        side,
        qty,
        price,
        commission,
        tsUtc: ts.iso,
        tsUtcMs: ts.ms,
        dedupHash: computeDedupHash([resolved, accountId, execId, ts.iso, rootSymbol, side, qty, price]),
        rawJson: JSON.stringify(row)
      });
    } else if (resolved === 'nt8-trades') {
      const symbol = row['Instrument'] ?? '';
      const rootSymbol = normalizeSymbolRoot(symbol);
      const posRaw = (row['Market Position'] ?? '').trim().toUpperCase();
      const direction: 'LONG' | 'SHORT' = posRaw === 'SHORT' ? 'SHORT' : 'LONG';
      const qty = Math.abs(parseMoneyNumber(row['Quantity']));
      const entryPrice = parseMoneyNumber(row['Entry Price']);
      const exitPrice = parseMoneyNumber(row['Exit Price']);
      const entryTs = parseTimestampUtc(row['Entry Time']);
      const exitTs = parseTimestampUtc(row['Exit Time']);
      const commission = Math.abs(parseMoneyNumber(row['Commission']));
      const netPnl = parseMoneyNumber(row['Profit']);
      const grossPnl = netPnl + commission;
      const mae = row['MAE'] ? parseMoneyNumber(row['MAE']) : null;
      const mfe = row['MFE'] ? parseMoneyNumber(row['MFE']) : null;
      directTrades.push({
        accountId,
        rootSymbol,
        direction,
        qty,
        entryPrice,
        exitPrice,
        entryTsUtc: entryTs.iso,
        exitTsUtc: exitTs.iso,
        entryTsMs: entryTs.ms,
        exitTsMs: exitTs.ms,
        grossPnlUsd: Math.round(grossPnl * 100) / 100,
        commissionUsd: Math.round(commission * 100) / 100,
        netPnlUsd: Math.round(netPnl * 100) / 100,
        holdSec: Math.max(0, Math.round((exitTs.ms - entryTs.ms) / 1000)),
        maeUsd: mae,
        mfeUsd: mfe,
        dedupHash: computeDedupHash([
          resolved,
          accountId,
          rootSymbol,
          direction,
          qty,
          entryTs.iso,
          exitTs.iso,
          entryPrice,
          exitPrice
        ])
      });
    } else if (resolved === 'rithmic') {
      const status = (row['Status'] ?? '').trim().toUpperCase();
      if (status !== 'FILLED' && status !== 'COMPLETE') {
        continue;
      }
      const symbol = row['Symbol'] ?? '';
      const rootSymbol = normalizeSymbolRoot(symbol);
      const side = normalizeSide(row['Buy/Sell']);
      const qty = Math.abs(parseMoneyNumber(row['Qty Filled']));
      const price = parseMoneyNumber(row['Avg Fill Price']);
      const commission = Math.abs(parseMoneyNumber(row['Commission']));
      const execId = row['Order Number'] || `rit_${idx}`;
      const ts = parseTimestampUtc(row['Update Time'] || row['Create Time']);
      executions.push({
        accountId,
        broker: resolved,
        execId,
        symbol,
        rootSymbol,
        side,
        qty,
        price,
        commission,
        tsUtc: ts.iso,
        tsUtcMs: ts.ms,
        dedupHash: computeDedupHash([resolved, accountId, execId, ts.iso, rootSymbol, side, qty, price]),
        rawJson: JSON.stringify(row)
      });
    } else if (resolved === 'tradingview') {
      const symbol = row['Symbol'] ?? '';
      const rootSymbol = normalizeSymbolRoot(symbol);
      if (row['Avg entry price'] && row['Avg exit price']) {
        const direction: 'LONG' | 'SHORT' = normalizeSide(row['Side']) === 'BUY' ? 'LONG' : 'SHORT';
        const qty = Math.abs(parseMoneyNumber(row['Amount'] || row['Qty'] || '1'));
        const entryPrice = parseMoneyNumber(row['Avg entry price']);
        const exitPrice = parseMoneyNumber(row['Avg exit price']);
        const entryTs = parseTimestampUtc(row['Time of first entry']);
        const exitTs = parseTimestampUtc(row['Time of final exit']);
        const comm = Math.abs(parseMoneyNumber(row['Total commission costs']));
        const spec = getContractSpec(rootSymbol);
        const gross =
          (exitPrice - entryPrice) * (direction === 'LONG' ? 1 : -1) * qty * spec.pointValue;
        const net = gross - comm;
        directTrades.push({
          accountId,
          rootSymbol,
          direction,
          qty,
          entryPrice,
          exitPrice,
          entryTsUtc: entryTs.iso,
          exitTsUtc: exitTs.iso,
          entryTsMs: entryTs.ms,
          exitTsMs: exitTs.ms,
          grossPnlUsd: Math.round(gross * 100) / 100,
          commissionUsd: Math.round(comm * 100) / 100,
          netPnlUsd: Math.round(net * 100) / 100,
          holdSec: Math.max(0, Math.round((exitTs.ms - entryTs.ms) / 1000)),
          maeUsd: null,
          mfeUsd: null,
          dedupHash: computeDedupHash([
            resolved,
            accountId,
            rootSymbol,
            direction,
            qty,
            entryTs.iso,
            exitTs.iso,
            entryPrice,
            exitPrice
          ])
        });
      } else {
        const side = normalizeSide(row['Side'] || row['Type']);
        const qty = Math.abs(parseMoneyNumber(row['Amount']));
        const price = parseMoneyNumber(row['Price']);
        const ts = parseTimestampUtc(row['Time']);
        const execId = row['ID'] || `tv_${idx}`;
        executions.push({
          accountId,
          broker: resolved,
          execId,
          symbol,
          rootSymbol,
          side,
          qty,
          price,
          commission: 0,
          tsUtc: ts.iso,
          tsUtcMs: ts.ms,
          dedupHash: computeDedupHash([resolved, accountId, execId, ts.iso, rootSymbol, side, qty, price]),
          rawJson: JSON.stringify(row)
        });
      }
    }
  }

  return { formatUsed: resolved, executions, directTrades, warnings };
}

interface OpenLot {
  qty: number;
  price: number;
  commissionRemaining: number;
  tsUtc: string;
  tsUtcMs: number;
  side: 'BUY' | 'SELL';
  dedupHash: string;
}

/**
 * Deterministic FIFO position matcher converting raw buy/sell executions into paired round-trip trades.
 */
export function pairExecutionsFifo(executions: NormalizedExecution[]): PairedTradeInput[] {
  const byGroup = new Map<string, NormalizedExecution[]>();
  for (const ex of executions) {
    const key = `${ex.accountId}::${ex.rootSymbol}`;
    const list = byGroup.get(key) ?? [];
    list.push(ex);
    byGroup.set(key, list);
  }

  const trades: PairedTradeInput[] = [];

  for (const [, list] of byGroup) {
    const sorted = [...list].sort((a, b) =>
      a.tsUtcMs !== b.tsUtcMs ? a.tsUtcMs - b.tsUtcMs : a.execId.localeCompare(b.execId)
    );
    const openLots: OpenLot[] = [];
    let lotIdx = 0;

    for (const ex of sorted) {
      let remainingQty = ex.qty;
      let remainingComm = ex.commission;
      const spec = getContractSpec(ex.rootSymbol);

      while (remainingQty > 0 && openLots.length > 0 && openLots[0]!.side !== ex.side) {
        const head = openLots[0]!;
        const matched = Math.min(remainingQty, head.qty);
        const headCommShare = head.qty > 0 ? head.commissionRemaining * (matched / head.qty) : 0;
        const exCommShare = remainingQty > 0 ? remainingComm * (matched / remainingQty) : 0;

        const direction: 'LONG' | 'SHORT' = head.side === 'BUY' ? 'LONG' : 'SHORT';
        const dirSign = direction === 'LONG' ? 1 : -1;
        const grossPnlUsd = (ex.price - head.price) * dirSign * matched * spec.pointValue;
        const commissionUsd = headCommShare + exCommShare;
        const netPnlUsd = grossPnlUsd - commissionUsd;

        trades.push({
          accountId: ex.accountId,
          rootSymbol: ex.rootSymbol,
          direction,
          qty: matched,
          entryPrice: head.price,
          exitPrice: ex.price,
          entryTsUtc: head.tsUtc,
          exitTsUtc: ex.tsUtc,
          entryTsMs: head.tsUtcMs,
          exitTsMs: ex.tsUtcMs,
          grossPnlUsd: Math.round(grossPnlUsd * 100) / 100,
          commissionUsd: Math.round(commissionUsd * 100) / 100,
          netPnlUsd: Math.round(netPnlUsd * 100) / 100,
          holdSec: Math.max(0, Math.round((ex.tsUtcMs - head.tsUtcMs) / 1000)),
          maeUsd: null,
          mfeUsd: null,
          dedupHash: computeDedupHash([
            'fifo',
            ex.accountId,
            ex.rootSymbol,
            head.dedupHash,
            ex.dedupHash,
            lotIdx++,
            matched
          ])
        });

        head.qty -= matched;
        head.commissionRemaining -= headCommShare;
        remainingQty -= matched;
        remainingComm -= exCommShare;
        if (head.qty <= 1e-9) {
          openLots.shift();
        }
      }

      if (remainingQty > 1e-9) {
        openLots.push({
          qty: remainingQty,
          price: ex.price,
          commissionRemaining: remainingComm,
          tsUtc: ex.tsUtc,
          tsUtcMs: ex.tsUtcMs,
          side: ex.side,
          dedupHash: ex.dedupHash
        });
      }
    }
  }

  return trades.sort((a, b) => a.exitTsMs - b.exitTsMs);
}
