import { NextResponse } from "next/server";
import { BacktestLabService, type BacktestConfig } from "@grid-bot/core";
import { RecenterMode } from "@grid-bot/core/enums";

import { readSession } from "@/lib/auth";
import { resolveExecutionCosts } from "@/lib/backtest-cost-resolution";
import {
  fetchExecutionCostCalibration,
  type BacktestExecutionCostCalibration,
  type BacktestExecutionCostResolution
} from "@/lib/backtest-execution-cost";
import { buildReplayConfig, parseBacktestCompareRequest } from "@/lib/backtest-lab";
import { buildAdaptiveRangePlan, buildStrategySelection, fetchBacktestSeries } from "@/lib/backtest-lab-server";

function decorateReplay(input: {
  service: BacktestLabService;
  series: Awaited<ReturnType<typeof fetchBacktestSeries>>["series"];
  indicators: Awaited<ReturnType<typeof fetchBacktestSeries>>["indicators"];
  marketRegime: Awaited<ReturnType<typeof fetchBacktestSeries>>["marketRegime"];
  config: BacktestConfig;
  executionCostCalibration: BacktestExecutionCostCalibration;
  executionCostResolution: BacktestExecutionCostResolution;
}) {
  const replay = input.service.replay({
    series: input.series,
    config: input.config
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
    strategySelection,
    meta: {
      ...replay.meta,
      executionCostCalibration: input.executionCostCalibration,
      executionCostResolution: input.executionCostResolution
    }
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
    const executionCostCalibration = await fetchExecutionCostCalibration({
      pair: body.pair,
      lookbackDays: body.lookbackDays
    });
    const resolvedCosts = resolveExecutionCosts(
      buildReplayConfig(body.config),
      executionCostCalibration,
      body.executionCosts.mode
    );
    const currentConfig = resolvedCosts.config;
    let recommendationBase: ReturnType<BacktestLabService["recommend"]> | null = null;
    let recommendationError: string | null = null;
    try {
      recommendationBase = service.recommend({
        series,
        budgetUsd: body.budgetUsd,
        maxDeployableUsd: body.config.maxDeployableUsd,
        reserveQuoteAmount: body.config.reserveQuoteAmount,
        entryMode: body.config.entryMode,
        rangeMethod: body.rangeMethod,
        strategyMode: body.strategyMode,
        executionCost: executionCostCalibration
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("No launch:")) {
        throw error;
      }
      recommendationError = error.message;
    }
    const currentReplay = decorateReplay({
      service,
      series,
      indicators,
      marketRegime,
      config: currentConfig,
      executionCostCalibration,
      executionCostResolution: resolvedCosts.resolution
    });
    const currentRecenterConfig = resolveExecutionCosts(buildReplayConfig({
      ...body.config,
      recenterMode: RecenterMode.Auto,
      recenterModel: "worker_flat",
      rangeControlMode: "static",
      autoRecenterMinIntervalMs: 6 * 60 * 60 * 1000,
      autoRecenterMaxPerDay: 2
    }), executionCostCalibration, body.executionCosts.mode).config;
    const currentRecenterReplay = decorateReplay({
      service,
      series,
      indicators,
      marketRegime,
      config: currentRecenterConfig,
      executionCostCalibration,
      executionCostResolution: resolvedCosts.resolution
    });

    if (!recommendationBase) {
      return NextResponse.json({
        recommendation: null,
        recommendationError,
        rows: [
          {
            id: "current_setup",
            label: "Current config — new start",
            description: "Selected bot parameters restarted from cash with no carried inventory.",
            config: currentConfig,
            replay: currentReplay
          },
          {
            id: "current_recenter",
            label: "Worker auto-center",
            description:
              "Static range with confirmed outside >=30s, no open trading lots, 6h cooldown, and at most 2 recenters/day. Above a break, sales can follow; below a break, trading inventory holds lots for exits and waits instead of relocating trapped lots.",
            config: currentRecenterConfig,
            replay: currentRecenterReplay
          }
        ],
        meta: {
          historyWindow,
          lookbackDays: body.lookbackDays,
          executionCostCalibration,
          executionCostResolution: resolvedCosts.resolution
        }
      });
    }

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
      strategySelection: bestStrategySelection,
      meta: {
        ...recommendationBase.bestReplay.meta,
        executionCostCalibration,
        executionCostResolution: resolvedCosts.resolution
      }
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
        lookbackDays: body.lookbackDays,
        executionCostCalibration,
        executionCostResolution: resolvedCosts.resolution
      }
    };
    const adaptiveConfig = resolveExecutionCosts(buildReplayConfig({
      ...recommendationBase.bestConfig,
      maxDeployableUsd: recommendationBase.bestConfig.maxDeployableUsd ?? recommendationBase.bestConfig.budgetUsd,
      reserveQuoteAmount: recommendationBase.bestConfig.reserveQuoteAmount ?? 0,
      entryMode: recommendationBase.bestConfig.entryMode ?? body.config.entryMode,
      rangeControlMode: "adaptive",
      recenterModel: "candle_defense"
    }), executionCostCalibration, body.executionCosts.mode).config;
    const adaptiveReplay = decorateReplay({
      service,
      series,
      indicators,
      marketRegime,
      config: adaptiveConfig,
      executionCostCalibration,
      executionCostResolution: resolvedCosts.resolution
    });
    const adaptiveRecenterConfig = resolveExecutionCosts(buildReplayConfig({
      ...recommendationBase.bestConfig,
      maxDeployableUsd: recommendationBase.bestConfig.maxDeployableUsd ?? recommendationBase.bestConfig.budgetUsd,
      reserveQuoteAmount: recommendationBase.bestConfig.reserveQuoteAmount ?? 0,
      entryMode: recommendationBase.bestConfig.entryMode ?? body.config.entryMode,
      recenterMode: RecenterMode.Auto,
      rangeControlMode: "adaptive",
      recenterModel: "candle_defense"
    }), executionCostCalibration, body.executionCosts.mode).config;
    const adaptiveRecenterReplay = decorateReplay({
      service,
      series,
      indicators,
      marketRegime,
      config: adaptiveRecenterConfig,
      executionCostCalibration,
      executionCostResolution: resolvedCosts.resolution
    });

    return NextResponse.json({
      recommendation,
      rows: [
        {
          id: "current_setup",
          label: "Current config — new start",
          description: "Selected bot parameters restarted from cash with no carried inventory.",
          config: currentConfig,
          replay: currentReplay
        },
        {
          id: "current_recenter",
          label: "Worker auto-center",
          description:
            "Static range with confirmed outside >=30s, no open trading lots, 6h cooldown, and at most 2 recenters/day. Above a break, sales can follow; below a break, trading inventory holds lots for exits and waits instead of relocating trapped lots.",
          config: currentRecenterConfig,
          replay: currentRecenterReplay
        },
        {
          id: "optimizer_best",
          label: "Frozen candidate holdout",
          description: "Candidate selected before the final holdout, then evaluated without reranking on it.",
          config: recommendationBase.bestConfig,
          replay: bestReplay
        },
        {
          id: "adaptive_plan",
          label: "Adaptive plan",
          description: "Experimental adaptive range with causal candle-level shifts based on observations available at each step.",
          config: adaptiveConfig,
          replay: adaptiveReplay
        },
        {
          id: "adaptive_recenter",
          label: "Adaptive + recenter (experimental)",
          description: "Experimental adaptive candle range plus legacy candle-defense recenter behavior.",
          config: adaptiveRecenterConfig,
          replay: adaptiveRecenterReplay
        }
      ],
      meta: {
        historyWindow,
        lookbackDays: body.lookbackDays,
        executionCostCalibration,
        executionCostResolution: resolvedCosts.resolution
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
