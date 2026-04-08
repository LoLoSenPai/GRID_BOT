import { describe, expect, it } from "vitest";
import { BotMode, BotStatus, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

import {
  analyzeBotDraft,
  applyBehaviorPreset,
  applyPaperTurbo,
  buildBotKeyForMode,
  cloneStateSnapshot,
  createDraftFromPreset,
  diffBotDraft,
  inferBehaviorPresetId,
} from "./bot-management";

describe("analyzeBotDraft", () => {
  it("creates drafts in the requested mode", () => {
    const draft = createDraftFromPreset("SOL_USDC", BotMode.Live);

    expect(draft.mode).toBe(BotMode.Live);
  });

  it("blocks drafts where deployable capital exceeds budget minus reserve", () => {
    const draft = createDraftFromPreset("SOL_USDC");
    draft.maxDeployableUsd = 1_800;
    draft.reserveQuoteAmount = 400;
    draft.totalBudgetUsd = 2_000;

    const analysis = analyzeBotDraft(draft, true);

    expect(analysis.canSubmit).toBe(false);
    expect(analysis.blockingIssues.some((issue) => issue.field === "maxDeployableUsd")).toBe(true);
  });

  it("flags dense grids that cannot respect the minimum order size", () => {
    const draft = createDraftFromPreset("BTC_USDC");
    draft.levelCount = 48;
    draft.maxDeployableUsd = 480;
    draft.minOrderQuoteAmount = 25;

    const analysis = analyzeBotDraft(draft, true);

    expect(analysis.canSubmit).toBe(true);
    expect(analysis.warnings.some((issue) => issue.field === "levelCount")).toBe(true);
  });

  it("blocks live drafts when the global gate is closed", () => {
    const draft = createDraftFromPreset("SOL_USDC");
    draft.mode = BotMode.Live;

    const analysis = analyzeBotDraft(draft, false);

    expect(analysis.canSubmit).toBe(false);
    expect(analysis.blockingIssues.some((issue) => issue.field === "mode")).toBe(true);
  });

  it("warns when manual recenter leaves the bot degraded out of range", () => {
    const draft = createDraftFromPreset("SOL_USDC");
    draft.recenterMode = RecenterMode.Manual;
    draft.outOfRangePause = false;

    const analysis = analyzeBotDraft(draft, true);

    expect(analysis.warnings.some((issue) => issue.field === "outOfRangePause")).toBe(true);
  });
});

describe("diffBotDraft", () => {
  it("builds stable bot keys per mode", () => {
    expect(buildBotKeyForMode("SOL / USDC Grid", BotMode.Paper)).toBe(
      "sol-usdc-grid-paper",
    );
    expect(buildBotKeyForMode("sol-usdc-grid", BotMode.Live)).toBe(
      "sol-usdc-grid-live",
    );
    expect(buildBotKeyForMode("btc-usdc-grid-live", BotMode.Live)).toBe(
      "btc-usdc-grid-live",
    );
  });

  it("returns only changed draft fields with operator-facing formatting", () => {
    const previous = createDraftFromPreset("SOL_USDC");
    const next = {
      ...previous,
      name: "SOL desk",
      mode: BotMode.Live,
      maxSlippageBps: 75
    };

    const diff = diffBotDraft(previous, next);

    expect(diff).toEqual([
      {
        field: "name",
        label: "Bot name",
        previous: "SOL / USDC Grid",
        next: "SOL desk"
      },
      {
        field: "mode",
        label: "Mode",
        previous: "paper / paper",
        next: "live / jupiter"
      },
      {
        field: "maxSlippageBps",
        label: "Max slippage",
        previous: "50 bps",
        next: "75 bps"
      }
    ]);
  });
});

describe("applyPaperTurbo", () => {
  it("tightens SOL drafts for fast paper validation around the visible spot", () => {
    const draft = createDraftFromPreset("SOL_USDC");

    const turbo = applyPaperTurbo(draft, 80);

    expect(turbo.mode).toBe(BotMode.Paper);
    expect(turbo.gridType).toBe("arithmetic");
    expect(turbo.lowPrice).toBe(76.8);
    expect(turbo.highPrice).toBe(83.2);
    expect(turbo.levelCount).toBe(18);
    expect(turbo.cooldownMs).toBe(30_000);
    expect(turbo.maxOrdersPerHour).toBe(60);
    expect(turbo.priceConfirmationWindowMs).toBe(2_000);
  });

  it("uses a narrower BTC range and integer price levels", () => {
    const draft = createDraftFromPreset("BTC_USDC");

    const turbo = applyPaperTurbo(draft, 67_000);

    expect(turbo.lowPrice).toBe(64_990);
    expect(turbo.highPrice).toBe(69_010);
    expect(turbo.levelCount).toBe(16);
    expect(turbo.gridType).toBe("arithmetic");
  });
});

describe("behavior presets", () => {
  it("applies token stacker as a deterministic low-frequency preset", () => {
    const draft = createDraftFromPreset("BTC_USDC");

    const preset = applyBehaviorPreset(draft, "token_stacker");

    expect(preset.strategyMode).toBe("accumulate_base");
    expect(preset.gridType).toBe("arithmetic");
    expect(preset.levelCount).toBe(10);
    expect(preset.cooldownMs).toBe(120_000);
    expect(preset.priceConfirmationWindowMs).toBe(5_000);
  });

  it("infers presets from the selected strategy so the UI stays explicit", () => {
    const tokenDraft = createDraftFromPreset("SOL_USDC");
    tokenDraft.strategyMode = StrategyMode.AccumulateBase;
    expect(inferBehaviorPresetId(tokenDraft)).toBe("token_stacker");

    const rangeDraft = createDraftFromPreset("BTC_USDC");
    rangeDraft.strategyMode = StrategyMode.AccumulateUsdc;
    expect(inferBehaviorPresetId(rangeDraft)).toBe("range_farmer");

    const balancedDraft = createDraftFromPreset("SOL_USDC");
    balancedDraft.strategyMode = StrategyMode.Balanced;
    expect(inferBehaviorPresetId(balancedDraft)).toBe("balanced_cycle");
  });
});

describe("cloneStateSnapshot", () => {
  it("preserves Prisma decimal-like values when cloning runtime state", () => {
    const snapshot = cloneStateSnapshot(
      "bot-1",
      BotStatus.Paused,
      {
        currentPrice: { toNumber: () => 79.12 },
        availableQuoteAmount: { toNumber: () => 2000 },
        availableBaseAmount: { toNumber: () => 0 },
        deployedQuoteAmount: { toNumber: () => 0 },
        averageEntryPrice: null,
        realizedPnlUsd: { toNumber: () => 0 },
        unrealizedPnlUsd: { toNumber: () => 0 },
        totalEquityUsd: { toNumber: () => 2000 },
        consecutiveFailures: { toNumber: () => 0 },
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          recenterHistory: [],
          recentExecutions: []
        }
      },
      {
        totalBudgetUsd: 2000,
        currentPrice: 79.12
      }
    );

    expect(snapshot.currentPrice).toBe(79.12);
    expect(snapshot.availableQuoteAmount).toBe(2000);
    expect(snapshot.totalEquityUsd).toBe(2000);
  });

  it("repairs empty runtime state snapshots with the configured budget", () => {
    const snapshot = cloneStateSnapshot(
      "bot-1",
      BotStatus.Running,
      {
        currentPrice: null,
        availableQuoteAmount: { toNumber: () => 0 },
        availableBaseAmount: { toNumber: () => 0 },
        deployedQuoteAmount: { toNumber: () => 0 },
        averageEntryPrice: null,
        realizedPnlUsd: { toNumber: () => 0 },
        unrealizedPnlUsd: { toNumber: () => 0 },
        totalEquityUsd: { toNumber: () => 0 },
        consecutiveFailures: { toNumber: () => 2 },
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          recenterHistory: [],
          recentExecutions: []
        }
      },
      {
        totalBudgetUsd: 2000,
        currentPrice: 78.9
      }
    );

    expect(snapshot.currentPrice).toBe(78.9);
    expect(snapshot.availableQuoteAmount).toBe(2000);
    expect(snapshot.totalEquityUsd).toBe(2000);
    expect(snapshot.consecutiveFailures).toBe(0);
  });
});
