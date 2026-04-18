import { NextResponse } from "next/server";
import { BacktestLabService, type BacktestConfig } from "@grid-bot/core";
import { RecenterMode } from "@grid-bot/core/enums";

import { readSession } from "@/lib/auth";
import { buildReplayConfig, parseBacktestCompareRequest } from "@/lib/backtest-lab";
import { buildAdaptiveRangePlan, buildStrategySelection, fetchBacktestSeries } from "@/lib/backtest-lab-server";

function decorateReplay(input: {
  service: BacktestLabService;
  series: Awaited<ReturnType<typeof fetchBacktestSeries>>["series"];
  indicators: Awaited<ReturnType<typeof fetchBacktestSeries>>["indicators"];
  marketRegime: Awaited<ReturnType<typeof fetchBacktestSeries>>["marketRegime"];
  config: BacktestConfig;
}) {
  const replay = input.service.replay({
    series: input.series,
    config: input.config,
    marketRegime: input.marketRegime
  });
  const rangePlan = buildAdaptiveRangePlan({
    series: input.series,
    config: replay.config,
    indicators: input.indicators,
    marketRegime: input.marketRegime
  });
  const strategySelection = buildStrategySelection({
    marketRegime: input.marketRegime,
    rangePlan,
    validationMetrics: replay.validationMetrics
  });

  return {
    ...replay,
    indicators: input.indicators,
    marketRegime: input.marketRegime,
    rangePlan,
    strategySelection
  };
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.BACKTEST_LAB_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Backtest Lab is disabled on this VPS profile." },
      { status: 503 }
    );
  }

  try {
    const body = parseBacktestCompareRequest(await request.json());
    const { series, indicators, marketRegime, historyWindow } = await fetchBacktestSeries({
      pair: body.pair,
      resolution: body.resolution,
      lookbackDays: body.lookbackDays
    });
    const service = new BacktestLabService();
    const currentConfig = buildReplayConfig(body.config);
    const recommendationBase = service.recommend({
      series,
      budgetUsd: body.budgetUsd,
      marketRegime
    });
    const bestRangePlan = buildAdaptiveRangePlan({
      series,
      config: recommendationBase.bestConfig,
      indicators,
      marketRegime
    });
    const bestStrategySelection = buildStrategySelection({
      marketRegime,
      rangePlan: bestRangePlan,
      validationMetrics: recommendationBase.validationMetrics
    });
    const bestReplay = {
      ...recommendationBase.bestReplay,
      indicators,
      marketRegime,
      rangePlan: bestRangePlan,
      strategySelection: bestStrategySelection
    };
    const recommendation = {
      ...recommendationBase,
      indicators,
      marketRegime,
      rangePlan: bestRangePlan,
      strategySelection: bestStrategySelection,
      bestReplay,
      meta: {
        ...recommendationBase.meta,
        historyWindow,
        lookbackDays: body.lookbackDays
      }
    };
    const currentReplay = decorateReplay({
      service,
      series,
      indicators,
      marketRegime,
      config: currentConfig
    });
    const currentRecenterConfig = buildReplayConfig({
      ...body.config,
      recenterMode: RecenterMode.Auto
    });
    const currentRecenterReplay = decorateReplay({
      service,
      series,
      indicators,
      marketRegime,
      config: currentRecenterConfig
    });
    const adaptiveConfig = buildReplayConfig({
      ...recommendationBase.bestConfig,
      lowPrice: bestRangePlan.recommendedLowPrice,
      highPrice: bestRangePlan.recommendedHighPrice,
      levelCount: bestRangePlan.recommendedLevelCount,
      gridType: bestRangePlan.recommendedGridType,
      rangeControlMode: "adaptive"
    });
    const adaptiveReplay = decorateReplay({
      service,
      series,
      indicators,
      marketRegime,
      config: adaptiveConfig
    });

    return NextResponse.json({
      recommendation,
      rows: [
        {
          id: "current_setup",
          label: "Current setup",
          description: "Selected bot config as-is.",
          config: currentConfig,
          replay: currentReplay
        },
        {
          id: "current_recenter",
          label: "Current + recenter",
          description: "Selected setup with Lab-only recenter simulation.",
          config: currentRecenterConfig,
          replay: currentRecenterReplay
        },
        {
          id: "optimizer_best",
          label: "Optimizer best",
          description: "Best validation-ranked config from the search space.",
          config: recommendationBase.bestConfig,
          replay: bestReplay
        },
        {
          id: "adaptive_plan",
          label: "Adaptive plan",
          description: "Best config with Lab-only dynamic range shifts while flat.",
          config: adaptiveConfig,
          replay: adaptiveReplay
        }
      ],
      meta: {
        historyWindow,
        lookbackDays: body.lookbackDays
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to compare backtest scenarios."
      },
      { status: 400 }
    );
  }
}
