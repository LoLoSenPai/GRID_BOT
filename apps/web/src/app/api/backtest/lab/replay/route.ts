import { NextResponse } from "next/server";
import { BacktestLabService } from "@grid-bot/core";

import { readSession } from "@/lib/auth";
import { applyExecutionCostCalibration, fetchExecutionCostCalibration } from "@/lib/backtest-execution-cost";
import { buildReplayConfig, parseBacktestReplayRequest } from "@/lib/backtest-lab";
import { buildAdaptiveRangePlan, buildStrategySelection, fetchBacktestSeries } from "@/lib/backtest-lab-server";

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
    const body = parseBacktestReplayRequest(await request.json());
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
    const config = applyExecutionCostCalibration(buildReplayConfig(body.config), executionCostCalibration);
    const result = service.replay({
      series,
      config,
      marketRegime
    });
    const rangePlan = buildAdaptiveRangePlan({
      series,
      config,
      indicators,
      marketRegime
    });
    const strategySelection = buildStrategySelection({
      marketRegime,
      rangePlan,
      validationMetrics: result.validationMetrics
    });

    return NextResponse.json({
      ...result,
      indicators,
      marketRegime,
      rangePlan,
      strategySelection,
      meta: {
        ...result.meta,
        historyWindow,
        lookbackDays: body.lookbackDays,
        executionCostCalibration
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to replay backtest config."
      },
      { status: 400 }
    );
  }
}
