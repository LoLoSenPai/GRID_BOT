import { describe, expect, it } from "vitest";
import { BotMode, EntryMode, GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

import { buildBotDraftFromLabTransfer, createLabBotDraftTransfer, parseLabBotDraftTransfer } from "./lab-draft-transfer";

const config = {
  budgetUsd: 2_000,
  maxDeployableUsd: 1_400,
  reserveQuoteAmount: 500,
  entryMode: EntryMode.SellOnly,
  lowPrice: 100,
  highPrice: 150,
  levelCount: 11,
  gridType: GridType.Geometric,
  strategyMode: StrategyMode.Balanced,
  rangeControlMode: "static" as const,
  minOrderMode: MinOrderMode.Manual,
  minOrderQuoteAmount: 100,
  maxSlippageBps: 75,
  executionFeeBps: 15,
  cooldownMs: 15_000,
  maxOrdersPerHour: 48,
  maxDrawdownPct: 18,
  maxConsecutiveFailures: 3,
  levelLockMs: 20_000,
  priceConfirmationWindowMs: 2_000,
  recenterMode: RecenterMode.Auto,
  recenterModel: "worker_flat" as const,
  autoRecenterMinIntervalMs: 21_600_000,
  autoRecenterMaxPerDay: 2,
  outOfRangePause: true
};

describe("Lab bot draft transfer", () => {
  it("round-trips allocation, entry policy, and recenter policy", () => {
    const transfer = createLabBotDraftTransfer({
      pair: "SOL",
      mode: BotMode.Paper,
      label: "SOL Lab candidate",
      config
    });
    const parsed = parseLabBotDraftTransfer(JSON.stringify(transfer));
    expect(parsed).not.toBeNull();

    const result = buildBotDraftFromLabTransfer(parsed!, BotMode.Paper);
    expect(result.forcedManualRecenter).toBe(false);
    expect(result.draft).toMatchObject({
      totalBudgetUsd: 2_000,
      maxDeployableUsd: 1_400,
      reserveQuoteAmount: 500,
      entryMode: EntryMode.SellOnly,
      recenterMode: RecenterMode.Auto,
      autoRecenterMinIntervalMs: 21_600_000,
      autoRecenterMaxPerDay: 2
    });
  });

  it("forces legacy candle defense to manual when opening a bot draft", () => {
    const transfer = createLabBotDraftTransfer({
      pair: "SOL",
      mode: BotMode.Paper,
      label: "Legacy candle defense",
      config: { ...config, recenterModel: "candle_defense" }
    });

    const result = buildBotDraftFromLabTransfer(transfer, BotMode.Paper);

    expect(result.forcedManualRecenter).toBe(true);
    expect(result.draft.recenterMode).toBe(RecenterMode.Manual);
  });

  it("forces adaptive auto recenter to manual even when its model is worker flat", () => {
    const transfer = createLabBotDraftTransfer({
      pair: "SOL",
      mode: BotMode.Paper,
      label: "Adaptive experiment",
      config: { ...config, rangeControlMode: "adaptive", recenterModel: "worker_flat" }
    });

    const result = buildBotDraftFromLabTransfer(transfer, BotMode.Paper);

    expect(result.forcedManualRecenter).toBe(true);
    expect(result.draft.recenterMode).toBe(RecenterMode.Manual);
  });

  it("keeps a pre-model auto transfer on the legacy manual path", () => {
    const transfer = createLabBotDraftTransfer({
      pair: "SOL",
      mode: BotMode.Paper,
      label: "Pre-model Lab result",
      config
    });
    const { recenterModel: _removed, ...legacyConfig } = config;
    const parsed = parseLabBotDraftTransfer(JSON.stringify({ ...transfer, config: legacyConfig }));

    expect(parsed).not.toBeNull();
    const result = buildBotDraftFromLabTransfer(parsed!, BotMode.Paper);
    expect(result.forcedManualRecenter).toBe(true);
    expect(result.draft.recenterMode).toBe(RecenterMode.Manual);
  });

  it("rejects an invalid recenter model in a stored transfer", () => {
    const transfer = createLabBotDraftTransfer({
      pair: "SOL",
      mode: BotMode.Paper,
      label: "Invalid model",
      config
    });
    const raw = JSON.stringify({ ...transfer, config: { ...config, recenterModel: "future_model" } });

    expect(parseLabBotDraftTransfer(raw)).toBeNull();
  });
});
