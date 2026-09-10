import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntryMode, GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

const mocks = vi.hoisted(() => ({
  recommend: vi.fn(),
  replay: vi.fn(),
  fetchBacktestSeries: vi.fn(),
  fetchExecutionCostCalibration: vi.fn()
}));

vi.mock("@grid-bot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@grid-bot/core")>()),
  BacktestLabService: class {
    recommend = mocks.recommend;
    replay = mocks.replay;
  }
}));
vi.mock("@/lib/auth", () => ({ readSession: async () => ({ username: "test-operator" }) }));
vi.mock("@/lib/backtest-lab-server", () => ({
  fetchBacktestSeries: mocks.fetchBacktestSeries,
  buildAdaptiveRangePlan: vi.fn(() => ({})),
  buildStrategySelection: vi.fn(() => ({}))
}));
vi.mock("@/lib/backtest-execution-cost", () => ({
  fetchExecutionCostCalibration: mocks.fetchExecutionCostCalibration
}));

import { POST } from "../route";

const baseConfig = {
  budgetUsd: 600,
  maxDeployableUsd: 480,
  reserveQuoteAmount: 120,
  entryMode: EntryMode.Normal,
  lowPrice: 90,
  highPrice: 110,
  levelCount: 8,
  gridType: GridType.Arithmetic,
  strategyMode: StrategyMode.AccumulateUsdc,
  rangeControlMode: "static" as const,
  minOrderMode: MinOrderMode.Auto,
  minOrderQuoteAmount: 60,
  maxSlippageBps: 50,
  executionFeeBps: 10,
  cooldownMs: 15_000,
  maxOrdersPerHour: 24,
  maxDrawdownPct: 18,
  maxConsecutiveFailures: 3,
  levelLockMs: 5_000,
  priceConfirmationWindowMs: 7_000,
  recenterMode: RecenterMode.Manual,
  recenterModel: "candle_defense" as const,
  autoRecenterMinIntervalMs: 21_600_000,
  autoRecenterMaxPerDay: 2,
  outOfRangePause: true
};

const metrics = {
  startingBudgetUsd: 600,
  endingEquityUsd: 600,
  totalPnlUsd: 0,
  realizedPnlUsd: 0,
  unrealizedPnlUsd: 0,
  returnPct: 0,
  maxDrawdownPct: 0,
  maxOccupancyPct: 0,
  timeInRangePct: 100,
  timeOutOfRangePct: 0,
  closedCycleCount: 0,
  openCycleCount: 0,
  executedBuyCount: 0,
  executedSellCount: 0,
  blockedOrderCount: 0,
  simulatedOrderCount: 0,
  recenterCount: 0,
  rangeAdjustmentCount: 0,
  totalFeesUsd: 0,
  averageSlippageBps: 0
};

const replayAdvice = {
  mode: "none" as const,
  side: "inside" as const,
  allowNewBuys: true,
  allowRecoverySells: true,
  suggestedLowPrice: null,
  suggestedHighPrice: null,
  risk: "low" as const,
  operatorAction: "Keep the selected range.",
  reasons: [] as string[]
};

function replayFor(config: typeof baseConfig) {
  return {
    config,
    replayPoints: [],
    executions: [],
    recenterEvents: [],
    rangeAdjustmentEvents: [],
    recenterAdvice: replayAdvice,
    trainMetrics: metrics,
    validationMetrics: metrics,
    overallMetrics: metrics,
    assumptions: {
      candleTraversal: "bullish_open_low_high_close_bearish_open_high_low_close",
      fillPolicy: "immediate_on_confirmed_level_cross",
      executionCostModel: "pessimistic_slippage_plus_fee",
      executionCostSource: "fixed_pessimistic",
      maxSlippageBps: config.maxSlippageBps,
      executionFeeBps: config.executionFeeBps,
      trainValidationSplit: 0.7,
      recenterMode: config.recenterMode,
      recenterModel: config.recenterModel,
      recenterScope: "advisory_only",
      rangeControlMode: "static",
      outOfRangeModel: "pause_new_entries_allow_recovery_sells",
      excludedCosts: [],
      notes: []
    },
    meta: { symbol: "SOL", pair: "SOL/USDC", trainEndAt: "2026-09-05T00:00:00.000Z" }
  };
}

function makeRequest() {
  return new Request("http://localhost/api/backtest/lab/compare", {
    method: "POST",
    body: JSON.stringify({
      pair: "SOL",
      budgetUsd: baseConfig.budgetUsd,
      maxDeployableUsd: baseConfig.maxDeployableUsd,
      reserveQuoteAmount: baseConfig.reserveQuoteAmount,
      entryMode: baseConfig.entryMode,
      lookbackDays: 7,
      resolution: "1h",
      config: baseConfig,
      executionCosts: { mode: "fixed" }
    })
  });
}

beforeEach(() => {
  process.env.BACKTEST_LAB_ENABLED = "true";
  mocks.recommend.mockReset();
  mocks.replay.mockReset().mockImplementation(({ config }: { config: typeof baseConfig }) => replayFor(config));
  mocks.fetchBacktestSeries.mockReset().mockResolvedValue({
    series: {
      symbol: "SOL",
      pair: "SOL/USDC",
      resolution: "1h",
      candles: [
        { timestamp: new Date("2026-09-01T00:00:00.000Z"), open: 100, high: 101, low: 99, close: 100 },
        { timestamp: new Date("2026-09-01T01:00:00.000Z"), open: 100, high: 101, low: 99, close: 100 }
      ]
    },
    indicators: {},
    marketRegime: {},
    historyWindow: {}
  });
  mocks.fetchExecutionCostCalibration.mockReset().mockResolvedValue({
    source: "fixed_pessimistic",
    maxSlippageBps: 50,
    executionFeeBps: 10,
    sampleSize: 0,
    buySampleSize: 0,
    sellSampleSize: 0,
    feeSampleSize: 0,
    calibrationStatus: "insufficient_filled_samples",
    reasons: [],
    averageAdverseSlippageBps: null,
    p50AdverseSlippageBps: null,
    p75AdverseSlippageBps: null,
    p90AdverseSlippageBps: null,
    maxAdverseSlippageBps: null,
    averageFeeBps: null,
    lookbackDays: 7
  });
});

describe("backtest compare route recenter fallback", () => {
  it("returns current and worker rows when recommendation fitting refuses", async () => {
    mocks.recommend.mockImplementation(() => {
      throw new Error("No launch: no viable range for this test.");
    });

    const response = await POST(makeRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.recommendation).toBeNull();
    expect(payload.recommendationError).toContain("No launch:");
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows.map((row: { id: string }) => row.id)).toEqual(["current_setup", "current_recenter"]);

    const autoConfig = mocks.replay.mock.calls[1]![0].config;
    expect(autoConfig).toMatchObject({
      recenterMode: RecenterMode.Auto,
      recenterModel: "worker_flat",
      rangeControlMode: "static",
      autoRecenterMinIntervalMs: 6 * 60 * 60 * 1000,
      autoRecenterMaxPerDay: 2
    });
    expect(autoConfig.priceConfirmationWindowMs).toBe(baseConfig.priceConfirmationWindowMs);
  });

  it("keeps unexpected recommendation failures as errors", async () => {
    mocks.recommend.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "database unavailable" });
    expect(mocks.replay).not.toHaveBeenCalled();
  });
});
