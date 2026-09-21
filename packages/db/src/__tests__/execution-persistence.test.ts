import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BotStatus, ExecutionProvider, ExecutionStatus, OrderStatus, TradeSide, type ExecutionCommit,
  type PendingExecutionAttempt, type ExecutionReport } from "@grid-bot/core";

const mocked = vi.hoisted(() => ({ prisma: {} as Record<string, unknown>, pool: { connect: vi.fn() } }));
vi.mock("../client", () => ({ prisma: mocked.prisma, botLockPool: mocked.pool }));
import { PrismaTradeRepository } from "../repositories/trade-repository";
import { PrismaBotStateRepository } from "../repositories/bot-state-repository";

// This transactional fake validates which writes are grouped and rolled back.
// It does not claim to validate PostgreSQL isolation or run against a real database.
type Row = Record<string, any>;
type State = { bot: Row; config: Row; orders: Row[]; executions: Row[]; attempts: Row[];
  lots: Row[]; positions: Row[]; inventory: Row[]; pnl: Row[]; snapshots: Row[]; bands: Row[]; portfolios: Row[];
  strategies: Row[]; revisions: Row[]; reservations: Row[]; ledger: Row[]; commitments: Row[] };
let state: State;
let failWrite: string | undefined;
let writes: string[];
let transactionCount: number;
function makeClient(read: () => State) {
  const mutate = (name: string, action: (input: any) => unknown) => vi.fn(async (input: any) => {
    writes.push(name);
    if (failWrite === name) throw new Error(`injected ${name}`);
    return action(input);
  });
  return {
    $queryRaw: vi.fn(async () => [read().bot]),
    bot: {
      update: mutate("bot.update", ({ data }) => Object.assign(read().bot, data)),
      updateMany: mutate("bot.updateMany", ({ data }) => { Object.assign(read().bot, data); return { count: 1 }; }),
      findMany: vi.fn(async () => []),
    },
    botConfig: {
      findUniqueOrThrow: vi.fn(async () => read().config),
      update: mutate("config.update", ({ data }) => Object.assign(read().config, data)),
    },
    gridBand: {
      findUnique: vi.fn(async ({ where }) => {
        const band = read().bands.find((row) => row.botId === where.botId || row.id === where.id);
        if (!band) return null;
        const strategy = read().strategies.find((row) => row.id === band.assetStrategyId)!;
        return { ...band, assetStrategy: { ...strategy,
          portfolio: read().portfolios.find((row) => row.id === strategy.portfolioId) },
          revisions: read().revisions.filter((row) => row.bandId === band.id).sort((a, b) => b.sequence - a.sequence).slice(0, 1) };
      }),
      findFirst: vi.fn(async ({ where }) => read().bands.find((row) => row.id === where.id &&
        read().strategies.some((strategy) => strategy.id === row.assetStrategyId && strategy.portfolioId === where.assetStrategy.portfolioId)) ?? null),
      update: mutate("band.update", ({ where, data }) => applyNumericUpdate(read().bands.find((row) => row.id === where.id)!, data)),
    },
    portfolio: {
      findUniqueOrThrow: vi.fn(async ({ where }) => read().portfolios.find((row) => row.id === where.id)!),
      update: mutate("portfolio.update", ({ where, data }) => applyNumericUpdate(read().portfolios.find((row) => row.id === where.id)!, data)),
    },
    assetStrategy: {
      update: mutate("strategy.update", ({ where, data }) => applyNumericUpdate(read().strategies.find((row) => row.id === where.id)!, data)),
    },
    capitalReservation: {
      findUnique: vi.fn(async ({ where }) => decimalReservation(read().reservations.find((row) => row.id === where.id ||
        (where.portfolioId_idempotencyKey && row.portfolioId === where.portfolioId_idempotencyKey.portfolioId &&
          row.idempotencyKey === where.portfolioId_idempotencyKey.idempotencyKey)) ?? null)),
      findFirst: vi.fn(async ({ where }) => decimalReservation(read().reservations.find((row) => row.id === where.id && row.portfolioId === where.portfolioId) ?? null)),
      create: mutate("reservation.create", ({ data }) => { const row = { ...data, id: `reservation-${read().reservations.length + 1}` };
        read().reservations.push(row); return decimalReservation(row); }),
      update: mutate("reservation.update", ({ where, data }) => { const row = read().reservations.find((entry) => entry.id === where.id)!;
        Object.assign(row, data); return decimalReservation(row); }),
    },
    capitalLedgerEntry: {
      findUnique: vi.fn(async ({ where }) => read().ledger.find((row) => row.portfolioId === where.portfolioId_idempotencyKey.portfolioId &&
        row.idempotencyKey === where.portfolioId_idempotencyKey.idempotencyKey) ?? null),
      create: mutate("ledger.create", ({ data }) => { const row = { ...data, id: `ledger-${read().ledger.length + 1}` };
        read().ledger.push(row); return row; }),
    },
    lotExitCommitment: {
      findFirst: vi.fn(async ({ where }) => read().commitments.find((row) => row.bandId === where.bandId &&
        row.targetStatus === where.targetStatus && row.fulfilledAt === null) ?? null),
      findMany: vi.fn(async ({ where }) => read().commitments.filter((row) => !row.fulfilledAt &&
        read().bands.some((band) => band.id === row.bandId && band.assetStrategyId === where.band.assetStrategyId))),
      findUnique: vi.fn(async ({ where }) => read().commitments.find((row) => row.lotId === where.lotId || row.id === where.id) ?? null),
      create: mutate("commitment.create", ({ data }) => { const row = { ...data, id: `commitment-${read().commitments.length + 1}` };
        read().commitments.push(row); return row; }),
      update: mutate("commitment.update", ({ where, data }) => Object.assign(read().commitments.find((row) => row.id === where.id)!, data)),
    },
    order: {
      create: mutate("order.create", ({ data }) => { const row = { ...data, id: "order-1" }; read().orders.push(row); return row; }),
      update: mutate("order.update", ({ where, data }) => Object.assign(read().orders.find((r) => r.id === where.id)!, data)),
    },
    execution: {
      findUnique: vi.fn(async ({ where }) => read().executions.find((r) => r.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }) => read().executions.find((r) => r.botId === where.botId && !r.completedAt && where.status.in.includes(r.status)) ?? null),
      create: mutate("execution.create", ({ data }) => { const row = { ...data, id: "execution-1", completedAt: null }; read().executions.push(row); return row; }),
      update: mutate("execution.update", ({ where, data }) => Object.assign(read().executions.find((r) => r.id === where.id)!, data)),
      updateMany: mutate("execution.updateMany", ({ where, data }) => {
        const row = read().executions.find((r) => r.id === where.id && !r.completedAt);
        if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 };
      }),
    },
    executionAttempt: {
      findUnique: vi.fn(async ({ where }) => read().attempts.find((r) => r.botId === where.botId) ?? null),
      findMany: vi.fn(async () => read().attempts.map((row) => ({ payload: row.payload }))),
      create: mutate("attempt.create", ({ data }) => { const row = { result: null, uncertain: false, ...data }; read().attempts.push(row); return row; }),
      update: mutate("attempt.update", ({ where, data }) => Object.assign(read().attempts.find((r) => r.botId === where.botId)!, data)),
      delete: mutate("attempt.delete", ({ where }) => { read().attempts = read().attempts.filter((r) => r.botId !== where.botId); }),
    },
    positionLot: {
      count: vi.fn(async () => read().lots.filter((r) => r.kind === "trading" && !r.closedAt && r.remainingBaseAmount > 0).length),
      findUnique: vi.fn(async ({ where }) => read().lots.find((row) => row.id === where.id) ?? null),
      deleteMany: mutate("lots.delete", () => { read().lots = []; }),
      createMany: mutate("lots.create", ({ data }) => { read().lots.push(...data); }),
    },
    position: { upsert: mutate("position.upsert", ({ create }) => { read().positions = [create]; }) },
    inventorySnapshot: { create: mutate("inventory.create", ({ data }) => { read().inventory.push(data); }) },
    pnlSnapshot: { create: mutate("pnl.create", ({ data }) => { read().pnl.push(data); }) },
    botStateSnapshot: { findFirst: vi.fn(async () => read().snapshots.at(-1) ?? null), create: mutate("snapshot.create", ({ data }) => { read().snapshots.push(data); }) },
  };
}

function decimalReservation(row: Row | null) {
  if (!row) return null;
  return { ...row, quoteAmount: { toNumber: () => Number(row.quoteAmount), negated: () => -Number(row.quoteAmount) } };
}

function applyNumericUpdate(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && ("increment" in value || "decrement" in value)) {
      const number = (entry: unknown) => entry && typeof entry === "object" && "toNumber" in entry
        ? (entry as { toNumber(): number }).toNumber() : Number(entry ?? 0);
      row[key] = Number(row[key] ?? 0) + number((value as Row).increment) - number((value as Row).decrement);
    } else row[key] = value;
  }
  return row;
}

const now = new Date("2026-09-10T12:00:00Z");
function preparation(): Omit<PendingExecutionAttempt, "executionId" | "orderId"> {
  return { botId: "bot-1", expectedSnapshotId: null, signal: { levelIndex: 1, side: TradeSide.Buy, levelPrice: 100, observedPrice: 99,
    idempotencyKey: "signal-1", triggeredAt: now },
  orderIntent: { botId: "bot-1", orderKey: "order-key-1", side: TradeSide.Buy, levelIndex: 1, targetPrice: 100,
    requestedBaseAmount: 1, requestedQuoteAmount: 100, status: OrderStatus.Created, reason: "crossing" },
  executionParams: { botId: "bot-1", clientOrderId: "order-key-1", inputMint: "USDC", outputMint: "SOL", amount: 100,
    inputDecimals: 6, outputDecimals: 9, slippageBps: 50 },
  preparedExecution: { provider: ExecutionProvider.Jupiter, inputMint: "USDC", outputMint: "SOL", inputAmount: 100,
    expectedOutputAmount: 1, estimatedFeeAmount: 0, expectedPrice: 100, priceImpactPct: 0, requestId: "request-1",
    rawQuote: { kind: "jupiter-prepared-v1", txId: "signature-1", signedTransaction: "PRIVATE-AUTHORIZATION" } } };
}
function result(status = ExecutionStatus.Filled): ExecutionReport {
  return { provider: ExecutionProvider.Jupiter, status, executionId: "execution-1", txId: "signature-1",
    inputAmount: 100, outputAmount: 0.995, effectivePrice: 100 / 0.995, feeAmount: 0,
    rawReport: { transaction: "PRIVATE-AUTHORIZATION", nested: { signedTransaction: "PRIVATE-AUTHORIZATION" }, confirmed: true } };
}

function seedPortfolioBand(status: "ACTIVE" | "PARKED_BELOW" = "ACTIVE") {
  Object.assign(state.bot, { mode: "paper", executionProvider: "paper", baseMint: "BTC-MINT", quoteMint: "USDC" });
  state.portfolios.push({ id: "portfolio-1", mode: "paper", quoteMint: "USDC", freeQuoteAmount: 0, version: 1 });
  state.strategies.push({ id: "strategy-1", portfolioId: "portfolio-1", baseMint: "BTC-MINT",
    objective: "accumulate_base", allocatedQuoteAmount: 100, retainedBaseAmount: 0 });
  state.bands.push({ id: "band-1", botId: "bot-1", assetStrategyId: "strategy-1", status,
    allocatedQuoteAmount: 100, availableQuoteAmount: 100, reservedQuoteAmount: 0, deployedCostQuote: 0,
    realizedLossQuote: 0 });
  state.revisions.push({ id: "revision-1", bandId: "band-1", sequence: 1, lowPrice: 90, highPrice: 110,
    levelCount: 3, gridType: "arithmetic" });
  state.snapshots.push({ id: "snapshot-1", metadata: { gridRevisionId: "revision-1" } });
}

function portfolioPreparation(side = TradeSide.Buy): Omit<PendingExecutionAttempt, "executionId" | "orderId"> {
  const buy = preparation();
  if (side === TradeSide.Buy) return {
    ...buy, expectedSnapshotId: "snapshot-1", signal: { ...buy.signal, gridRevisionId: "revision-1", levelIndex: 1, levelPrice: 100 },
    orderIntent: { ...buy.orderIntent, levelIndex: 1, targetPrice: 100, requestedQuoteAmount: 40 },
    executionParams: { ...buy.executionParams, amount: 40, tradeSide: TradeSide.Buy },
    preparedExecution: { ...buy.preparedExecution!, provider: ExecutionProvider.Paper, inputAmount: 40,
      expectedOutputAmount: 0.4, estimatedFeeAmount: 0.5, expectedPrice: 100 },
  };
  return {
    ...buy, expectedSnapshotId: "snapshot-1",
    signal: { ...buy.signal, side: TradeSide.Sell, gridRevisionId: "revision-1", exitLotId: "lot-old",
      levelIndex: 1, levelPrice: 110 },
    orderIntent: { ...buy.orderIntent, side: TradeSide.Sell, levelIndex: 1, targetPrice: 110,
      requestedBaseAmount: 0.5, requestedQuoteAmount: 55, matchedLotIds: ["lot-old"] },
    executionParams: { ...buy.executionParams, inputMint: "BTC-MINT", outputMint: "USDC", amount: 0.5,
      tradeSide: TradeSide.Sell, inputDecimals: 8, outputDecimals: 6 },
    preparedExecution: { ...buy.preparedExecution!, provider: ExecutionProvider.Paper, inputMint: "BTC-MINT",
      outputMint: "USDC", inputAmount: 0.5, expectedOutputAmount: 55, estimatedFeeAmount: 1, expectedPrice: 110 },
  };
}
function commit(report = result()): ExecutionCommit {
  return { botId: "bot-1", orderId: "order-1", executionId: "execution-1", report,
    lots: [{ id: "lot-1", botId: "bot-1", kind: "retained", originalBaseAmount: 0.995, remainingBaseAmount: 0.995,
      costQuote: 100, entryPrice: 100 / 0.995, openedByExecutionId: "execution-1", closedByExecutionId: null, openedAt: now, closedAt: null }],
    position: { botId: "bot-1", baseAmount: 0.995, quoteSpent: 100, averageEntryPrice: 100 / 0.995,
      totalFeesQuote: 0, realizedPnlUsd: 0, unrealizedPnlUsd: -0.5 },
    snapshot: { botId: "bot-1", status: BotStatus.Cooldown, currentPrice: 100, availableQuoteAmount: 900,
      availableBaseAmount: 0.995, deployedQuoteAmount: 100, averageEntryPrice: 100 / 0.995, realizedPnlUsd: 0,
      unrealizedPnlUsd: -0.5, totalEquityUsd: 999.5, consecutiveFailures: 0, lastExecutionAt: now,
      lastProcessedAt: now, lastRecenterAt: null, metadata: { levelLocks: {}, recenterHistory: [], recentExecutions: [] } } };
}

beforeEach(() => {
  state = { bot: { id: "bot-1", status: BotStatus.Running, mode: "live", executionProvider: "jupiter" },
    config: { reserveQuoteAmount: 10, lowPrice: 90, highPrice: 110 }, orders: [], executions: [], attempts: [], lots: [],
    positions: [], inventory: [], pnl: [], snapshots: [], bands: [], portfolios: [], strategies: [], revisions: [],
    reservations: [], ledger: [], commitments: [] };
  failWrite = undefined; writes = []; transactionCount = 0;
  Object.assign(mocked.prisma, makeClient(() => state), {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
      transactionCount += 1;
      const draft = structuredClone(state);
      const value = await callback(makeClient(() => draft));
      state = draft;
      return value;
    }),
  });
});

describe("durable execution persistence", () => {
  it("creates order/execution/signed payload atomically and revives dates on restart", async () => {
    const repository = new PrismaTradeRepository();
    await repository.prepareExecutionAttempt(preparation());
    expect(transactionCount).toBe(1);
    expect(state.attempts[0]?.payload.preparedExecution.rawQuote.signedTransaction).toBe("PRIVATE-AUTHORIZATION");
    expect(JSON.stringify(state.executions)).not.toContain("PRIVATE-AUTHORIZATION");
    expect(state.executions[0]?.txId).toBe("signature-1");
    const restored = await new PrismaTradeRepository().getPendingExecution("bot-1");
    expect(restored?.signal.triggeredAt).toEqual(now);
    expect(restored?.signal.triggeredAt).toBeInstanceOf(Date);
  });

  it.each(["order.create", "execution.create", "attempt.create"])("rolls back preparation failure at %s", async (write) => {
    const before = structuredClone(state); failWrite = write;
    await expect(new PrismaTradeRepository().prepareExecutionAttempt(preparation())).rejects.toThrow("injected");
    expect(state).toEqual(before);
  });

  it.each([ExecutionStatus.Pending, ExecutionStatus.Submitted, ExecutionStatus.Unknown])("blocks legacy unresolved %s without signed preparation", async (status) => {
    state.executions.push({ id: "legacy", botId: "bot-1", status, completedAt: null });
    const repository = new PrismaTradeRepository();
    await expect(repository.getPendingExecution("bot-1")).rejects.toThrow("legacy");
    await expect(repository.prepareExecutionAttempt(preparation())).rejects.toThrow("legacy");
    expect(state.orders).toHaveLength(0);
  });

  it("rejects a stale or absent live state fence before creating another authorization", async () => {
    state.snapshots.push({ id: "newer-accounting" });
    const repository = new PrismaTradeRepository();
    await expect(repository.prepareExecutionAttempt(preparation())).rejects.toThrow("accounting changed");
    await expect(repository.prepareExecutionAttempt({ ...preparation(), expectedSnapshotId: undefined })).rejects.toThrow("accounting changed");
    expect(state.orders).toHaveLength(0);
  });

  it("returns the existing attempt instead of preparing a second order", async () => {
    const repository = new PrismaTradeRepository();
    const first = await repository.prepareExecutionAttempt(preparation());
    state.snapshots.push({ id: "operator-pause" });
    const second = await repository.prepareExecutionAttempt({ ...preparation(), signal: { ...preparation().signal, idempotencyKey: "other" } });
    expect(second.executionId).toBe(first.executionId);
    expect(state.orders).toHaveLength(1);
  });

  it("stores uncertainty before send with signature identity, but cannot downgrade a terminal result", async () => {
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(preparation());
    const unknown = { ...result(ExecutionStatus.Unknown), txId: null };
    await repository.saveExecutionResult(attempt, unknown, true);
    expect(state.attempts[0]).toMatchObject({ uncertain: true, result: { txId: "signature-1" } });
    expect(state.executions[0]?.completedAt).toBeNull();
    await repository.saveExecutionResult(attempt, result(), false);
    await repository.saveExecutionResult(attempt, unknown, true);
    expect(state.attempts[0]).toMatchObject({ uncertain: false, result: { status: ExecutionStatus.Filled } });
    expect(JSON.stringify(state.executions)).not.toContain("PRIVATE-AUTHORIZATION");
  });

  it.each(["execution.updateMany", "lots.delete", "lots.create", "position.upsert", "inventory.create", "pnl.create",
    "snapshot.create", "bot.update", "order.update", "attempt.delete"])("rolls back every accounting write if %s fails, then resumes once", async (write) => {
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(preparation());
    await repository.saveExecutionResult(attempt, result(), false);
    const before = structuredClone(state);
    failWrite = write;
    await expect(repository.commitExecution(commit())).rejects.toThrow("injected");
    expect(state).toEqual(before);
    failWrite = undefined;
    expect(await repository.commitExecution(commit())).toBe(true);
    expect(await repository.commitExecution(commit())).toBe(false);
    expect(state.attempts).toHaveLength(0);
    expect(state.lots[0]?.kind).toBe("retained");
    expect(state.inventory).toHaveLength(1);
    expect(state.pnl).toHaveLength(1);
    expect(state.snapshots).toHaveLength(1);
  });

  it.each([BotStatus.Paused, BotStatus.Stopped])("preserves a concurrent operator %s while finalizing accounting", async (status) => {
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(preparation());
    await repository.saveExecutionResult(attempt, result(), false);
    state.bot.status = status;
    expect(await repository.commitExecution(commit())).toBe(true);
    expect(state.bot.status).toBe(status);
    expect(state.snapshots[0]?.status).toBe(status);
  });

  it("rejects a commit of unknown or different actual amounts", async () => {
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(preparation());
    await repository.saveExecutionResult(attempt, result(), false);
    await expect(repository.commitExecution(commit(result(ExecutionStatus.Unknown)))).rejects.toThrow("terminal");
    await expect(repository.commitExecution(commit({ ...result(), outputAmount: 1 }))).rejects.toThrow("does not match");
    expect(state.executions[0]?.completedAt).toBeNull();
  });
});

describe("V2 portfolio execution persistence", () => {
  it("reserves a buy once, binds it to the execution, and creates the immutable exit on paper settlement", async () => {
    seedPortfolioBand();
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(portfolioPreparation());
    expect(state.reservations[0]).toMatchObject({ quoteAmount: 40.5, executionId: attempt.executionId, status: "RESERVED" });
    expect(state.bands[0]?.reservedQuoteAmount).toBe(40.5);
    const report: ExecutionReport = { provider: ExecutionProvider.Paper, status: ExecutionStatus.Simulated,
      executionId: attempt.executionId, txId: "signature-1", inputAmount: 40, outputAmount: 0.4, effectivePrice: 100,
      feeAmount: 0.5 };
    await repository.saveExecutionResult(attempt, report, false);
    expect(state.reservations[0]?.status).toBe("RESERVED");
    const lot = { id: `lot-${attempt.executionId}`, botId: "bot-1", kind: "trading" as const,
      originalBaseAmount: 0.4, remainingBaseAmount: 0.4, costQuote: 40.5, entryPrice: 101.25,
      openedByExecutionId: attempt.executionId, closedByExecutionId: null, openedAt: now, closedAt: null };
    const input = commit(report);
    input.executionId = attempt.executionId; input.orderId = attempt.orderId; input.lots = [lot];
    input.position = { ...input.position, baseAmount: 0.4, quoteSpent: 40.5 };
    input.snapshot = { ...input.snapshot, availableQuoteAmount: 59.5, availableBaseAmount: 0.4,
      deployedQuoteAmount: 40.5, totalEquityUsd: 99.5 };
    expect(await repository.commitExecution(input)).toBe(true);
    expect(state.reservations[0]?.status).toBe("SETTLED");
    expect(state.bands[0]).toMatchObject({ availableQuoteAmount: 59.5, reservedQuoteAmount: 0, deployedCostQuote: 40.5 });
    expect(state.commitments[0]).toMatchObject({ lotId: lot.id, originRevisionId: "revision-1",
      buyTargetPrice: 100, sellTargetPrice: 110, economicRule: "accumulate_base" });
    expect(state.orders[0]?.status).toBe("simulated");
  });

  it("blocks stale, parked, unresolved-target and duplicate-zone entries under the transaction locks", async () => {
    seedPortfolioBand();
    const repository = new PrismaTradeRepository();
    await expect(repository.prepareExecutionAttempt({ ...portfolioPreparation(), signal: {
      ...portfolioPreparation().signal, gridRevisionId: "stale" } })).rejects.toThrow(/revision changed/);
    state.bands[0]!.status = "PARKED_BELOW";
    await expect(repository.prepareExecutionAttempt(portfolioPreparation())).rejects.toThrow(/active grid band/);
    state.bands[0]!.status = "ACTIVE";
    state.commitments.push({ id: "unknown-target", bandId: "band-1", lotId: "lot-unknown", targetStatus: "UNKNOWN",
      buyTargetPrice: null, sellTargetPrice: null, fulfilledAt: null });
    await expect(repository.prepareExecutionAttempt(portfolioPreparation())).rejects.toThrow(/known exit target/);
    state.commitments = [{ id: "occupied", bandId: "band-1", lotId: "lot-occupied", targetStatus: "KNOWN",
      buyTargetPrice: 99, sellTargetPrice: 109, fulfilledAt: null }];
    await expect(repository.prepareExecutionAttempt(portfolioPreparation())).rejects.toThrow(/already occupies/);
    state.commitments = [];
    state.reservations.push({ id: "reservation-other", portfolioId: "portfolio-1", bandId: "band-other",
      quoteAmount: 40, status: "RESERVED", executionId: "execution-other" });
    state.attempts.push({ botId: "bot-other", payload: { signal: { side: TradeSide.Buy }, portfolioContext: {
      reservationId: "reservation-other", buyTargetPrice: 99, sellTargetPrice: 109 } } });
    await expect(repository.prepareExecutionAttempt(portfolioPreparation())).rejects.toThrow(/pending buy/);
    expect(state.orders).toHaveLength(0);
  });

  it("keeps uncertain buy capital reserved and later releases it after a terminal failure", async () => {
    seedPortfolioBand();
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(portfolioPreparation());
    const unknown: ExecutionReport = { provider: ExecutionProvider.Paper, status: ExecutionStatus.Unknown,
      executionId: attempt.executionId, txId: null, inputAmount: 0, outputAmount: 0, effectivePrice: 100, feeAmount: 0 };
    await repository.saveExecutionResult(attempt, unknown, true);
    expect(state.reservations[0]).toMatchObject({ status: "UNKNOWN", quoteAmount: 40.5 });
    expect(state.bands[0]?.reservedQuoteAmount).toBe(40.5);
    const failed = { ...unknown, status: ExecutionStatus.Failed, txId: "signature-1" };
    await repository.saveExecutionResult(attempt, failed, false);
    const input = commit(failed); input.executionId = attempt.executionId; input.orderId = attempt.orderId;
    expect(await repository.commitExecution(input)).toBe(true);
    expect(state.reservations[0]?.status).toBe("RELEASED");
    expect(state.bands[0]?.reservedQuoteAmount).toBe(0);
  });

  it("settles a partial sell from prepared lot cost and removes swept profit from the bot snapshot", async () => {
    seedPortfolioBand();
    state.bands[0]!.availableQuoteAmount = 0; state.bands[0]!.deployedCostQuote = 100;
    state.lots.push({ id: "lot-old", botId: "bot-1", kind: "trading", remainingBaseAmount: 1, costQuote: 100,
      originalBaseAmount: 1, entryPrice: 100, openedByExecutionId: "buy-old", closedAt: null });
    state.commitments.push({ id: "commitment-old", bandId: "band-1", lotId: "lot-old", targetStatus: "KNOWN",
      buyLevelIndex: 0, sellLevelIndex: 1, buyTargetPrice: 100, sellTargetPrice: 110,
      economicRule: "accumulate_base", originRevisionId: "revision-1", maxAdverseDriftBps: 50, fulfilledAt: null });
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(portfolioPreparation(TradeSide.Sell));
    const report: ExecutionReport = { provider: ExecutionProvider.Paper, status: ExecutionStatus.Simulated,
      executionId: attempt.executionId, txId: "signature-1", inputAmount: 0.5, outputAmount: 55, effectivePrice: 110, feeAmount: 1 };
    await repository.saveExecutionResult(attempt, report, false);
    const input = commit(report); input.executionId = attempt.executionId; input.orderId = attempt.orderId;
    input.lots = [{ ...state.lots[0]!, remainingBaseAmount: 0.5, costQuote: 50 } as any];
    input.snapshot = { ...input.snapshot, availableQuoteAmount: 54, availableBaseAmount: 0.5,
      deployedQuoteAmount: 50, totalEquityUsd: 104 };
    expect(await repository.commitExecution(input)).toBe(true);
    expect(state.bands[0]).toMatchObject({ availableQuoteAmount: 50, deployedCostQuote: 50 });
    expect(state.portfolios[0]?.freeQuoteAmount).toBe(4);
    expect(state.snapshots.at(-1)).toMatchObject({ availableQuoteAmount: 50, totalEquityUsd: 100 });
    expect(state.commitments[0]?.fulfilledAt).toBeNull();
  });

  it("rejects simulated terminal reports for live executions", async () => {
    const repository = new PrismaTradeRepository();
    const attempt = await repository.prepareExecutionAttempt(preparation());
    await expect(repository.saveExecutionResult(attempt, result(ExecutionStatus.Simulated), false)).rejects.toThrow(/paper mode/);
  });
});

describe("atomic recenter persistence", () => {
  it("commits range and snapshot together, preserving retained lots", async () => {
    state.lots.push({ kind: "retained", remainingBaseAmount: 1, closedAt: null });
    const repository = new PrismaBotStateRepository();
    await repository.updateRange("bot-1", { lowPrice: 100, highPrice: 120 }, commit().snapshot);
    expect(state.config.lowPrice).toBe(100);
    expect(state.snapshots).toHaveLength(1);
  });
  it("rolls back range if snapshot fails", async () => {
    failWrite = "snapshot.create";
    await expect(new PrismaBotStateRepository().updateRange("bot-1", { lowPrice: 100, highPrice: 120 }, commit().snapshot)).rejects.toThrow("injected");
    expect(state.config.lowPrice).toBe(90);
  });
  it("refuses recenter with an active trade lot or pending execution", async () => {
    const repository = new PrismaBotStateRepository();
    state.lots.push({ kind: "trading", remainingBaseAmount: 1, closedAt: null });
    await expect(repository.updateRange("bot-1", { lowPrice: 100, highPrice: 120 }, commit().snapshot)).rejects.toThrow("Cannot recenter");
    state.lots = []; state.attempts.push({ botId: "bot-1" });
    await expect(repository.updateRange("bot-1", { lowPrice: 100, highPrice: 120 }, commit().snapshot)).rejects.toThrow("Cannot recenter");
  });
  it("drops a stale V2 passive snapshot and routes V2 range changes through the portfolio manager", async () => {
    seedPortfolioBand();
    const repository = new PrismaBotStateRepository();
    const before = state.snapshots.length;
    await repository.createStateSnapshot({ ...commit().snapshot,
      metadata: { ...commit().snapshot.metadata, gridRevisionId: "stale-revision" } });
    expect(state.snapshots).toHaveLength(before);
    await repository.createStateSnapshot({ ...commit().snapshot,
      metadata: { ...commit().snapshot.metadata, gridRevisionId: "revision-1" } });
    expect(state.snapshots).toHaveLength(before + 1);
    await expect(repository.updateRange("bot-1", { lowPrice: 100, highPrice: 120 }, commit().snapshot))
      .rejects.toThrow(/portfolio manager/);
  });
});

describe("dedicated session bot locks", () => {
  it("excludes another worker while callback runs without a long SQL transaction and always unlocks", async () => {
    let held = false;
    const clients: Array<EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
    mocked.pool.connect.mockImplementation(async () => {
      const client = Object.assign(new EventEmitter(), { release: vi.fn(), query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) { const locked = !held; if (locked) held = true; return { rows: [{ locked }] }; }
        held = false; return { rows: [{ unlocked: true }] };
      }) });
      clients.push(client); return client;
    });
    const repository = new PrismaBotStateRepository();
    let finish!: () => void;
    const pending = repository.withBotLock("bot-1", () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(held).toBe(true));
    const second = vi.fn(async () => 2);
    expect(await repository.withBotLock("bot-1", second)).toBeNull();
    expect(second).not.toHaveBeenCalled();
    expect(transactionCount).toBe(0);
    finish(); await pending;
    expect(held).toBe(false);
    expect(clients.every((client) => client.release.mock.calls.length === 1)).toBe(true);
    await expect(repository.withBotLock("bot-1", async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");
    expect(held).toBe(false);
  });

  it("destroys a session when advisory unlock fails instead of returning a locked connection to the pool", async () => {
    const release = vi.fn();
    const client = Object.assign(new EventEmitter(), { release, query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] }).mockRejectedValueOnce(new Error("lost session")) });
    mocked.pool.connect.mockResolvedValue(client);
    await new PrismaBotStateRepository().withBotLock("bot-1", async () => "done");
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});
