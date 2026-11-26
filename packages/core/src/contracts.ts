import type { ContractSpec, PropFirmPreset, PropPresetId } from './types.js';

export const CME_CONTRACTS: Record<string, ContractSpec> = {
  ES: {
    symbol: 'ES',
    name: 'E-mini S&P 500',
    assetClass: 'FUTURES',
    tickSize: 0.25,
    tickValue: 12.5,
    pointValue: 50,
    defaultRoundTripCommission: 4.5,
    microCounterpart: 'MES'
  },
  MES: {
    symbol: 'MES',
    name: 'Micro E-mini S&P 500',
    assetClass: 'FUTURES',
    tickSize: 0.25,
    tickValue: 1.25,
    pointValue: 5,
    defaultRoundTripCommission: 1.24
  },
  NQ: {
    symbol: 'NQ',
    name: 'E-mini Nasdaq-100',
    assetClass: 'FUTURES',
    tickSize: 0.25,
    tickValue: 5.0,
    pointValue: 20,
    defaultRoundTripCommission: 4.5,
    microCounterpart: 'MNQ'
  },
  MNQ: {
    symbol: 'MNQ',
    name: 'Micro E-mini Nasdaq-100',
    assetClass: 'FUTURES',
    tickSize: 0.25,
    tickValue: 0.5,
    pointValue: 2,
    defaultRoundTripCommission: 1.24
  },
  GC: {
    symbol: 'GC',
    name: 'Gold (100 troy oz)',
    assetClass: 'FUTURES',
    tickSize: 0.1,
    tickValue: 10.0,
    pointValue: 100,
    defaultRoundTripCommission: 4.8,
    microCounterpart: 'MGC'
  },
  MGC: {
    symbol: 'MGC',
    name: 'Micro Gold (10 troy oz)',
    assetClass: 'FUTURES',
    tickSize: 0.1,
    tickValue: 1.0,
    pointValue: 10,
    defaultRoundTripCommission: 1.4
  },
  CL: {
    symbol: 'CL',
    name: 'WTI Crude Oil (1,000 bbl)',
    assetClass: 'FUTURES',
    tickSize: 0.01,
    tickValue: 10.0,
    pointValue: 1000,
    defaultRoundTripCommission: 4.8,
    microCounterpart: 'MCL'
  },
  MCL: {
    symbol: 'MCL',
    name: 'Micro WTI Crude Oil (100 bbl)',
    assetClass: 'FUTURES',
    tickSize: 0.01,
    tickValue: 1.0,
    pointValue: 100,
    defaultRoundTripCommission: 1.4
  }
};

export const CROSS_MARKET_CONTRACTS: Record<string, ContractSpec> = {
  XAUUSD: {
    symbol: 'XAUUSD',
    name: 'Spot Gold CFD (100 oz / FX Prop)',
    assetClass: 'FX_METAL',
    tickSize: 0.01,
    tickValue: 1.0,
    pointValue: 100,
    defaultRoundTripCommission: 7.0
  },
  EURUSD: {
    symbol: 'EURUSD',
    name: 'EUR/USD Standard FX Lot (100k)',
    assetClass: 'FX_METAL',
    tickSize: 0.0001,
    tickValue: 10.0,
    pointValue: 100_000,
    defaultRoundTripCommission: 7.0
  },
  'BTC-PERP': {
    symbol: 'BTC-PERP',
    name: 'Bitcoin Perpetual Futures (1 BTC)',
    assetClass: 'CRYPTO_PERP',
    tickSize: 1.0,
    tickValue: 1.0,
    pointValue: 1,
    defaultRoundTripCommission: 0,
    makerFeeBps: 1.5,
    takerFeeBps: 4.5,
    fundingIntervalHours: 1
  },
  'ETH-PERP': {
    symbol: 'ETH-PERP',
    name: 'Ethereum Perpetual Futures (1 ETH)',
    assetClass: 'CRYPTO_PERP',
    tickSize: 0.1,
    tickValue: 0.1,
    pointValue: 1,
    defaultRoundTripCommission: 0,
    makerFeeBps: 1.5,
    takerFeeBps: 4.5,
    fundingIntervalHours: 1
  },
  'SOL-PERP': {
    symbol: 'SOL-PERP',
    name: 'Solana Perpetual Futures (1 SOL)',
    assetClass: 'CRYPTO_PERP',
    tickSize: 0.01,
    tickValue: 0.01,
    pointValue: 1,
    defaultRoundTripCommission: 0,
    makerFeeBps: 1.5,
    takerFeeBps: 4.5,
    fundingIntervalHours: 1
  }
};

export const ALL_MARKET_CONTRACTS: Record<string, ContractSpec> = {
  ...CME_CONTRACTS,
  ...CROSS_MARKET_CONTRACTS
};

const CROSS_MARKET_ALIASES: Record<string, string> = {
  'XAU/USD': 'XAUUSD',
  GOLD: 'XAUUSD',
  'EUR/USD': 'EURUSD',
  BTCUSDT: 'BTC-PERP',
  BTCUSD: 'BTC-PERP',
  'BTC-USD': 'BTC-PERP',
  BTCPERP: 'BTC-PERP',
  'BTC-PERP': 'BTC-PERP',
  ETHUSDT: 'ETH-PERP',
  ETHUSD: 'ETH-PERP',
  'ETH-USD': 'ETH-PERP',
  ETHPERP: 'ETH-PERP',
  'ETH-PERP': 'ETH-PERP',
  SOLUSDT: 'SOL-PERP',
  SOLUSD: 'SOL-PERP',
  'SOL-USD': 'SOL-PERP',
  SOLPERP: 'SOL-PERP',
  'SOL-PERP': 'SOL-PERP'
};

/**
 * Normalizes broker contract root symbols (e.g., "ES 03-26", "ESH6", "MNQZ26",
 * "CME_MINI:MES1!", "XAU/USD", "BTCUSDT", "BTC-PERP") back to the canonical root.
 */
export function normalizeSymbolRoot(rawSymbol: string): string {
  const cleaned = rawSymbol.trim().toUpperCase().replace(/^.*:/, '');
  const spaceRoot = cleaned.split(/\s+/)[0] ?? cleaned;
  if (CROSS_MARKET_ALIASES[spaceRoot]) {
    return CROSS_MARKET_ALIASES[spaceRoot];
  }
  if (ALL_MARKET_CONTRACTS[spaceRoot]) {
    return spaceRoot;
  }
  const strippedMonthYear = spaceRoot.replace(/(?:[FGHJKMNQUVXZ]\d{1,2}|1!)$/, '');
  if (ALL_MARKET_CONTRACTS[strippedMonthYear]) {
    return strippedMonthYear;
  }
  const prefixMatch = Object.keys(CME_CONTRACTS)
    .sort((a, b) => b.length - a.length)
    .find((root) => spaceRoot.startsWith(root));
  return prefixMatch ?? spaceRoot;
}

export function getContractSpec(symbolOrRaw: string, custom?: ContractSpec): ContractSpec {
  const cleaned = symbolOrRaw.trim().toUpperCase().replace(/^.*:/, '');
  if (custom && (custom.symbol.toUpperCase() === cleaned || custom.symbol.toUpperCase() === normalizeSymbolRoot(symbolOrRaw))) {
    return custom;
  }
  const root = normalizeSymbolRoot(symbolOrRaw);
  const spec = ALL_MARKET_CONTRACTS[root] ?? custom;
  if (!spec) {
    throw new Error(`Unsupported market contract symbol: ${symbolOrRaw}`);
  }
  return spec;
}

export const PROP_FIRM_PRESETS: Record<PropPresetId, PropFirmPreset> = {
  topstep_50k: {
    id: 'topstep_50k',
    label: 'Topstep $50K Trading Combine (EOD)',
    firm: 'Topstep',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: 1_000,
    lockCap: 50_000,
    maxContractsCap: 5,
    consistencyCap: 0.5,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    rolloverResetTimeZone: 'America/Chicago',
    resetHourLocal: 17
  },
  topstep_150k: {
    id: 'topstep_150k',
    label: 'Topstep $150K Trading Combine (EOD)',
    firm: 'Topstep',
    startingBalance: 150_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 4_500,
    dailyLossLimit: 3_000,
    lockCap: 150_000,
    maxContractsCap: 15,
    consistencyCap: 0.5,
    profitTarget: 9_000,
    newsRestriction: 'EXEMPT',
    rolloverResetTimeZone: 'America/Chicago',
    resetHourLocal: 17
  },
  apex_50k_intraday: {
    id: 'apex_50k_intraday',
    label: 'Apex $50K Evaluation (Intraday Trailing)',
    firm: 'Apex Trader Funding',
    startingBalance: 50_000,
    drawdownMode: 'INTRADAY_TRAILING',
    maxDrawdown: 2_500,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 10,
    consistencyCap: 0.3,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    supportsNegativePnlRule: true,
    rolloverResetTimeZone: 'America/New_York',
    resetHourLocal: 17
  },
  apex_50k_eod: {
    id: 'apex_50k_eod',
    label: 'Apex $50K Evaluation (EOD)',
    firm: 'Apex Trader Funding',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_500,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 10,
    consistencyCap: 0.3,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    supportsNegativePnlRule: true,
    rolloverResetTimeZone: 'America/New_York',
    resetHourLocal: 17
  },
  mffu_50k_starter: {
    id: 'mffu_50k_starter',
    label: 'MyFundedFutures $50K Starter (EOD, Funded ±5m News Ban)',
    firm: 'MyFundedFutures',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 5,
    consistencyCap: 0.5,
    profitTarget: 3_000,
    newsRestriction: 'FUNDED_ONLY_BAN',
    newsBufferMinutes: 5,
    rolloverResetTimeZone: 'America/Chicago',
    resetHourLocal: 17
  },
  ftmo_100k_2step: {
    id: 'ftmo_100k_2step',
    label: 'FTMO $100K 2-Step (Static DD, Strict ±2m News & SL/TP Ban)',
    firm: 'FTMO',
    startingBalance: 100_000,
    drawdownMode: 'STATIC',
    maxDrawdown: 10_000,
    dailyLossLimit: 5_000,
    lockCap: null,
    maxContractsCap: 50,
    consistencyCap: 1.0,
    profitTarget: 10_000,
    newsRestriction: 'STRICT_ALL_ORDERS_BAN',
    newsBufferMinutes: 2,
    antiHedgingBanned: true,
    rolloverResetTimeZone: 'Europe/Berlin',
    resetHourLocal: 0
  },
  ftmo_100k_1step: {
    id: 'ftmo_100k_1step',
    label: 'FTMO $100K 1-Step (50% Consistency, Strict ±2m News Ban)',
    firm: 'FTMO',
    startingBalance: 100_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 10_000,
    dailyLossLimit: 3_000,
    lockCap: null,
    maxContractsCap: 50,
    consistencyCap: 0.5,
    profitTarget: 10_000,
    newsRestriction: 'STRICT_ALL_ORDERS_BAN',
    newsBufferMinutes: 2,
    antiHedgingBanned: true,
    rolloverResetTimeZone: 'Europe/Berlin',
    resetHourLocal: 0
  },
  tradeify_50k_growth: {
    id: 'tradeify_50k_growth',
    label: 'Tradeify $50K Growth (35% Consistency, Anti-Hedge Ban)',
    firm: 'Tradeify',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 5,
    consistencyCap: 0.35,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    antiHedgingBanned: true,
    rolloverResetTimeZone: 'America/New_York',
    resetHourLocal: 17
  },
  tradeify_50k_straight: {
    id: 'tradeify_50k_straight',
    label: 'Tradeify $50K Straight-to-Funded (20% Consistency)',
    firm: 'Tradeify',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 5,
    consistencyCap: 0.2,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    antiHedgingBanned: true,
    rolloverResetTimeZone: 'America/New_York',
    resetHourLocal: 17
  },
  custom: {
    id: 'custom',
    label: 'Custom Cross-Market / Prop Profile',
    firm: 'Custom',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: 1_000,
    lockCap: 50_000,
    maxContractsCap: 5,
    consistencyCap: 0.4,
    profitTarget: 3_000,
    newsRestriction: 'EXEMPT',
    rolloverResetTimeZone: 'America/New_York',
    resetHourLocal: 17
  }
};
