import "server-only";

import {
  IndicatorService,
  MarketRegimeService,
  RangePlanService,
  StrategySelectionService,
  type BacktestConfig,
  type BacktestMetrics,
  type BacktestMarketSeries,
  type IndicatorSummary,
  type MarketRegimeAssessment,
  type RangePlanDecision,
  type StrategySelectionDecision
} from "@grid-bot/core";

import type { HistoryResolution } from "@/lib/charting";
import { type LabLookbackDays, type LabPair, type LabResolution } from "@/lib/backtest-lab";
import { fetchMarketHistoryLookback } from "@/lib/market-history";

type LabIndicatorSummary = Pick<IndicatorSummary, "latest" | "hasVolume">;

export function buildAdaptiveRangePlan(input: {
  series: BacktestMarketSeries;
  config: BacktestConfig;
  indicators: LabIndicatorSummary;
  marketRegime: MarketRegimeAssessment;
}): RangePlanDecision {
  const latestPrice = input.series.candles.at(-1)?.close ?? input.config.lowPrice;

  return new RangePlanService().plan({
    currentPrice: latestPrice,
    currentLowPrice: input.config.lowPrice,
    currentHighPrice: input.config.highPrice,
    currentLevelCount: input.config.levelCount,
    budgetUsd: input.config.budgetUsd,
    minOrderQuoteAmount: input.config.minOrderQuoteAmount,
    indicators: input.indicators.latest,
    marketRegime: input.marketRegime
  });
}

export function buildStrategySelection(input: {
  marketRegime: MarketRegimeAssessment;
  rangePlan: RangePlanDecision;
  validationMetrics: Pick<BacktestMetrics, "timeInRangePct" | "timeOutOfRangePct" | "maxOccupancyPct" | "maxDrawdownPct" | "closedCycleCount">;
}): StrategySelectionDecision {
  return new StrategySelectionService().select({
    marketRegime: input.marketRegime,
    rangePlan: input.rangePlan,
    validationMetrics: input.validationMetrics
  });
}

export async function fetchBacktestSeries(input: {
  pair: LabPair;
  resolution: LabResolution;
  lookbackDays: LabLookbackDays;
}): Promise<{
  series: BacktestMarketSeries;
  indicators: LabIndicatorSummary;
  marketRegime: MarketRegimeAssessment;
  historyWindow: { from: string; to: string; source: string };
}> {
  const history = await fetchMarketHistoryLookback(input.pair, input.resolution as HistoryResolution, input.lookbackDays);
  const series = {
    symbol: input.pair,
    pair: `${input.pair}/USDC`,
    resolution: input.resolution,
    candles: history.candles.map((candle) => ({
      timestamp: new Date(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume ?? null
    }))
  };

  const indicators = new IndicatorService().compute(series.candles);
  const marketRegime = new MarketRegimeService().assess(series.candles, indicators);

  return {
    series,
    indicators: {
      latest: indicators.latest,
      hasVolume: indicators.hasVolume
    },
    marketRegime,
    historyWindow: {
      from: history.meta.from,
      to: history.meta.to,
      source: history.meta.source
    }
  };
}
