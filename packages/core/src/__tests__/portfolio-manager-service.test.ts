import { describe, expect, it, vi } from "vitest";
import { PortfolioManagerService, buildPortfolioPolicyInput } from "../services/portfolio-manager-service";
import { DEFAULT_PORTFOLIO_POLICY } from "../services/portfolio-policy-service";
import { BotMode, BotStatus, GridType, StrategyMode } from "../domain/enums";
import type { BandExecutionContext } from "../domain/portfolio-types";
import type { BotAggregate } from "../domain/types";
import type { CandleHistoryProvider } from "../domain/contracts";

const now = new Date("2026-09-21T12:00:00Z");
function setup(mode = BotMode.Paper) {
  const context = { portfolio: { id: "p", mode, autoLive: false, freeQuoteAmount: 0 },
    strategy: { id: "s", baseSymbol: "BTC", allocatedQuoteAmount: 500 }, capitalBlockedReason: null,
    exitCommitments: [], band: { id: "band", botId: "bot", status: "ACTIVE", allocatedQuoteAmount: 500,
      availableQuoteAmount: 300, reservedQuoteAmount: 0, activeRevision: { id: "r", lowPrice: 90,
        highPrice: 110, levelCount: 10, gridType: GridType.Arithmetic, createdAt: new Date(+now - 86_400_000) } } } as unknown as BandExecutionContext;
  const bot = { bot: { id: "bot", mode, status: BotStatus.Running, baseSymbol: "BTC", quoteSymbol: "USDC", strategyMode: StrategyMode.AccumulateBase },
    config: { minOrderQuoteAmount: 10 }, latestState: { currentPrice: 100, lastProcessedAt: now, metadata: { recenterHistory: [] } }, openLots: [] } as unknown as BotAggregate;
  const history: CandleHistoryProvider = { provider: "test", getHistory: vi.fn(async () => ({ meta: { stale: false },
    candles: Array.from({ length: 30 }, (_, i) => ({ openTime: new Date(+now - (30 - i) * 3_600_000),
      closeTime: new Date(+now - (29 - i) * 3_600_000), open: 100, close: 100, high: 100.1, low: 99.9 })) })) as never };
  const store = { listBandContexts: vi.fn(async () => [context]), getBot: vi.fn(async () => bot),
    getContext: vi.fn(async () => context), applyDecision: vi.fn(async () => {}), recordDecision: vi.fn(async () => {}) };
  return { context, bot, history, store, manager: new PortfolioManagerService(store, history, DEFAULT_PORTFOLIO_POLICY, buildPortfolioPolicyInput) };
}
describe("portfolio manager", () => {
  it("leaves autonomous live disabled and never restarts a closed bot", async () => {
    const live = setup(BotMode.Live); await live.manager.runCycle(now);
    expect(live.history.getHistory).not.toHaveBeenCalled();
    const stopped = setup(); stopped.bot.bot.status = BotStatus.Stopped; await stopped.manager.runCycle(now);
    expect(stopped.history.getHistory).not.toHaveBeenCalled();
  });
  it("applies a paper revision using closed history without allocating extra cash", async () => {
    const s = setup(); await s.manager.runCycle(now);
    expect(s.store.applyDecision).toHaveBeenCalledWith(s.context, s.bot, expect.objectContaining({ action: "revise" }), now);
  });
  it("defers when accounting changed concurrently instead of retrying a stale decision", async () => {
    const s = setup(); s.store.applyDecision.mockRejectedValueOnce(new Error("revision changed"));
    await s.manager.runCycle(now);
    expect(s.store.applyDecision).toHaveBeenCalledTimes(1);
    expect(s.store.recordDecision).toHaveBeenLastCalledWith("bot", expect.objectContaining({ action: "wait" }), now, false);
  });
  it("cannot adapt on a stale runtime price", async () => {
    const s = setup(); s.bot.latestState!.lastProcessedAt = new Date(+now - 300_000);
    await s.manager.runCycle(now);
    expect(s.store.applyDecision).not.toHaveBeenCalled();
  });
  it("uses the same closed price as replay once per hour and skips a persisted observation after restart", async () => {
    const s = setup(); s.bot.latestState!.currentPrice = 1000;
    await s.manager.runCycle(new Date(+now + 60_000));
    expect(s.store.applyDecision).toHaveBeenCalledWith(s.context, s.bot, expect.objectContaining({ action: "revise" }), now);
    await s.manager.runCycle(new Date(+now + 90_000));
    expect(s.store.applyDecision).toHaveBeenCalledTimes(1);
    const restarted = setup(); restarted.context.band.lastPolicyObservedAt = now;
    await restarted.manager.runCycle(new Date(+now + 60_000));
    expect(restarted.history.getHistory).not.toHaveBeenCalled();
  });
});

