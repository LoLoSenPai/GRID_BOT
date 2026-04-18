import { NextResponse } from "next/server";
import { BacktestLabService } from "@grid-bot/core";

import { readSession } from "@/lib/auth";
import { parseBacktestRecommendRequest } from "@/lib/backtest-lab";
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
    const body = parseBacktestRecommendRequest(await request.json());
    const { series, indicators, marketRegime, historyWindow } = await fetchBacktestSeries({
      pair: body.pair,
      resolution: body.resolution,
      lookbackDays: body.lookbackDays
    });

    const service = new BacktestLabService();
    const result = service.recommend({
      series,
      budgetUsd: body.budgetUsd,
      marketRegime
    });
    const rangePlan = buildAdaptiveRangePlan({
      series,
      config: result.bestConfig,
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
      bestReplay: {
        ...result.bestReplay,
        indicators,
        marketRegime,
        rangePlan,
        strategySelection
      },
      meta: {
        ...result.meta,
        historyWindow,
        lookbackDays: body.lookbackDays
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to run backtest recommendation."
      },
      { status: 400 }
    );
  }
}
