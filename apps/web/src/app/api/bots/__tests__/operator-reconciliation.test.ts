import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prisma: {} as Record<string, any>, oldSnapshot: vi.fn(), parse: vi.fn() }));
vi.mock("@grid-bot/db", () => ({ prisma: mocks.prisma, findLatestBotStateSnapshot: mocks.oldSnapshot }));
vi.mock("@/lib/auth", () => ({ readSession: async () => ({ username: "test-operator" }) }));
vi.mock("@/lib/wallet-budget", () => ({ validateAdditionalBudgetAllocation: async () => ({ ok: true }) }));
vi.mock("@/lib/bot-management", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/bot-management")>(), parseUpdateBotPayload: mocks.parse,
}));
import { POST as pause } from "../[id]/pause/route";
import { POST as stop } from "../[id]/stop/route";
import { PATCH as patch } from "../[id]/route";

const now = new Date("2026-09-10T12:00:00Z");
let storedState: Record<string, any>;
let tx: Record<string, any>;
let dbBot: Record<string, any>;
const context = () => ({ params: Promise.resolve({ id: "bot-1" }) });
const request = () => new Request("http://localhost/api/bots/bot-1", { method: "POST", body: "{}" });
const decimal = (value: number) => ({ toNumber: () => value, toString: () => String(value) });

beforeEach(() => {
  storedState = { id: "post-fill", botId: "bot-1", currentPrice: 100, availableQuoteAmount: 900, availableBaseAmount: 0.995,
    deployedQuoteAmount: 100, averageEntryPrice: 100 / 0.995, realizedPnlUsd: 0, unrealizedPnlUsd: -0.5,
    totalEquityUsd: 999.5, consecutiveFailures: 0, metadata: { levelLocks: {}, recenterHistory: [], recentExecutions: [],
      externalNativeFeesQuote: 0.02, equityHighWatermarkUsd: 1001, outsideSide: "above", outsideSince: now.toISOString() } };
  dbBot = { id: "bot-1", status: "running", mode: "live", updatedAt: now, currentPrice: decimal(100), positionLots: [],
    config: { totalBudgetUsd: decimal(1000), reserveQuoteAmount: decimal(10), lowPrice: decimal(90), highPrice: decimal(110),
      levelCount: 5, gridType: "arithmetic", entryMode: "normal" } };
  tx = {
    $queryRaw: vi.fn(async () => [{ id: "bot-1" }]),
    bot: { findFirst: vi.fn(async () => dbBot), findUnique: vi.fn(async () => dbBot), update: vi.fn() },
    botConfig: { update: vi.fn() },
    botStateSnapshot: { findFirst: vi.fn(async () => storedState), create: vi.fn() },
    positionLot: { deleteMany: vi.fn(), createMany: vi.fn() },
    executionAttempt: { findUnique: vi.fn(async () => null) },
    execution: { findFirst: vi.fn(async () => null) },
    systemLog: { create: vi.fn() },
  };
  Object.assign(mocks.prisma, { bot: { findFirst: vi.fn(async () => dbBot) },
    positionLot: { findMany: vi.fn(async () => dbBot.positionLots) },
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(tx)) });
  mocks.oldSnapshot.mockReset().mockImplementation(async () => storedState);
  mocks.parse.mockReset().mockReturnValue({ name: "edited", mode: "live", totalBudgetUsd: 1000,
    lowPrice: 90, highPrice: 110, levelCount: 5, gridType: "arithmetic", entryMode: "sell_only" });
});

describe("operator actions during execution reconciliation", () => {
  it.each([["pause", pause, "paused"], ["stop", stop, "stopped"]] as const)("%s reads balances only after taking the bot row lock", async (_name, action, status) => {
    const result = await action(request(), context());
    expect(result.status).toBe(200);
    expect(mocks.oldSnapshot).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.botStateSnapshot.findFirst.mock.invocationCallOrder[0]);
    const saved = tx.botStateSnapshot.create.mock.calls[0][0].data;
    expect(saved).toMatchObject({ status, availableQuoteAmount: 900, availableBaseAmount: 0.995, totalEquityUsd: 999.5 });
    expect(saved.metadata).toMatchObject({ externalNativeFeesQuote: 0.02, equityHighWatermarkUsd: 1001 });
  });

  it("rejects config editing with an unresolved durable attempt inside the lock", async () => {
    dbBot.status = "paused";
    tx.executionAttempt.findUnique.mockResolvedValue({ botId: "bot-1" });
    const result = await patch(request(), context());
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: expect.stringContaining("reconciliation") });
    expect(tx.bot.update).not.toHaveBeenCalled();
    expect(tx.botConfig.update).not.toHaveBeenCalled();
  });

  it("rejects a legacy unresolved execution even without a durable attempt", async () => {
    dbBot.status = "paused";
    tx.execution.findFirst.mockResolvedValue({ id: "legacy" });
    expect((await patch(request(), context())).status).toBe(409);
    expect(tx.botConfig.update).not.toHaveBeenCalled();
  });

  it("rejects accounting changes between preflight and row lock instead of overwriting newer balances", async () => {
    dbBot.status = "paused";
    mocks.parse.mockReturnValue({ ...mocks.parse(), highPrice: 120 });
    tx.botStateSnapshot.findFirst.mockResolvedValue({ ...storedState, id: "newer-fill" });
    expect((await patch(request(), context())).status).toBe(409);
    expect(tx.botConfig.update).not.toHaveBeenCalled();
  });

  it("preserves retained classification, entry mode and cumulative fee/risk metadata on grid edit", async () => {
    dbBot.status = "paused";
    mocks.parse.mockReturnValue({ ...mocks.parse(), highPrice: 120 });
    dbBot.positionLots = [{ id: "retained-1", botId: "bot-1", kind: "retained", originalBaseAmount: 0.995,
      remainingBaseAmount: 0.995, costQuote: 100, entryPrice: 100 / 0.995, openedByExecutionId: "execution-1",
      closedByExecutionId: null, openedAt: now, closedAt: null }];
    const result = await patch(request(), context());
    expect(result.status).toBe(200);
    expect(tx.positionLot.createMany.mock.calls[0][0].data[0].kind).toBe("retained");
    expect(tx.botConfig.update.mock.calls[0][0].data.entryMode).toBe("sell_only");
    const metadata = tx.botStateSnapshot.create.mock.calls[0][0].data.metadata;
    expect(metadata).toMatchObject({ externalNativeFeesQuote: 0.02, equityHighWatermarkUsd: 1001, outsideSide: "above" });
    expect(metadata.gridCycles).toEqual({});
  });
});
