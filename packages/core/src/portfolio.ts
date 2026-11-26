import { normalizeSymbolRoot } from './contracts.js';
import { computeDrawdownState } from './risk.js';
import type {
  AccountRiskProfile,
  PortfolioGuardAlert,
  PortfolioGuardResult,
  PortfolioPositionInput
} from './types.js';

function getCorrelationBucket(rootSymbol: string): string {
  if (rootSymbol === 'ES' || rootSymbol === 'MES' || rootSymbol === 'NQ' || rootSymbol === 'MNQ') {
    return 'US_EQUITY_INDEX';
  }
  if (rootSymbol === 'GC' || rootSymbol === 'MGC' || rootSymbol === 'XAUUSD') {
    return 'GOLD_METALS';
  }
  if (rootSymbol === 'CL' || rootSymbol === 'MCL') {
    return 'CRUDE_ENERGY';
  }
  if (rootSymbol === 'BTC-PERP' || rootSymbol === 'ETH-PERP' || rootSymbol === 'SOL-PERP') {
    return 'CRYPTO_BETA';
  }
  return rootSymbol;
}

function toMiniEquivalentLots(rootSymbol: string, qty: number): number {
  if (rootSymbol === 'MES' || rootSymbol === 'MNQ' || rootSymbol === 'MGC' || rootSymbol === 'MCL') {
    return qty * 0.1;
  }
  return qty;
}

/**
 * Evaluates multi-account correlation concentration, Tradeify/FTMO cross-account
 * anti-hedging bans, copy-trader orphan/quantity skew, and aggregate DD buffer.
 */
export function evaluatePortfolioGuard(
  positions: PortfolioPositionInput[],
  accounts: AccountRiskProfile[] = []
): PortfolioGuardResult {
  const alerts: PortfolioGuardAlert[] = [];
  const correlatedBuckets: PortfolioGuardResult['correlatedBuckets'] = {};
  const bucketAccounts = new Map<string, Set<string>>();
  const byRoot = new Map<string, PortfolioPositionInput[]>();

  for (const pos of positions) {
    if (!Number.isFinite(pos.qty) || pos.qty <= 0) continue;
    const root = normalizeSymbolRoot(pos.symbol);
    const list = byRoot.get(root) ?? [];
    list.push({ ...pos, symbol: root });
    byRoot.set(root, list);

    const bucket = getCorrelationBucket(root);
    const eqLots = toMiniEquivalentLots(root, pos.qty);
    const signed = pos.side === 'LONG' ? eqLots : -eqLots;
    const accSet = bucketAccounts.get(bucket) ?? new Set<string>();
    accSet.add(pos.accountId);
    bucketAccounts.set(bucket, accSet);

    const cur = correlatedBuckets[bucket] ?? { totalSignedLots: 0, grossLots: 0, accounts: 0 };
    cur.totalSignedLots = Math.round((cur.totalSignedLots + signed) * 100) / 100;
    cur.grossLots = Math.round((cur.grossLots + eqLots) * 100) / 100;
    cur.accounts = accSet.size;
    correlatedBuckets[bucket] = cur;
  }

  // 1. Cross-account anti-hedging detection (same root or correlated bucket opposite direction)
  const bucketDirections = new Map<string, { longs: PortfolioPositionInput[]; shorts: PortfolioPositionInput[] }>();
  for (const pos of positions) {
    if (!Number.isFinite(pos.qty) || pos.qty <= 0) continue;
    const root = normalizeSymbolRoot(pos.symbol);
    const bucket = getCorrelationBucket(root);
    const entry = bucketDirections.get(bucket) ?? { longs: [], shorts: [] };
    if (pos.side === 'LONG') entry.longs.push(pos);
    else entry.shorts.push(pos);
    bucketDirections.set(bucket, entry);
  }

  for (const [bucket, dirs] of bucketDirections.entries()) {
    if (dirs.longs.length > 0 && dirs.shorts.length > 0) {
      const involved = Array.from(
        new Set([...dirs.longs, ...dirs.shorts].map((p) => p.accountId))
      );
      const anyStrictBan = [...dirs.longs, ...dirs.shorts].some((p) => p.antiHedgingBanned !== false);
      if (involved.length >= 1 && anyStrictBan) {
        alerts.push({
          code: 'CROSS_ACCOUNT_ANTI_HEDGE_VIOLATION',
          severity: 'CRITICAL',
          message: `Conflicting LONG & SHORT exposure detected in correlated bucket ${bucket} across accounts [${involved.join(', ')}] — violates Tradeify/FTMO anti-hedging rule.`,
          accounts: involved
        });
      }
    }
  }

  // 2. Correlated ES+NQ / Beta concentration (>= 1.75x normalized risk load)
  for (const [bucket, info] of Object.entries(correlatedBuckets)) {
    const netAbs = Math.abs(info.totalSignedLots);
    if (netAbs >= 1.75 && info.accounts >= 1) {
      const sameBucketCount = positions.filter((p) => getCorrelationBucket(normalizeSymbolRoot(p.symbol)) === bucket).length;
      if (sameBucketCount >= 2) {
        alerts.push({
          code: 'CORRELATED_EXPOSURE_MULTIPLIER',
          severity: netAbs >= 4 ? 'CRITICAL' : 'WARN',
          message: `Correlated basket ${bucket} carries ${netAbs} equivalent full-size lots across ${sameBucketCount} positions; effective beta exposure multiplied.`,
          accounts: Array.from(bucketAccounts.get(bucket) ?? [])
        });
      }
    }
  }

  // 3. Copy-trader orphan & qty skew check across managed accounts
  if (accounts.length >= 2 && byRoot.size > 0) {
    for (const [root, rootPositions] of byRoot.entries()) {
      const activeAccIds = new Set(rootPositions.map((p) => p.accountId));
      if (activeAccIds.size > 0 && activeAccIds.size < accounts.length) {
        const missing = accounts.filter((a) => !activeAccIds.has(a.id)).map((a) => a.id);
        alerts.push({
          code: 'COPIER_ORPHAN_OR_SKEW_DETECTED',
          severity: 'WARN',
          message: `Possible copy-trader desync on ${root}: active in [${Array.from(activeAccIds).join(', ')}] but missing from [${missing.join(', ')}].`,
          accounts: missing
        });
      }
      if (rootPositions.length >= 2) {
        const qtys = rootPositions.map((p) => p.qty);
        const minQ = Math.min(...qtys);
        const maxQ = Math.max(...qtys);
        if (minQ > 0 && maxQ / minQ >= 1.5) {
          alerts.push({
            code: 'COPIER_ORPHAN_OR_SKEW_DETECTED',
            severity: 'WARN',
            message: `Quantity skew on ${root}: lot sizes range from ${minQ} to ${maxQ} (>= 1.5x divergence).`,
            accounts: rootPositions.map((p) => p.accountId)
          });
        }
      }
    }
  }

  // 4. Aggregate buffer check
  let totalRemainingBufferUsd: number | null = null;
  let lowestBufferAccountId: string | null = null;
  if (accounts.length > 0) {
    let sum = 0;
    let lowest = Number.POSITIVE_INFINITY;
    for (const acc of accounts) {
      const dd = computeDrawdownState(acc);
      sum += dd.remainingBuffer;
      if (dd.remainingBuffer < lowest) {
        lowest = dd.remainingBuffer;
        lowestBufferAccountId = acc.id;
      }
      if (dd.status === 'RED_LOCKOUT') {
        alerts.push({
          code: 'AGGREGATE_BUFFER_STRESS',
          severity: 'CRITICAL',
          message: `Account ${acc.name} (${acc.id}) is in RED_LOCKOUT ($${dd.remainingBuffer} remaining buffer).`,
          accounts: [acc.id]
        });
      }
    }
    totalRemainingBufferUsd = Math.round(sum * 100) / 100;
  }

  const safeToProceed = !alerts.some((a) => a.severity === 'CRITICAL');
  return {
    safeToProceed,
    correlatedBuckets,
    totalRemainingBufferUsd,
    lowestBufferAccountId,
    alerts
  };
}
