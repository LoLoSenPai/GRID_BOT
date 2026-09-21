import { DEFAULT_PORTFOLIO_POLICY, initialPortfolioEnvelope, PortfolioPolicyReplayService,
  type HistoricalCandle, type NormalizedCandle } from "@grid-bot/core";
import { NextResponse } from "next/server";

import { readSession } from "@/lib/auth";
import { loadPortfolioHistory } from "../history";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WARMUP_CANDLES = 80;
const EVALUATION_DAYS = 14;
const COSTS = { feeBps: 10, slippageBps: 50, nativeFeeUsd: 0 } as const;

export async function POST(request: Request) {
  if (!await readSession()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const totalCapitalUsd = finiteNumber(body.totalCapitalUsd, "totalCapitalUsd");
    const baseAllocationUsd = finiteNumber(body.baseAllocationUsd, "baseAllocationUsd");
    const days = body.days === undefined ? EVALUATION_DAYS : finiteNumber(body.days, "days");
    if (days !== EVALUATION_DAYS) throw new Error("Portfolio replay uses the frozen 14-day evaluation window.");
    if (baseAllocationUsd < 100 || totalCapitalUsd < 2 * baseAllocationUsd || totalCapitalUsd > 100_000) {
      throw new Error("Replay capital must fund equal BTC and SOL base allocations of at least 100 USDC.");
    }
    const observedAt = lastClosedHour();
    const evaluationFrom = new Date(observedAt.getTime() - EVALUATION_DAYS * DAY_MS);
    const historyFrom = new Date(evaluationFrom.getTime() - (WARMUP_CANDLES + 2) * HOUR_MS);
    const [btc, sol] = await Promise.all([
      loadPortfolioHistory("BTC", historyFrom, observedAt), loadPortfolioHistory("SOL", historyFrom, observedAt),
    ]);
    if (btc.meta.stale || sol.meta.stale) throw new Error("Closed hourly history is stale; replay was deferred.");
    const prepared = {
      BTC: prepareHistory("BTC", btc.candles, evaluationFrom, observedAt),
      SOL: prepareHistory("SOL", sol.candles, evaluationFrom, observedAt),
    };
    assertSameTimeline(prepared.BTC.warmup, prepared.SOL.warmup, "warmup");
    assertSameTimeline(prepared.BTC.evaluation, prepared.SOL.evaluation, "evaluation");
    const envelopes = {
      BTC: initialPortfolioEnvelope(prepared.BTC.policyWarmup, evaluationFrom),
      SOL: initialPortfolioEnvelope(prepared.SOL.policyWarmup, evaluationFrom),
    };
    const freeCashUsd = totalCapitalUsd - 2 * baseAllocationUsd;
    const allocations = (["BTC", "SOL"] as const).map((symbol) => ({ assetSymbol: symbol,
      series: { symbol, pair: `${symbol}/USDC`, resolution: "1h", candles: prepared[symbol].evaluation },
      warmupCandles: prepared[symbol].warmup, initialBudgetUsd: baseAllocationUsd, ...envelopes[symbol],
      strategy: symbol === "BTC" ? "accumulate_base" as const : "accumulate_usdc" as const }));
    const comparison = new PortfolioPolicyReplayService().compare({ allocations, totalStartingCapitalUsd: totalCapitalUsd,
      freeCashUsd, policyParameters: DEFAULT_PORTFOLIO_POLICY, ...COSTS, minOrderQuoteUsd: 25,
      candleIntervalMs: HOUR_MS });
    return NextResponse.json({ comparison, coverage: {
      from: evaluationFrom.toISOString(), to: observedAt.toISOString(), resolution: "1h",
      warmupFrom: prepared.BTC.warmup[0]!.timestamp.toISOString(), warmupCandleCount: WARMUP_CANDLES,
    }, assumptions: [
      "Initial envelopes use only the 80 closed hourly candles preceding the evaluation window.",
      "Fixed and adaptive policies start with the same total capital, equal BTC/SOL allocations, ranges, costs, and observations.",
      "OHLC traversal is synthetic; fills and policy decisions are causal but do not claim live execution quality.",
      "Costs assume 10 bps swap fees and 50 bps slippage per leg; native SOL network fees are excluded (not estimated as zero in live trading).",
      "Results are an exploratory paper comparison, not evidence of future profit.",
    ], inputs: {
      request: { totalCapitalUsd, baseAllocationUsd, freeCashUsd, evaluationDays: EVALUATION_DAYS,
        resolution: "1h", costs: COSTS, minOrderQuoteUsd: 25, policyParameters: DEFAULT_PORTFOLIO_POLICY },
      sources: {
        BTC: replaySource(btc.meta, prepared.BTC.warmup, prepared.BTC.evaluation),
        SOL: replaySource(sol.meta, prepared.SOL.warmup, prepared.SOL.evaluation),
      },
    } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to compare portfolio policies." }, { status: 400 });
  }
}

function prepareHistory(symbol: string, candles: NormalizedCandle[], evaluationFrom: Date, observedAt: Date) {
  const closed = candles.filter((candle) => candle.closeTime && candle.closeTime <= observedAt)
    .sort((left, right) => +left.openTime - +right.openTime);
  const warmupRows = closed.filter((candle) => candle.closeTime! <= evaluationFrom).slice(-WARMUP_CANDLES);
  if (warmupRows.length !== WARMUP_CANDLES) throw new Error(`${symbol} lacks the 80 closed warmup candles.`);
  const evaluationRows = closed.filter((candle) => candle.openTime >= evaluationFrom);
  if (evaluationRows.length !== EVALUATION_DAYS * 24) throw new Error(`${symbol} lacks the complete 14-day closed hourly evaluation history.`);
  assertHourly([...warmupRows, ...evaluationRows]);
  return { warmup: warmupRows.map(toHistorical), policyWarmup: warmupRows.map((candle) => ({ openedAt: candle.openTime,
    closedAt: candle.closeTime!, open: candle.open, high: candle.high, low: candle.low, close: candle.close })),
    evaluation: evaluationRows.map(toHistorical) };
}

function assertHourly(candles: NormalizedCandle[]) {
  if (candles.some((candle, index) => !candle.closeTime || +candle.closeTime - +candle.openTime !== HOUR_MS ||
    (index > 0 && +candle.openTime - +candles[index - 1]!.openTime !== HOUR_MS))) {
    throw new Error("Closed hourly replay history is incomplete or non-contiguous.");
  }
}

function assertSameTimeline(left: HistoricalCandle[], right: HistoricalCandle[], label: string) {
  if (left.length !== right.length || left.some((candle, index) => +candle.timestamp !== +right[index]!.timestamp)) {
    throw new Error(`BTC and SOL ${label} observations do not share the same timeline.`);
  }
}

function toHistorical(candle: NormalizedCandle): HistoricalCandle {
  return { timestamp: candle.openTime, open: candle.open, high: candle.high, low: candle.low,
    close: candle.close, volume: candle.volume ?? null };
}

function replaySource(meta: { provider: string; sourceMarket?: string | null; fetchedAt: Date },
  warmup: HistoricalCandle[], evaluation: HistoricalCandle[]) {
  return { provider: meta.provider, sourceMarket: meta.sourceMarket ?? null, fetchedAt: meta.fetchedAt.toISOString(),
    warmup: serializeCandles(warmup), evaluation: serializeCandles(evaluation) };
}

function serializeCandles(candles: HistoricalCandle[]) {
  return candles.map((candle) => ({ timestamp: candle.timestamp.toISOString(), open: candle.open,
    high: candle.high, low: candle.low, close: candle.close, volume: candle.volume ?? null }));
}

function finiteNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}

function lastClosedHour() { return new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS); }
