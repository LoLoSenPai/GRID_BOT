import type { HistoricalCandle, IndicatorSummary, MarketRegime, MarketRegimeAssessment, MarketRegimeScores } from "../domain/types";
import { round } from "../utils/math";
import { IndicatorService } from "./indicator-service";

const TREND_ADX = 25;
const RANGE_ADX = 18;
const CHAOTIC_ATR_PCT = 2.2;
const CHAOTIC_REALIZED_VOL = 1.6;
const WIDE_BOLLINGER_PCT = 10;
const TIGHT_DONCHIAN_PCT = 10;
const TREND_SLOPE_PCT = 1.5;

export class MarketRegimeService {
  constructor(private readonly indicatorService = new IndicatorService()) {}

  assess(candles: HistoricalCandle[], indicators = this.indicatorService.compute(candles)): MarketRegimeAssessment {
    const ordered = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    const latest = indicators.latest;

    if (!latest || ordered.length < 30) {
      return {
        regime: "RANGE",
        confidence: 0.2,
        scores: { range: 1, trendUp: 0, trendDown: 0, chaoticHighVol: 0 },
        reasons: ["Not enough candles for a stable regime read; defaulting to range with low confidence."],
        evaluatedAt: ordered.at(-1)?.timestamp ?? new Date()
      };
    }

    const slopePct20 = computeCloseSlopePct(ordered, 20);
    const ema20 = latest.ema20;
    const ema50 = latest.ema50;
    const ema200 = latest.ema200;
    const adx = latest.adx14;
    const atrPct = latest.atrPct14;
    const bollingerWidth = latest.bollingerWidth20;
    const donchianWidth = latest.donchianWidthPct20;
    const realizedVol = latest.realizedVol20;
    const close = latest.close;
    const scores: MarketRegimeScores = {
      range: 0,
      trendUp: 0,
      trendDown: 0,
      chaoticHighVol: 0
    };
    const reasonBuckets: Record<MarketRegime, string[]> = {
      RANGE: [],
      TREND_UP: [],
      TREND_DOWN: [],
      CHAOTIC_HIGH_VOL: []
    };

    if (isNumber(adx)) {
      if (adx < RANGE_ADX) {
        scores.range += 2;
        reasonBuckets.RANGE.push(`ADX ${round(adx, 1)} is below ${RANGE_ADX}, trend pressure is low.`);
      }
      if (adx >= TREND_ADX) {
        scores.trendUp += 1;
        scores.trendDown += 1;
        reasonBuckets.TREND_UP.push(`ADX ${round(adx, 1)} is above ${TREND_ADX}, trend pressure is active.`);
        reasonBuckets.TREND_DOWN.push(`ADX ${round(adx, 1)} is above ${TREND_ADX}, trend pressure is active.`);
      }
    }

    if (isNumber(atrPct)) {
      if (atrPct >= CHAOTIC_ATR_PCT) {
        scores.chaoticHighVol += 2;
        reasonBuckets.CHAOTIC_HIGH_VOL.push(`ATR ${round(atrPct, 2)}% is above ${CHAOTIC_ATR_PCT}%, candle volatility is high.`);
      } else if (atrPct < 1.1) {
        scores.range += 1;
        reasonBuckets.RANGE.push(`ATR ${round(atrPct, 2)}% is contained.`);
      }
    }

    if (isNumber(realizedVol) && realizedVol >= CHAOTIC_REALIZED_VOL) {
      scores.chaoticHighVol += 1.5;
      reasonBuckets.CHAOTIC_HIGH_VOL.push(`Realized vol ${round(realizedVol, 2)}% is elevated.`);
    }

    if (isNumber(bollingerWidth)) {
      if (bollingerWidth >= WIDE_BOLLINGER_PCT) {
        scores.chaoticHighVol += 1;
        reasonBuckets.CHAOTIC_HIGH_VOL.push(`Bollinger width ${round(bollingerWidth, 2)}% is wide.`);
      } else {
        scores.range += 1;
        reasonBuckets.RANGE.push(`Bollinger width ${round(bollingerWidth, 2)}% is not stretched.`);
      }
    }

    if (isNumber(donchianWidth) && donchianWidth <= TIGHT_DONCHIAN_PCT) {
      scores.range += 1;
      reasonBuckets.RANGE.push(`Donchian width ${round(donchianWidth, 2)}% is contained.`);
    }

    if (isNumber(ema20) && isNumber(ema50)) {
      if (ema20 > ema50 && slopePct20 >= TREND_SLOPE_PCT) {
        scores.trendUp += 2;
        reasonBuckets.TREND_UP.push(`EMA20 is above EMA50 and the 20-bar slope is +${round(slopePct20, 2)}%.`);
      }
      if (ema20 < ema50 && slopePct20 <= -TREND_SLOPE_PCT) {
        scores.trendDown += 2;
        reasonBuckets.TREND_DOWN.push(`EMA20 is below EMA50 and the 20-bar slope is ${round(slopePct20, 2)}%.`);
      }
    }

    if (isNumber(ema50)) {
      if (close > ema50 && slopePct20 > 0) {
        scores.trendUp += 1;
        reasonBuckets.TREND_UP.push("Price is above EMA50 with positive slope.");
      }
      if (close < ema50 && slopePct20 < 0) {
        scores.trendDown += 1;
        reasonBuckets.TREND_DOWN.push("Price is below EMA50 with negative slope.");
      }
    }

    if (isNumber(ema50) && isNumber(ema200)) {
      if (ema50 > ema200) {
        scores.trendUp += 0.5;
      }
      if (ema50 < ema200) {
        scores.trendDown += 0.5;
      }
    }

    const regime = chooseRegime(scores);
    const confidence = computeConfidence(scores);
    const reasons = reasonBuckets[regime].slice(0, 4);

    if (reasons.length === 0) {
      reasons.push("No single condition dominated; this regime has low conviction.");
    }

    return {
      regime,
      confidence,
      scores: roundScores(scores),
      reasons,
      evaluatedAt: latest.timestamp
    };
  }
}

function chooseRegime(scores: MarketRegimeScores): MarketRegime {
  const entries: Array<[MarketRegime, number]> = [
    ["RANGE", scores.range],
    ["TREND_UP", scores.trendUp],
    ["TREND_DOWN", scores.trendDown],
    ["CHAOTIC_HIGH_VOL", scores.chaoticHighVol]
  ];
  entries.sort((left, right) => right[1] - left[1]);
  const [winner, winnerScore] = entries[0]!;
  const [, runnerUpScore] = entries[1]!;

  if (scores.chaoticHighVol >= 3 && scores.chaoticHighVol >= runnerUpScore - 0.5) {
    return "CHAOTIC_HIGH_VOL";
  }

  if (winnerScore <= 1) {
    return "RANGE";
  }

  return winner;
}

function computeConfidence(scores: MarketRegimeScores) {
  const values = [scores.range, scores.trendUp, scores.trendDown, scores.chaoticHighVol].sort((left, right) => right - left);
  const top = values[0] ?? 0;
  const second = values[1] ?? 0;
  if (top <= 0) {
    return 0.2;
  }

  return round(Math.max(0.25, Math.min(0.95, 0.35 + (top - second) / Math.max(top, 1) + top / 20)), 2);
}

function roundScores(scores: MarketRegimeScores): MarketRegimeScores {
  return {
    range: round(scores.range, 2),
    trendUp: round(scores.trendUp, 2),
    trendDown: round(scores.trendDown, 2),
    chaoticHighVol: round(scores.chaoticHighVol, 2)
  };
}

function computeCloseSlopePct(candles: HistoricalCandle[], lookback: number) {
  const last = candles.at(-1);
  const previous = candles.at(-(lookback + 1));
  if (!last || !previous || previous.close <= 0) {
    return 0;
  }

  return ((last.close - previous.close) / previous.close) * 100;
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
