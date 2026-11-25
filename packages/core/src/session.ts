import type { SessionAction, SessionFilterInput, SessionQualityResult } from './types.js';

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

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

export function evaluateSessionQuality(input?: SessionFilterInput): SessionQualityResult {
  const nowUtcMs = input?.nowUtcMs ?? Date.now();
  const flags: string[] = [];
  const details: string[] = [];
  let score = 100;
  let volSizeMultiplier = 1.0;
  let forceStandDown = false;
  let cooldownRemainingSec = 0;

  if (!input?.skipGlobexCheck && isGlobexClosedUtc(nowUtcMs)) {
    flags.push('SESSION_CLOSED');
    details.push('CME Globex maintenance or weekend close (17:00–18:00 ET / weekend).');
    score -= 100;
    forceStandDown = true;
  }

  for (const ev of input?.eventWindows ?? []) {
    const beforeMs = (ev.bufferMinutesBefore ?? 15) * 60_000;
    const afterMs = (ev.bufferMinutesAfter ?? 15) * 60_000;
    if (nowUtcMs >= ev.timestampUtcMs - beforeMs && nowUtcMs <= ev.timestampUtcMs + afterMs) {
      flags.push('EVENT_VOLATILITY_PAUSE');
      details.push(`Inside economic event buffer for ${ev.name}.`);
      score -= 40;
      forceStandDown = true;
      break;
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
    details
  };
}
