/** Opt-in destructive checks against a NEW disposable database only; never reads DATABASE_URL. */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port > 1024 && port <= 65535, "Pass the isolated Docker host port explicitly");
const databaseUrl = `postgresql://postgres:isolated-only@127.0.0.1:${port}/grid_bot_contract_test`;
Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: databaseUrl, ADMIN_USERNAME: "test", ADMIN_PASSWORD: "test",
  SESSION_SECRET: "isolated-test-session-secret", RPC_HTTP_URL: "http://127.0.0.1:1", RPC_WS_URL: "ws://127.0.0.1:1",
  EXECUTION_WALLET_SECRET_KEY_PATH: "", JUPITER_API_KEY: "", LIVE_TRADING_ENABLED: "false", DISCORD_WEBHOOK_URL: "" });
globalThis.fetch = async () => { throw new Error("HTTP is disabled during database contract verification"); };
const { Client } = await import("pg");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const tables = await client.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
assert.equal(tables.rows[0].count, 0, "Refusing nonempty database: use a NEW disposable PostgreSQL container");
const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const applied: string[] = [];
for (const entry of (await readdir(migrationRoot, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  await client.query(await readFile(resolve(migrationRoot, entry.name, "migration.sql"), "utf8"));
  applied.push(entry.name);
}
const { prisma, botLockPool, PrismaTradeRepository, PrismaBotStateRepository } = await import("../src/index");
const { BotStatus, BotMode, StrategyMode, ExecutionProvider, ExecutionStatus, OrderStatus, TradeSide, GridType, RecenterMode } = await import("@grid-bot/core");
const now = new Date();
const bot = await prisma.bot.create({ data: { key: "isolated-contract", name: "Isolated Contract", baseMint: "SOL", quoteMint: "USDC", baseSymbol: "SOL",
  quoteSymbol: "USDC", baseDecimals: 9, quoteDecimals: 6, strategyMode: "balanced", mode: "live", status: "running", executionProvider: "jupiter",
  config: { create: { totalBudgetUsd: 1000, maxDeployableUsd: 990, reserveQuoteAmount: 10, lowPrice: 90, highPrice: 110,
    levelCount: 5, gridType: "arithmetic", minOrderQuoteAmount: 10, maxSlippageBps: 50, cooldownMs: 1000,
    maxOrdersPerHour: 10, maxDrawdownPct: 20, maxConsecutiveFailures: 3, levelLockMs: 1000,
    priceConfirmationWindowMs: 1000, recenterMode: "manual_recenter", autoRecenterMinIntervalMs: 21600000, autoRecenterMaxPerDay: 2 } } } });
const repo = new PrismaTradeRepository();
const stateRepo = new PrismaBotStateRepository();
const attempt = await repo.prepareExecutionAttempt({ botId: bot.id, expectedSnapshotId: null,
  signal: { levelIndex: 1, side: TradeSide.Buy, levelPrice: 100, observedPrice: 99, idempotencyKey: "isolated-signal", triggeredAt: now },
  orderIntent: { botId: bot.id, orderKey: "isolated-order", side: TradeSide.Buy, levelIndex: 1, targetPrice: 100,
    requestedBaseAmount: 1, requestedQuoteAmount: 100, status: OrderStatus.Created, reason: "test only" },
  executionParams: { botId: bot.id, clientOrderId: "isolated-order", inputMint: "USDC", outputMint: "SOL", amount: 100, inputDecimals: 6, outputDecimals: 9, slippageBps: 50 },
  preparedExecution: { provider: ExecutionProvider.Jupiter, inputMint: "USDC", outputMint: "SOL", inputAmount: 100,
    expectedOutputAmount: 1, expectedPrice: 100, estimatedFeeAmount: 0, priceImpactPct: 0, requestId: "isolated-request",
    rawQuote: { signedTransaction: "NOT-A-REAL-TRANSACTION", txId: "isolated-signature" } } });
const restored = await repo.getPendingExecution(bot.id);
assert(restored?.signal.triggeredAt instanceof Date);
assert.equal(restored.signal.triggeredAt.getTime(), now.getTime());
assert.equal((await prisma.execution.findUniqueOrThrow({ where: { id: attempt.executionId } })).txId, "isolated-signature");
const report = { provider: ExecutionProvider.Jupiter, status: ExecutionStatus.Filled, executionId: attempt.executionId, txId: "isolated-signature",
  inputAmount: 100, outputAmount: 0.995, effectivePrice: 100 / 0.995, feeAmount: 0, rawReport: { transaction: "NOT-A-REAL-TRANSACTION", status: "Success" } };
await repo.saveExecutionResult(attempt, report, false);
const snapshot = { botId: bot.id, status: BotStatus.Cooldown, currentPrice: 100, availableQuoteAmount: 900, availableBaseAmount: 0.995,
  deployedQuoteAmount: 100, averageEntryPrice: 100 / 0.995, realizedPnlUsd: 0, unrealizedPnlUsd: -0.5, totalEquityUsd: 999.5,
  consecutiveFailures: 0, lastExecutionAt: now, lastProcessedAt: now, lastRecenterAt: null,
  metadata: { levelLocks: {}, recenterHistory: [], recentExecutions: [] } };
const commit = { botId: bot.id, orderId: attempt.orderId, executionId: attempt.executionId, report,
  lots: [{ id: "isolated-lot", botId: bot.id, kind: "retained" as const, originalBaseAmount: 0.995, remainingBaseAmount: 0.995,
    costQuote: 100, entryPrice: 100 / 0.995, openedByExecutionId: attempt.executionId, closedByExecutionId: null, openedAt: now, closedAt: null }],
  position: { botId: bot.id, baseAmount: 0.995, quoteSpent: 100, averageEntryPrice: 100 / 0.995, totalFeesQuote: 0, realizedPnlUsd: 0, unrealizedPnlUsd: -0.5 }, snapshot };
const changedWhilePending = await prisma.botStateSnapshot.create({ data: snapshot });
const sameAttempt = await repo.prepareExecutionAttempt({ ...attempt, expectedSnapshotId: null });
assert.equal(sameAttempt.executionId, attempt.executionId);
await prisma.botStateSnapshot.delete({ where: { id: changedWhilePending.id } });
await client.query("CREATE FUNCTION contract_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated injected write failure'; END $$");
const failedWrites: string[] = [];
for (const [table, event] of [["executions", "UPDATE"], ["position_lots", "DELETE"], ["position_lots", "INSERT"], ["positions", "INSERT"],
  ["inventory_snapshots", "INSERT"], ["pnl_snapshots", "INSERT"], ["bot_state_snapshots", "INSERT"], ["bots", "UPDATE"], ["orders", "UPDATE"], ["execution_attempts", "DELETE"]]) {
  // table/event are literals from the fixed allowlist above, never user input.
  await client.query(`CREATE TRIGGER contract_fail BEFORE ${event} ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION contract_fail_write()`);
  await assert.rejects(repo.commitExecution(commit));
  await client.query(`DROP TRIGGER contract_fail ON "${table}"`);
  assert.equal((await prisma.execution.findUniqueOrThrow({ where: { id: attempt.executionId } })).completedAt, null);
  assert.equal(await prisma.executionAttempt.count(), 1);
  assert.equal(await prisma.positionLot.count(), 0);
  assert.equal(await prisma.botStateSnapshot.count(), 0);
  failedWrites.push(`${table}:${event}`);
}
await prisma.bot.update({ where: { id: bot.id }, data: { status: "paused" } });
assert.equal(await repo.commitExecution(commit), true);
assert.equal(await repo.commitExecution(commit), false);
await assert.rejects(repo.prepareExecutionAttempt({ ...attempt, expectedSnapshotId: null }), /accounting changed/);
assert.equal(await prisma.execution.count(), 1);
assert.equal(await prisma.executionAttempt.count(), 0);
assert.equal(await prisma.positionLot.count({ where: { kind: "retained" } }), 1);
assert.equal((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).status, "paused");
assert.equal((await prisma.botStateSnapshot.findFirstOrThrow()).status, "paused");
assert(!JSON.stringify(await prisma.execution.findMany()).includes("NOT-A-REAL-TRANSACTION"));
let release!: () => void;
let entered!: () => void;
const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
const firstLock = stateRepo.withBotLock(bot.id, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return 1; });
await enteredPromise;
assert.equal(await new PrismaBotStateRepository().withBotLock(bot.id, async () => 2), null);
const active = await client.query("SELECT state FROM pg_stat_activity WHERE query LIKE 'SELECT pg_try_advisory_lock%' AND pid <> pg_backend_pid()");
assert(active.rows.every((row) => row.state === "idle"), "Advisory lock must not keep a SQL transaction open");
release(); assert.equal(await firstLock, 1);
assert.equal(await stateRepo.withBotLock(bot.id, async () => 3), 3);
// Kill only the dedicated lock session in this isolated database, let a second
// worker persist newer state, then prove the first worker cannot use its old quote.
const beforeLoss = await prisma.botStateSnapshot.findFirstOrThrow({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
let resumeStale!: () => void;
let lostLockEntered!: () => void;
const lostEntered = new Promise<void>((resolve) => { lostLockEntered = resolve; });
const lostLock = stateRepo.withBotLock(bot.id, async () => {
  lostLockEntered();
  await new Promise<void>((resolve) => { resumeStale = resolve; });
  return repo.prepareExecutionAttempt({ ...attempt, expectedSnapshotId: beforeLoss.id });
});
await lostEntered;
const heldLocks = await client.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid()");
assert.equal(heldLocks.rows.length, 1);
await client.query("SELECT pg_terminate_backend($1)", [heldLocks.rows[0].pid]);
let takeover: boolean | null = null;
for (let attemptIndex = 0; attemptIndex < 50 && takeover === null; attemptIndex += 1) {
  takeover = await new PrismaBotStateRepository().withBotLock(bot.id, async () => {
    await stateRepo.createStateSnapshot({ ...snapshot, lastProcessedAt: new Date() });
    return true;
  });
  if (takeover === null) await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.equal(takeover, true);
const staleRejected = assert.rejects(lostLock, /accounting changed/);
resumeStale(); await staleRejected;
assert.equal(await prisma.execution.count(), 1);
const summary = { database: "disposable PostgreSQL 17-alpine on loopback; removed after verification", migrations: applied,
  preparation: "atomic durable payload and timestamp revival", rollbackFaults: failedWrites, exactlyOnceCommit: true, stalePreparationFence: true, lostSessionFence: true, existingAttemptResumedAcrossStateChange: true,
  pausedStatusPreserved: true, retainedLotPreserved: true, signedPayloadHidden: true,
  realSessionLockExclusion: true, noOpenSqlTransactionDuringCallback: true, externalNetworkCalls: 0 };
await writeFile(resolve(migrationRoot, "../../../../audits/2026-09-10/postgres-contract-results.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect(); await botLockPool.end(); await client.end();
