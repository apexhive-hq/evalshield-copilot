export type DrawdownMode = 'INTRADAY_TRAILING' | 'EOD_TRAILING' | 'STATIC';

export type PropPresetId =
  | 'topstep_50k'
  | 'topstep_150k'
  | 'apex_50k_intraday'
  | 'apex_50k_eod'
  | 'mffu_50k_starter'
  | 'ftmo_100k_2step'
  | 'ftmo_100k_1step'
  | 'tradeify_50k_growth'
  | 'tradeify_50k_straight'
  | 'custom';

export type AssetClass = 'FUTURES' | 'FX_METAL' | 'CRYPTO_PERP' | 'CUSTOM';
export type NewsRestrictionMode = 'EXEMPT' | 'FUNDED_ONLY_BAN' | 'STRICT_ALL_ORDERS_BAN';
export type AccountStage = 'EVAL' | 'FUNDED';

export type BufferStatus = 'GREEN' | 'AMBER_CAUTION' | 'RED_LOCKOUT';
export type SessionAction = 'GO' | 'REDUCED_SIZE' | 'STAND_DOWN';

export interface ContractSpec {
  symbol: string;
  name: string;
  assetClass?: AssetClass;
  tickSize: number;
  tickValue: number;
  pointValue: number;
  defaultRoundTripCommission: number;
  microCounterpart?: string;
  makerFeeBps?: number;
  takerFeeBps?: number;
  fundingIntervalHours?: number;
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
  newsRestriction?: NewsRestrictionMode;
  newsBufferMinutes?: number;
  antiHedgingBanned?: boolean;
  rolloverResetTimeZone?: string;
  resetHourLocal?: number;
  supportsNegativePnlRule?: boolean;
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
  accountStage?: AccountStage;
  newsRestriction?: NewsRestrictionMode;
  antiHedgingBanned?: boolean;
  rolloverResetTimeZone?: string;
}

export interface RiskCheckInput {
  account: AccountRiskProfile;
  symbol: string;
  userStopTicks: number;
  atr14?: number;
  kAtr?: number;
  roundTripCommission?: number;
  slippageTicks?: number;
  spreadTicks?: number;
  notionalUsd?: number;
  isMakerOrder?: boolean;
  fundingRateHourly?: number;
  expectedHoldHours?: number;
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
  newsRestriction?: NewsRestrictionMode;
  accountStage?: AccountStage;
  assetClass?: AssetClass;
  symbol?: string;
  spreadTicks?: number;
  stopTicksEffective?: number;
}

export interface RedZoneCountdown {
  name: string;
  minutesUntil: number;
  tier: 'T-2' | 'T-5' | 'T-15' | 'IN_WINDOW';
  slTpOrderWarning: boolean;
}

export interface DstMismatchInfo {
  active: boolean;
  nyOffsetMin: number;
  berlinOffsetMin: number;
  diffHours: number;
  notice: string | null;
}

export interface SessionQualityResult {
  sessionQualityScore: number;
  sessionAction: SessionAction;
  volSizeMultiplier: number;
  cooldownRemainingSec: number;
  flags: string[];
  details: string[];
  usEuDstMismatchActive?: boolean;
  dstNotice?: string | null;
  upcomingRedZone?: RedZoneCountdown | null;
  isRolloverWindow?: boolean;
}

export interface RiskCheckResult {
  symbol: string;
  assetClass: AssetClass;
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
  spreadTicks: number;
  spreadCostUsd: number;
  spreadToStopRatio: number;
  spreadDragWarning: boolean;
  perpFeesUsd: number;
  estimatedFundingUsd: number;
  tradeRiskBudget: number;
  maxContractsAllowed: number;
  microFallbackSymbol: string | null;
  microFallbackContracts: number | null;
  totalProfit: number;
  maxDayProfit: number;
  consistencyRatio: number;
  dailyProfitSoftCap: number;
  remainingSafeAdditionalProfitUsd: number;
  requiredTotalProfitForPayout: number;
  nearConsistencyCap: boolean;
  dailyCap85Reached: boolean;
  rolloverResetNotice: string | null;
  session: SessionQualityResult;
}

export type EvalShieldTier = 'free' | 'solo' | 'team' | 'enterprise';

export interface EvalShieldLicensePayload {
  v: 1;
  product: 'evalshield-copilot';
  tier: 'solo' | 'team' | 'enterprise';
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

export interface PortfolioPositionInput {
  accountId: string;
  accountName?: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  riskUsd?: number;
  antiHedgingBanned?: boolean;
}

export interface PortfolioGuardAlert {
  code:
    | 'CROSS_ACCOUNT_ANTI_HEDGE_VIOLATION'
    | 'CORRELATED_EXPOSURE_MULTIPLIER'
    | 'COPIER_ORPHAN_OR_SKEW_DETECTED'
    | 'AGGREGATE_BUFFER_STRESS';
  severity: 'WARN' | 'CRITICAL';
  message: string;
  accounts: string[];
}

export interface PortfolioGuardResult {
  safeToProceed: boolean;
  correlatedBuckets: Record<string, { totalSignedLots: number; grossLots: number; accounts: number }>;
  totalRemainingBufferUsd: number | null;
  lowestBufferAccountId: string | null;
  alerts: PortfolioGuardAlert[];
}

export type ByoConnectorKind = 'rss' | 'polymarket_slug' | 'custom_asset' | 'webhook';

export interface ByoConnectorConfig {
  id: string;
  kind: ByoConnectorKind;
  label: string;
  target: string;
  keywords: string[];
  enabled: boolean;
  metaJson?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface PolymarketSignal {
  slug: string;
  question: string;
  yesProbabilityPct: number | null;
  oneDayChangePct: number | null;
  volume24hUsd: number | null;
  closed: boolean;
  endDate: string | null;
  expiredOrSettled: boolean;
}

export interface HyperliquidAssetCtx {
  coin: string;
  markPx: number;
  hourlyFundingRate: number;
  annualizedFundingPct: number;
  openInterest: number;
  dayNotionalVolumeUsd: number;
  extremeFundingAlert: boolean;
}

export interface RssHeadlineItem {
  source: string;
  title: string;
  link: string;
  publishedAt: string | null;
}

export interface FifteenSecondBrief {
  generatedAtUtc: string;
  dstMismatch: DstMismatchInfo;
  rolloverAdvisory: string;
  polymarket: PolymarketSignal[];
  hyperliquid: HyperliquidAssetCtx[];
  rssHighlights: RssHeadlineItem[];
  warnings: string[];
}
