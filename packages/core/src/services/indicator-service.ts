import type { HistoricalCandle, IndicatorSnapshot, IndicatorSummary } from "../domain/types";
import { round } from "../utils/math";

const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const BOLLINGER_PERIOD = 20;
const DONCHIAN_PERIOD = 20;
const REALIZED_VOL_PERIOD = 20;
const VOLUME_PERIOD = 20;

export class IndicatorService {
  compute(candles: HistoricalCandle[]): IndicatorSummary {
    const ordered = candles
      .filter((candle) => isValidCandle(candle))
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    const ema20 = computeEma(ordered, 20);
    const ema50 = computeEma(ordered, 50);
    const ema200 = computeEma(ordered, 200);
    const atr14 = computeAtr(ordered, ATR_PERIOD);
    const adx14 = computeAdx(ordered, ADX_PERIOD);
    const bollingerWidth20 = computeBollingerWidth(ordered, BOLLINGER_PERIOD);
    const donchian = computeDonchian(ordered, DONCHIAN_PERIOD);
    const realizedVol20 = computeRealizedVol(ordered, REALIZED_VOL_PERIOD);
    const volume = computeVolumeStats(ordered, VOLUME_PERIOD);

    const series: IndicatorSnapshot[] = ordered.map((candle, index) => {
      const atr = atr14[index] ?? null;

      return {
        timestamp: candle.timestamp,
        close: round(candle.close, 8),
        ema20: ema20[index] ?? null,
        ema50: ema50[index] ?? null,
        ema200: ema200[index] ?? null,
        atr14: atr,
        atrPct14: atr !== null && candle.close > 0 ? round((atr / candle.close) * 100, 8) : null,
        adx14: adx14[index] ?? null,
        bollingerWidth20: bollingerWidth20[index] ?? null,
        donchianHigh20: donchian.high[index] ?? null,
        donchianLow20: donchian.low[index] ?? null,
        donchianWidthPct20: donchian.widthPct[index] ?? null,
        realizedVol20: realizedVol20[index] ?? null,
        volumeSma20: volume.sma[index] ?? null,
        volumeRatio20: volume.ratio[index] ?? null
      };
    });

    return {
      latest: series.at(-1) ?? null,
      series,
      hasVolume: ordered.some((candle) => typeof candle.volume === "number" && Number.isFinite(candle.volume))
    };
  }
}

function isValidCandle(candle: HistoricalCandle) {
  return (
    candle.timestamp instanceof Date &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    candle.high >= candle.low &&
    candle.close > 0
  );
}

function computeEma(candles: HistoricalCandle[], period: number) {
  const values = emptyNumberSeries(candles.length);
  if (candles.length < period) {
    return values;
  }

  const multiplier = 2 / (period + 1);
  let previousEma = average(candles.slice(0, period).map((candle) => candle.close));
  values[period - 1] = round(previousEma, 8);

  for (let index = period; index < candles.length; index += 1) {
    previousEma = (candles[index]!.close - previousEma) * multiplier + previousEma;
    values[index] = round(previousEma, 8);
  }

  return values;
}

function computeAtr(candles: HistoricalCandle[], period: number) {
  const values = emptyNumberSeries(candles.length);
  if (candles.length < period) {
    return values;
  }

  const trueRanges = computeTrueRanges(candles);
  let previousAtr = average(trueRanges.slice(0, period));
  values[period - 1] = round(previousAtr, 8);

  for (let index = period; index < candles.length; index += 1) {
    previousAtr = (previousAtr * (period - 1) + trueRanges[index]!) / period;
    values[index] = round(previousAtr, 8);
  }

  return values;
}

function computeAdx(candles: HistoricalCandle[], period: number) {
  const values = emptyNumberSeries(candles.length);
  if (candles.length < period * 2) {
    return values;
  }

  const trueRanges = computeTrueRanges(candles);
  const plusDm = Array.from({ length: candles.length }, () => 0);
  const minusDm = Array.from({ length: candles.length }, () => 0);

  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]!;
    const previous = candles[index - 1]!;
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let smoothedTr = sum(trueRanges.slice(1, period + 1));
  let smoothedPlusDm = sum(plusDm.slice(1, period + 1));
  let smoothedMinusDm = sum(minusDm.slice(1, period + 1));
  const dx = emptyNumberSeries(candles.length);

  for (let index = period; index < candles.length; index += 1) {
    if (index > period) {
      smoothedTr = smoothedTr - smoothedTr / period + trueRanges[index]!;
      smoothedPlusDm = smoothedPlusDm - smoothedPlusDm / period + plusDm[index]!;
      smoothedMinusDm = smoothedMinusDm - smoothedMinusDm / period + minusDm[index]!;
    }

    const plusDi = smoothedTr > 0 ? (smoothedPlusDm / smoothedTr) * 100 : 0;
    const minusDi = smoothedTr > 0 ? (smoothedMinusDm / smoothedTr) * 100 : 0;
    const denominator = plusDi + minusDi;
    dx[index] = denominator > 0 ? Math.abs((plusDi - minusDi) / denominator) * 100 : 0;
  }

  const firstAdxIndex = period * 2 - 1;
  let previousAdx = average(dx.slice(period, firstAdxIndex + 1).filter((value): value is number => value !== null));
  values[firstAdxIndex] = round(previousAdx, 8);

  for (let index = firstAdxIndex + 1; index < candles.length; index += 1) {
    previousAdx = (previousAdx * (period - 1) + (dx[index] ?? 0)) / period;
    values[index] = round(previousAdx, 8);
  }

  return values;
}

function computeBollingerWidth(candles: HistoricalCandle[], period: number) {
  const values = emptyNumberSeries(candles.length);

  for (let index = period - 1; index < candles.length; index += 1) {
    const closes = candles.slice(index - period + 1, index + 1).map((candle) => candle.close);
    const middle = average(closes);
    const standardDeviation = stddev(closes, middle);
    values[index] = middle > 0 ? round(((standardDeviation * 4) / middle) * 100, 8) : null;
  }

  return values;
}

function computeDonchian(candles: HistoricalCandle[], period: number) {
  const high = emptyNumberSeries(candles.length);
  const low = emptyNumberSeries(candles.length);
  const widthPct = emptyNumberSeries(candles.length);

  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    const highest = Math.max(...window.map((candle) => candle.high));
    const lowest = Math.min(...window.map((candle) => candle.low));
    high[index] = round(highest, 8);
    low[index] = round(lowest, 8);
    widthPct[index] = lowest > 0 ? round(((highest - lowest) / lowest) * 100, 8) : null;
  }

  return { high, low, widthPct };
}

function computeRealizedVol(candles: HistoricalCandle[], period: number) {
  const values = emptyNumberSeries(candles.length);
  const returns = candles.map((candle, index) => {
    const previous = candles[index - 1];
    return previous && previous.close > 0 && candle.close > 0 ? Math.log(candle.close / previous.close) : null;
  });

  for (let index = period; index < candles.length; index += 1) {
    const window = returns.slice(index - period + 1, index + 1).filter((value): value is number => value !== null);
    if (window.length < period) {
      continue;
    }

    values[index] = round(stddev(window) * 100, 8);
  }

  return values;
}

function computeVolumeStats(candles: HistoricalCandle[], period: number) {
  const sma = emptyNumberSeries(candles.length);
  const ratio = emptyNumberSeries(candles.length);

  for (let index = period - 1; index < candles.length; index += 1) {
    const volumes = candles
      .slice(index - period + 1, index + 1)
      .map((candle) => candle.volume)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (volumes.length < period) {
      continue;
    }

    const volumeAverage = average(volumes);
    const currentVolume = candles[index]!.volume;
    sma[index] = round(volumeAverage, 8);
    ratio[index] = typeof currentVolume === "number" && volumeAverage > 0 ? round(currentVolume / volumeAverage, 8) : null;
  }

  return { sma, ratio };
}

function computeTrueRanges(candles: HistoricalCandle[]) {
  return candles.map((candle, index) => {
    const previous = candles[index - 1];
    if (!previous) {
      return candle.high - candle.low;
    }

    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
  });
}

function emptyNumberSeries(length: number): Array<number | null> {
  return Array.from({ length }, () => null);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]) {
  return values.length > 0 ? sum(values) / values.length : 0;
}

function stddev(values: number[], knownAverage = average(values)) {
  if (values.length === 0) {
    return 0;
  }

  const variance = average(values.map((value) => (value - knownAverage) ** 2));
  return Math.sqrt(variance);
}
