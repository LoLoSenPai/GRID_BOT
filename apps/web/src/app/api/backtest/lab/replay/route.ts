import { NextResponse } from "next/server";
import { BacktestLabService } from "@grid-bot/core";

import { readSession } from "@/lib/auth";
import { buildReplayConfig, parseBacktestReplayRequest } from "@/lib/backtest-lab";
import { fetchBacktestSeries } from "@/lib/backtest-lab-server";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = parseBacktestReplayRequest(await request.json());
    const { series, indicators, historyWindow } = await fetchBacktestSeries({
      pair: body.pair,
      resolution: body.resolution,
      lookbackDays: body.lookbackDays
    });

    const service = new BacktestLabService();
    const result = service.replay({
      series,
      config: buildReplayConfig(body.config)
    });

    return NextResponse.json({
      ...result,
      indicators,
      meta: {
        ...result.meta,
        historyWindow,
        lookbackDays: body.lookbackDays
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
