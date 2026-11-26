import type {
  DstMismatchInfo,
  RedZoneCountdown,
  SessionAction,
  SessionFilterInput,
  SessionQualityResult
} from './types.js';

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

function getTzLocalEpochMs(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const map = new Map(parts.map((p) => [p.type, p.value]));
  const year = Number(map.get('year') ?? '1970');
  const month = Number(map.get('month') ?? '1');
  const day = Number(map.get('day') ?? '1');
  const rawHour = Number(map.get('hour') ?? '0');
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(map.get('minute') ?? '0');
  const second = Number(map.get('second') ?? '0');
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export function getTimeZoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const localMs = getTzLocalEpochMs(utcMs, timeZone);
  return Math.round((localMs - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/**
 * Detects the ~2-3 weeks in March and late Oct/Nov when North America shifts
 * Daylight Saving Time asynchronously from Europe/London, altering FX/London/NY
 * overlap and midnight CET broker reset alignment by 1 hour.
 */
export function isUsEuDstMismatchWeek(utcMs: number): DstMismatchInfo {
  const nyOffsetMin = getTimeZoneOffsetMinutes(utcMs, 'America/New_York');
  const berlinOffsetMin = getTimeZoneOffsetMinutes(utcMs, 'Europe/Berlin');
  const diffHours = Math.round(((berlinOffsetMin - nyOffsetMin) / 60) * 10) / 10;
  const active = Math.abs(diffHours - 6) > 0.05;
  return {
    active,
    nyOffsetMin,
    berlinOffsetMin,
    diffHours,
    notice: active
      ? `US/EU DST Mismatch active (NY-to-Berlin offset is ${diffHours}h instead of 6h): verify London/NY overlap & EU midnight rollover clocks.`
      : null
  };
}

export function getNewYorkClock(utcMs: number): { weekday: string; hour: number; minute: number } {
  const parts = ET_FORMATTER.formatToParts(new Date(utcMs));
  const map = new Map(parts.map((p) => [p.type, p.value]));
  const weekday = map.get('weekday') ?? 'Mon';
  const rawHour = Number(map.get('hour') ?? '0');
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(map.get('minute') ?? '0');
  return { weekday, hour, minute };
}

/**
 * CME Globex hours: Sun 18:00 ET - Fri 17:00 ET with daily break 17:00-18:00 ET.
 */
export function isGlobexClosedUtc(utcMs: number): boolean {
  const { weekday, hour } = getNewYorkClock(utcMs);
  if (weekday === 'Sat') return true;
  if (weekday === 'Sun' && hour < 18) return true;
  if (weekday === 'Fri' && hour >= 17) return true;
  if (hour === 17) return true;
  return false;
}

export function isRolloverWideningWindowUtc(utcMs: number): boolean {
  const { weekday, hour, minute } = getNewYorkClock(utcMs);
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun' && hour < 17) return false;
  const minsSinceMidnight = hour * 60 + minute;
  return minsSinceMidnight >= 16 * 60 + 55 && minsSinceMidnight <= 18 * 60 + 5;
}

export function evaluateSessionQuality(input?: SessionFilterInput): SessionQualityResult {
  const nowUtcMs = input?.nowUtcMs ?? Date.now();
  const flags: string[] = [];
  const details: string[] = [];
  let score = 100;
  let volSizeMultiplier = 1.0;
  let forceStandDown = false;
  let cooldownRemainingSec = 0;

  const assetClass = input?.assetClass ?? 'FUTURES';
  const isRolloverWindow = isRolloverWideningWindowUtc(nowUtcMs);
  const dstInfo = isUsEuDstMismatchWeek(nowUtcMs);

  if (dstInfo.active && dstInfo.notice) {
    flags.push('US_EU_DST_MISMATCH_WEEK');
    details.push(dstInfo.notice);
  }

  if (!input?.skipGlobexCheck) {
    if (assetClass === 'CRYPTO_PERP') {
      // Crypto perpetual futures run 24/7; no CME maintenance lockout
    } else if (assetClass === 'FX_METAL') {
      const { weekday, hour } = getNewYorkClock(nowUtcMs);
      const weekendClosed =
        weekday === 'Sat' || (weekday === 'Sun' && hour < 17) || (weekday === 'Fri' && hour >= 17);
      if (weekendClosed) {
        flags.push('SESSION_CLOSED');
        details.push('FX/Spot Metal weekend close (Fri 17:00 ET - Sun 17:00 ET).');
        score -= 100;
        forceStandDown = true;
      } else if (isRolloverWindow) {
        flags.push('FX_ROLLOVER_SPREAD_WINDOW');
        details.push(
          '17:00 ET New York rollover window active: XAUUSD/FX spreads routinely widen steeply; avoid tight stops.'
        );
        score -= 20;
      }
    } else if (isGlobexClosedUtc(nowUtcMs)) {
      flags.push('SESSION_CLOSED');
      details.push('CME Globex maintenance or weekend close (17:00–18:00 ET / weekend).');
      score -= 100;
      forceStandDown = true;
    }
  }

  // Spread-to-stop R drag warning (critical for XAUUSD rollover & volatile sessions)
  if (
    input?.spreadTicks !== undefined &&
    input.spreadTicks > 0 &&
    input?.stopTicksEffective !== undefined &&
    input.stopTicksEffective > 0
  ) {
    const ratio = input.spreadTicks / input.stopTicksEffective;
    if (ratio >= 0.25) {
      flags.push('SPREAD_R_DRAG_HIGH');
      details.push(
        `Bid/Ask spread (${input.spreadTicks} ticks) consumes ${Math.round(ratio * 100)}% of stop distance (${input.stopTicksEffective} ticks).`
      );
      score -= 15;
    }
  }

  // Rule-aware economic news blackout & T-15 / T-5 / T-2 countdown sentinel
  const newsRestriction = input?.newsRestriction;
  const accountStage = input?.accountStage ?? 'EVAL';
  const newsRuleEnforced =
    newsRestriction === undefined ||
    newsRestriction === 'STRICT_ALL_ORDERS_BAN' ||
    (newsRestriction === 'FUNDED_ONLY_BAN' && accountStage === 'FUNDED');
  let upcomingRedZone: RedZoneCountdown | null = null;

  for (const ev of input?.eventWindows ?? []) {
    const defaultBuffer =
      newsRestriction === 'STRICT_ALL_ORDERS_BAN'
        ? 2
        : newsRestriction === 'FUNDED_ONLY_BAN'
          ? 5
          : 15;
    const beforeMs = (ev.bufferMinutesBefore ?? defaultBuffer) * 60_000;
    const afterMs = (ev.bufferMinutesAfter ?? defaultBuffer) * 60_000;
    const minutesUntil = Math.round(((ev.timestampUtcMs - nowUtcMs) / 60_000) * 10) / 10;

    if (nowUtcMs >= ev.timestampUtcMs - beforeMs && nowUtcMs <= ev.timestampUtcMs + afterMs) {
      upcomingRedZone = {
        name: ev.name,
        minutesUntil,
        tier: 'IN_WINDOW',
        slTpOrderWarning: newsRestriction === 'STRICT_ALL_ORDERS_BAN'
      };
      if (newsRuleEnforced) {
        flags.push('EVENT_VOLATILITY_PAUSE');
        if (newsRestriction === 'STRICT_ALL_ORDERS_BAN') {
          flags.push('STRICT_NEWS_SL_TP_BAN');
          details.push(
            `STRICT NEWS BAN (${ev.name}): FTMO/restricted rule prohibits resting SL/TP fills inside ±${ev.bufferMinutesBefore ?? defaultBuffer}m.`
          );
        } else {
          details.push(`Inside economic event buffer for ${ev.name}.`);
        }
        score -= 40;
        forceStandDown = true;
      } else {
        flags.push('NEWS_VOLATILITY_ADVISORY');
        details.push(
          `Macro event ${ev.name} live (${newsRestriction === 'FUNDED_ONLY_BAN' ? 'Eval phase exempt, Funded restricted' : 'Rule-exempt firm'}; slippage risk elevated).`
        );
        score -= 10;
      }
      break;
    }

    if (minutesUntil > 0 && minutesUntil <= 15 && upcomingRedZone === null) {
      const tier = minutesUntil <= 2 ? 'T-2' : minutesUntil <= 5 ? 'T-5' : 'T-15';
      upcomingRedZone = {
        name: ev.name,
        minutesUntil,
        tier,
        slTpOrderWarning: newsRestriction === 'STRICT_ALL_ORDERS_BAN'
      };
      flags.push(`RED_ZONE_${tier}`);
      details.push(
        `Red-zone countdown ${tier}: ${ev.name} in ${minutesUntil} min${newsRestriction === 'STRICT_ALL_ORDERS_BAN' ? ' — cancel/avoid tight resting SL/TP before ±2m window' : ''}.`
      );
      score -= tier === 'T-2' ? 20 : 10;
    }
  }

  const atr14 = input?.atr14 ?? 0;
  const atr20dMedian = input?.atr20dMedian ?? 0;
  if (atr14 > 0 && atr20dMedian > 0 && atr14 / atr20dMedian > 2.0) {
    flags.push('HIGH_VOL_REGIME');
    details.push(`ATR_14 (${atr14}) exceeds 2.0x 20-day median (${atr20dMedian}); risk budget halved.`);
    volSizeMultiplier = 0.5;
    score -= 20;
  }

  const consec = input?.consecutiveLossesToday ?? 0;
  const maxConsec = input?.maxConsecLosses ?? 3;
  const cooldownMin = input?.cooldownMinutes ?? 15;
  if (consec >= maxConsec) {
    if (input?.lastLossUtcMs) {
      const elapsedMs = nowUtcMs - input.lastLossUtcMs;
      const remainMs = cooldownMin * 60_000 - elapsedMs;
      if (remainMs > 0) {
        cooldownRemainingSec = Math.ceil(remainMs / 1000);
        flags.push('TILT_COOLDOWN_ACTIVE');
        details.push(
          `Consecutive loss threshold (${consec}/${maxConsec}) hit; ${cooldownRemainingSec}s cooldown remaining.`
        );
        forceStandDown = true;
      } else {
        flags.push('LOSS_STREAK_CAUTION');
        details.push(`Consecutive loss threshold (${consec}) reached earlier today; trade minimal size.`);
      }
    } else {
      flags.push('TILT_COOLDOWN_ACTIVE');
      details.push(`Consecutive loss threshold (${consec}/${maxConsec}) hit; stand down recommended.`);
      cooldownRemainingSec = cooldownMin * 60;
      forceStandDown = true;
    }
    score -= 25;
  }

  const trades15 = input?.tradesLast15Min ?? 0;
  const maxBurst = input?.maxBurstTrades15Min ?? 3;
  const tradesToday = input?.tradesToday ?? 0;
  const maxDaily = input?.maxDailyTrades ?? 6;
  if (trades15 >= maxBurst || tradesToday >= maxDaily) {
    flags.push('BURST_LIMIT_ADVISORY');
    details.push(
      `Activity cadence high (${trades15} trades/15m, ${tradesToday}/${maxDaily} today).`
    );
    score -= 15;
  }

  if (input?.bufferPctRemaining !== undefined && input.bufferPctRemaining < 0.35) {
    flags.push('LOW_BUFFER_STRESS');
    details.push('Remaining drawdown buffer below 35% of max drawdown.');
    score -= 30;
  }

  if (input?.nearConsistencyCap) {
    flags.push('CONSISTENCY_CAP_WARNING');
    details.push('Daily PnL exceeds 85% of consistency soft cap.');
    score -= 15;
  }

  const clampedScore = Math.max(0, Math.min(100, score));
  let sessionAction: SessionAction;
  if (forceStandDown || clampedScore < 40) {
    sessionAction = 'STAND_DOWN';
  } else if (clampedScore < 70 || volSizeMultiplier < 1.0) {
    sessionAction = 'REDUCED_SIZE';
  } else {
    sessionAction = 'GO';
  }

  return {
    sessionQualityScore: clampedScore,
    sessionAction,
    volSizeMultiplier,
    cooldownRemainingSec,
    flags,
    details,
    usEuDstMismatchActive: dstInfo.active,
    dstNotice: dstInfo.notice,
    upcomingRedZone,
    isRolloverWindow
  };
}
