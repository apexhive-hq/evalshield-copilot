export type DrawdownMode = 'INTRADAY_TRAILING' | 'EOD_TRAILING' | 'STATIC';

export type PropPresetId =
  | 'topstep_50k'
  | 'topstep_150k'
  | 'apex_50k_intraday'
  | 'apex_50k_eod'
  | 'mffu_50k_starter'
  | 'custom';

export type BufferStatus = 'GREEN' | 'AMBER_CAUTION' | 'RED_LOCKOUT';
export type SessionAction = 'GO' | 'REDUCED_SIZE' | 'STAND_DOWN';

export interface ContractSpec {
  symbol: string;
  name: string;
  tickSize: number;
  tickValue: number;
  pointValue: number;
  defaultRoundTripCommission: number;
  microCounterpart?: string;
}

export interface PropFirmPreset {
  id: PropPresetId;
  label: string;
  firm: string;
  startingBalance: number;
  drawdownMode: DrawdownMode;
  maxDrawdown: number;
  dailyLossLimit: number | null;
  lockCap: number | null;
  maxContractsCap: number;
  consistencyCap: number;
  profitTarget: number;
}

export interface AccountRiskProfile {
  id: string;
  name: string;
  presetId: PropPresetId;
  startingBalance: number;
  realizedBalance: number;
  openUnrealizedPnl: number;
  hwm: number;
  dayRealizedPnl: number;
  drawdownMode: DrawdownMode;
  maxDrawdown: number;
  dailyLossLimit: number | null;
  alphaSoftDll?: number;
  safetyReserve?: number;
  lockCap: number | null;
  maxContractsCap: number;
  consistencyCap: number;
  profitTarget: number;
  dailyRealizedPnls?: number[];
}

export interface RiskCheckInput {
  account: AccountRiskProfile;
  symbol: string;
  userStopTicks: number;
  atr14?: number;
  kAtr?: number;
  roundTripCommission?: number;
  slippageTicks?: number;
  maxRiskPerTradePct?: number;
  maxRiskPerTradeUsd?: number;
  runwayTrades?: number;
  sessionFilter?: SessionFilterInput;
}

export interface EconomicEventWindow {
  name: string;
  timestampUtcMs: number;
  bufferMinutesBefore?: number;
  bufferMinutesAfter?: number;
}

export interface SessionFilterInput {
  nowUtcMs?: number;
  atr14?: number;
  atr20dMedian?: number;
  consecutiveLossesToday?: number;
  maxConsecLosses?: number;
  lossStreakDollar?: number;
  cooldownMinutes?: number;
  lastLossUtcMs?: number | null;
  tradesLast15Min?: number;
  maxBurstTrades15Min?: number;
  tradesToday?: number;
  maxDailyTrades?: number;
  eventWindows?: EconomicEventWindow[];
  skipGlobexCheck?: boolean;
  bufferPctRemaining?: number;
  nearConsistencyCap?: boolean;
}

export interface SessionQualityResult {
  sessionQualityScore: number;
  sessionAction: SessionAction;
  volSizeMultiplier: number;
  cooldownRemainingSec: number;
  flags: string[];
  details: string[];
}

export interface RiskCheckResult {
  symbol: string;
  effectiveHwm: number;
  floor: number;
  currentEquity: number;
  ddBuffer: number;
  dllBuffer: number | null;
  hardBreachDistance: number;
  remainingBuffer: number;
  status: BufferStatus;
  amberMultiplierApplied: number;
  stopTicksEffective: number;
  lossPerContract: number;
  tradeRiskBudget: number;
  maxContractsAllowed: number;
  microFallbackSymbol: string | null;
  microFallbackContracts: number | null;
  totalProfit: number;
  maxDayProfit: number;
  consistencyRatio: number;
  dailyProfitSoftCap: number;
  requiredTotalProfitForPayout: number;
  nearConsistencyCap: boolean;
  session: SessionQualityResult;
}

export type EvalShieldTier = 'free' | 'solo' | 'team';

export interface EvalShieldLicensePayload {
  v: 1;
  product: 'evalshield-copilot';
  tier: 'solo' | 'team';
  maxAccounts: number | null;
  payer: string;
  txHash: string;
  issuedAt: number;
  expiresAt: number | null;
}

export interface LicenseVerificationResult {
  valid: boolean;
  tier: EvalShieldTier;
  maxAccounts: number | null;
  payload?: EvalShieldLicensePayload;
  reason?: string;
}
