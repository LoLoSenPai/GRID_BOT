import { NextResponse } from "next/server";
import { BacktestLabService } from "@grid-bot/core";

import { readSession } from "@/lib/auth";
import { parseBacktestRecommendRequest } from "@/lib/backtest-lab";
import { fetchBacktestSeries } from "@/lib/backtest-lab-server";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      budgetUsd: body.budgetUsd
    });

    return NextResponse.json({
      ...result,
      indicators,
      marketRegime,
      bestReplay: {
        ...result.bestReplay,
        indicators,
        marketRegime
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
