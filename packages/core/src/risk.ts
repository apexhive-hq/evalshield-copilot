import { getContractSpec, PROP_FIRM_PRESETS } from './contracts.js';
import { evaluateSessionQuality } from './session.js';
import type {
  AccountRiskProfile,
  BufferStatus,
  ContractSpec,
  RiskCheckInput,
  RiskCheckResult
} from './types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

export function computeDrawdownState(account: AccountRiskProfile): {
  effectiveHwm: number;
  floor: number;
  currentEquity: number;
  ddBuffer: number;
  dllBuffer: number | null;
  effectiveMaxBuffer: number;
  hardBreachDistance: number;
  remainingBuffer: number;
  status: BufferStatus;
} {
  assertPositiveFinite(account.startingBalance, 'startingBalance');
  assertPositiveFinite(account.maxDrawdown, 'maxDrawdown');

  const currentEquity = account.realizedBalance + account.openUnrealizedPnl;
  let effectiveHwm: number;
  if (account.drawdownMode === 'INTRADAY_TRAILING') {
    effectiveHwm = Math.max(account.hwm, currentEquity);
  } else if (account.drawdownMode === 'EOD_TRAILING') {
    effectiveHwm = account.hwm;
  } else {
    effectiveHwm = account.startingBalance;
  }

  const rawFloor = effectiveHwm - account.maxDrawdown;
  const floor =
    account.lockCap !== null && account.lockCap !== undefined
      ? Math.min(account.lockCap, rawFloor)
      : rawFloor;

  const ddBuffer = currentEquity - floor;

  const hasDll = account.dailyLossLimit !== null && account.dailyLossLimit > 0;
  const alphaSoft = account.alphaSoftDll ?? 0.8;
  const safetyReserve = account.safetyReserve ?? 0;

  const dllBuffer = hasDll
    ? (account.dailyLossLimit as number) + account.dayRealizedPnl + account.openUnrealizedPnl
    : null;

  const softDllCap = hasDll ? alphaSoft * (account.dailyLossLimit as number) : Number.POSITIVE_INFINITY;
  const softDllBuffer = hasDll
    ? softDllCap + account.dayRealizedPnl + account.openUnrealizedPnl
    : Number.POSITIVE_INFINITY;

  const effectiveMaxBuffer = Math.max(
    1,
    Math.min(account.maxDrawdown, softDllCap) - safetyReserve
  );
  const hardBreachDistance = Math.max(0, Math.min(ddBuffer, dllBuffer ?? Number.POSITIVE_INFINITY));
  const remainingBuffer = Math.max(0, Math.min(ddBuffer, softDllBuffer) - safetyReserve);

  let status: BufferStatus;
  if (hardBreachDistance <= 0 || remainingBuffer <= 0.2 * effectiveMaxBuffer) {
    status = 'RED_LOCKOUT';
  } else if (remainingBuffer <= 0.5 * effectiveMaxBuffer) {
    status = 'AMBER_CAUTION';
  } else {
    status = 'GREEN';
  }

  return {
    effectiveHwm: round2(effectiveHwm),
    floor: round2(floor),
    currentEquity: round2(currentEquity),
    ddBuffer: round2(ddBuffer),
    dllBuffer: dllBuffer === null ? null : round2(dllBuffer),
    effectiveMaxBuffer: round2(effectiveMaxBuffer),
    hardBreachDistance: round2(hardBreachDistance),
    remainingBuffer: round2(remainingBuffer),
    status
  };
}

/**
 * Updates an EOD_TRAILING account's HWM strictly from closed session balance.
 */
export function applyEodSessionRollover(
  account: AccountRiskProfile,
  closedSessionBalance: number
): AccountRiskProfile {
  const nextHwm =
    account.drawdownMode === 'STATIC'
      ? account.startingBalance
      : Math.max(account.hwm, closedSessionBalance);
  return {
    ...account,
    realizedBalance: closedSessionBalance,
    openUnrealizedPnl: 0,
    hwm: nextHwm,
    dayRealizedPnl: 0
  };
}

export function evaluateRiskCheck(
  input: RiskCheckInput,
  customSpec?: ContractSpec
): RiskCheckResult {
  const { account } = input;
  const spec = getContractSpec(input.symbol, customSpec);
  const assetClass = spec.assetClass ?? 'FUTURES';
  const preset = PROP_FIRM_PRESETS[account.presetId] ?? PROP_FIRM_PRESETS.custom;

  const userStopTicks = Math.max(0, Math.floor(input.userStopTicks));
  const atr14 = input.atr14 ?? 0;
  const kAtr = input.kAtr ?? 1.0;
  const slippageTicks = input.slippageTicks ?? 1;
  const spreadTicks = Math.max(0, input.spreadTicks ?? 0);
  const spreadCostUsd = round2(spreadTicks * spec.tickValue);

  // Crypto Perps Maker/Taker & Funding Fee Deduction
  const notionalUsd = input.notionalUsd ?? (assetClass === 'CRYPTO_PERP' ? 10_000 : 0);
  const feeBps = input.isMakerOrder ? (spec.makerFeeBps ?? 1.5) : (spec.takerFeeBps ?? 4.5);
  const perpFeesUsd =
    assetClass === 'CRYPTO_PERP' && notionalUsd > 0
      ? round2(notionalUsd * (feeBps / 10_000) * 2)
      : 0;
  const estimatedFundingUsd =
    assetClass === 'CRYPTO_PERP' && notionalUsd > 0 && input.fundingRateHourly !== undefined
      ? round2(notionalUsd * Math.abs(input.fundingRateHourly) * Math.max(0, input.expectedHoldHours ?? 8))
      : 0;

  const roundTripCommission =
    input.roundTripCommission ??
    (assetClass === 'CRYPTO_PERP' ? round2(perpFeesUsd + estimatedFundingUsd) : spec.defaultRoundTripCommission);

  const maxRiskPct = input.maxRiskPerTradePct ?? 0.2;
  const maxRiskPerTradeUsd = input.maxRiskPerTradeUsd ?? Number.POSITIVE_INFINITY;
  const runwayTrades = Math.max(1, Math.floor(input.runwayTrades ?? 4));

  if (userStopTicks <= 0 && atr14 <= 0) {
    throw new Error('Either userStopTicks > 0 or atr14 > 0 must be provided');
  }
  if (!Number.isFinite(maxRiskPct) || maxRiskPct <= 0 || maxRiskPct > 1) {
    throw new Error('maxRiskPerTradePct must be in (0, 1]');
  }

  const dd = computeDrawdownState(account);

  // Consistency calculation & safe daily profit headroom
  const dailyList = account.dailyRealizedPnls ?? [];
  const totalProfit = round2(account.realizedBalance - account.startingBalance);
  const maxDayProfit = round2(Math.max(0, ...dailyList, account.dayRealizedPnl));
  const consistencyRatio =
    totalProfit > 0 ? round2(maxDayProfit / totalProfit) : maxDayProfit > 0 ? 1 : 0;
  const hasConsistencyRule = account.consistencyCap > 0 && account.consistencyCap < 1;
  const dailyProfitSoftCap = round2(account.consistencyCap * account.profitTarget);
  const requiredTotalProfitForPayout = round2(
    Math.max(
      account.profitTarget,
      maxDayProfit > 0 && account.consistencyCap > 0 ? maxDayProfit / account.consistencyCap : account.profitTarget
    )
  );
  const remainingSafeAdditionalProfitUsd = hasConsistencyRule
    ? Math.max(0, round2(dailyProfitSoftCap - account.dayRealizedPnl))
    : Math.max(0, round2(account.profitTarget - totalProfit));
  const dailyCap85Reached =
    hasConsistencyRule && dailyProfitSoftCap > 0 && account.dayRealizedPnl >= 0.85 * dailyProfitSoftCap;
  const nearConsistencyCap = dailyCap85Reached;

  const atrTicks = atr14 > 0 ? Math.ceil((kAtr * atr14) / spec.tickSize) : 0;
  const stopTicksEffective = Math.max(userStopTicks, atrTicks, 1);
  const spreadToStopRatio = stopTicksEffective > 0 ? round2(spreadTicks / stopTicksEffective) : 0;
  const spreadDragWarning = spreadToStopRatio >= 0.25;

  const bufferPctRemaining = dd.remainingBuffer / dd.effectiveMaxBuffer;
  const session = evaluateSessionQuality({
    ...input.sessionFilter,
    atr14: input.sessionFilter?.atr14 ?? atr14,
    bufferPctRemaining,
    nearConsistencyCap,
    newsRestriction: input.sessionFilter?.newsRestriction ?? account.newsRestriction ?? preset.newsRestriction,
    accountStage: input.sessionFilter?.accountStage ?? account.accountStage ?? 'EVAL',
    assetClass,
    symbol: spec.symbol,
    spreadTicks,
    stopTicksEffective
  });

  const lossPerContract = round2(
    stopTicksEffective * spec.tickValue +
      roundTripCommission +
      slippageTicks * spec.tickValue +
      spreadCostUsd
  );

  const amberMultiplierApplied = dd.status === 'AMBER_CAUTION' ? 0.5 : 1.0;
  const combinedMultiplier = amberMultiplierApplied * session.volSizeMultiplier;

  let tradeRiskBudget = Math.min(
    maxRiskPct * dd.remainingBuffer,
    maxRiskPerTradeUsd,
    dd.remainingBuffer / runwayTrades
  );
  tradeRiskBudget = round2(Math.max(0, tradeRiskBudget * combinedMultiplier));

  let maxContractsAllowed = 0;
  if (
    dd.status !== 'RED_LOCKOUT' &&
    session.sessionAction !== 'STAND_DOWN' &&
    lossPerContract > 0
  ) {
    maxContractsAllowed = Math.min(
      account.maxContractsCap,
      Math.floor(tradeRiskBudget / lossPerContract)
    );
  }

  let microFallbackSymbol: string | null = null;
  let microFallbackContracts: number | null = null;
  if (maxContractsAllowed === 0 && spec.microCounterpart && dd.status !== 'RED_LOCKOUT' && session.sessionAction !== 'STAND_DOWN') {
    const microSpec = getContractSpec(spec.microCounterpart);
    const microLoss =
      stopTicksEffective * microSpec.tickValue +
      microSpec.defaultRoundTripCommission +
      slippageTicks * microSpec.tickValue +
      spreadTicks * microSpec.tickValue;
    const microCount = microLoss > 0 ? Math.floor(tradeRiskBudget / microLoss) : 0;
    microFallbackSymbol = microSpec.symbol;
    microFallbackContracts = Math.min(account.maxContractsCap * 10, microCount);
  }

  const resetTz = account.rolloverResetTimeZone ?? preset.rolloverResetTimeZone;
  const resetHour = preset.resetHourLocal;
  const rolloverResetNotice = resetTz
    ? `Daily drawdown resets at ${String(resetHour ?? 17).padStart(2, '0')}:00 ${resetTz}${session.usEuDstMismatchActive ? ' (DST mismatch -1h overlap shift)' : ''}.`
    : null;

  return {
    symbol: spec.symbol,
    assetClass,
    effectiveHwm: dd.effectiveHwm,
    floor: dd.floor,
    currentEquity: dd.currentEquity,
    ddBuffer: dd.ddBuffer,
    dllBuffer: dd.dllBuffer,
    hardBreachDistance: dd.hardBreachDistance,
    remainingBuffer: dd.remainingBuffer,
    status: dd.status,
    amberMultiplierApplied,
    stopTicksEffective,
    lossPerContract,
    spreadTicks,
    spreadCostUsd,
    spreadToStopRatio,
    spreadDragWarning,
    perpFeesUsd,
    estimatedFundingUsd,
    tradeRiskBudget,
    maxContractsAllowed,
    microFallbackSymbol,
    microFallbackContracts,
    totalProfit,
    maxDayProfit,
    consistencyRatio,
    dailyProfitSoftCap,
    remainingSafeAdditionalProfitUsd,
    requiredTotalProfitForPayout,
    nearConsistencyCap,
    dailyCap85Reached,
    rolloverResetNotice,
    session
  };
}
