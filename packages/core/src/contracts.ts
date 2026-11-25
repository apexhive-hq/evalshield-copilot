import type { ContractSpec, PropFirmPreset, PropPresetId } from './types.js';

export const CME_CONTRACTS: Record<string, ContractSpec> = {
  ES: {
    symbol: 'ES',
    name: 'E-mini S&P 500',
    tickSize: 0.25,
    tickValue: 12.5,
    pointValue: 50,
    defaultRoundTripCommission: 4.5,
    microCounterpart: 'MES'
  },
  MES: {
    symbol: 'MES',
    name: 'Micro E-mini S&P 500',
    tickSize: 0.25,
    tickValue: 1.25,
    pointValue: 5,
    defaultRoundTripCommission: 1.24
  },
  NQ: {
    symbol: 'NQ',
    name: 'E-mini Nasdaq-100',
    tickSize: 0.25,
    tickValue: 5.0,
    pointValue: 20,
    defaultRoundTripCommission: 4.5,
    microCounterpart: 'MNQ'
  },
  MNQ: {
    symbol: 'MNQ',
    name: 'Micro E-mini Nasdaq-100',
    tickSize: 0.25,
    tickValue: 0.5,
    pointValue: 2,
    defaultRoundTripCommission: 1.24
  },
  GC: {
    symbol: 'GC',
    name: 'Gold (100 troy oz)',
    tickSize: 0.1,
    tickValue: 10.0,
    pointValue: 100,
    defaultRoundTripCommission: 4.8,
    microCounterpart: 'MGC'
  },
  MGC: {
    symbol: 'MGC',
    name: 'Micro Gold (10 troy oz)',
    tickSize: 0.1,
    tickValue: 1.0,
    pointValue: 10,
    defaultRoundTripCommission: 1.4
  },
  CL: {
    symbol: 'CL',
    name: 'WTI Crude Oil (1,000 bbl)',
    tickSize: 0.01,
    tickValue: 10.0,
    pointValue: 1000,
    defaultRoundTripCommission: 4.8,
    microCounterpart: 'MCL'
  },
  MCL: {
    symbol: 'MCL',
    name: 'Micro WTI Crude Oil (100 bbl)',
    tickSize: 0.01,
    tickValue: 1.0,
    pointValue: 100,
    defaultRoundTripCommission: 1.4
  }
};

/**
 * Normalizes broker contract root symbols (e.g., "ES 03-26", "ESH6", "MNQZ26", "CME_MINI:MES1!")
 * back to the canonical CME root symbol.
 */
export function normalizeSymbolRoot(rawSymbol: string): string {
  const cleaned = rawSymbol.trim().toUpperCase().replace(/^.*:/, '');
  const spaceRoot = cleaned.split(/\s+/)[0] ?? cleaned;
  if (CME_CONTRACTS[spaceRoot]) {
    return spaceRoot;
  }
  const strippedMonthYear = spaceRoot.replace(/(?:[FGHJKMNQUVXZ]\d{1,2}|1!)$/, '');
  if (CME_CONTRACTS[strippedMonthYear]) {
    return strippedMonthYear;
  }
  const prefixMatch = Object.keys(CME_CONTRACTS)
    .sort((a, b) => b.length - a.length)
    .find((root) => spaceRoot.startsWith(root));
  return prefixMatch ?? spaceRoot;
}

export function getContractSpec(symbolOrRaw: string, custom?: ContractSpec): ContractSpec {
  const root = normalizeSymbolRoot(symbolOrRaw);
  const spec = CME_CONTRACTS[root] ?? custom;
  if (!spec) {
    throw new Error(`Unsupported CME contract symbol: ${symbolOrRaw}`);
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
    profitTarget: 3_000
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
    profitTarget: 9_000
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
    profitTarget: 3_000
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
    profitTarget: 3_000
  },
  mffu_50k_starter: {
    id: 'mffu_50k_starter',
    label: 'MyFundedFutures $50K Starter (EOD)',
    firm: 'MyFundedFutures',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: null,
    lockCap: 50_100,
    maxContractsCap: 5,
    consistencyCap: 0.5,
    profitTarget: 3_000
  },
  custom: {
    id: 'custom',
    label: 'Custom Prop/Funded Profile',
    firm: 'Custom',
    startingBalance: 50_000,
    drawdownMode: 'EOD_TRAILING',
    maxDrawdown: 2_000,
    dailyLossLimit: 1_000,
    lockCap: 50_000,
    maxContractsCap: 5,
    consistencyCap: 0.4,
    profitTarget: 3_000
  }
};
