/** Opt-in integration check. Only a NEW disposable loopback PostgreSQL database is accepted.
 * Run: pnpm --filter @grid-bot/worker exec tsx scripts/verify-paper-operation.mts <port>
 * Start PostgreSQL with database grid_bot_paper_test and password isolated-only.
 * Prices and application time are synthetic; this is not a profitability test.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port > 1024 && port <= 65535, "Pass the isolated Docker host port explicitly");
const databaseUrl = `postgresql://postgres:isolated-only@127.0.0.1:${port}/grid_bot_paper_test`;
Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: databaseUrl, ADMIN_USERNAME: "test", ADMIN_PASSWORD: "test",
  SESSION_SECRET: "isolated-test-session-secret", RPC_HTTP_URL: "http://127.0.0.1:1", RPC_WS_URL: "ws://127.0.0.1:1",
  EXECUTION_WALLET_SECRET_KEY_PATH: "", JUPITER_API_KEY: "", LIVE_TRADING_ENABLED: "false", DISCORD_WEBHOOK_URL: "" });
let externalNetworkCalls = 0;
globalThis.fetch = async () => { externalNetworkCalls += 1; throw new Error("HTTP disabled during paper verification"); };
const requireDb = createRequire(resolve(root, "packages/db/package.json"));
const { Client } = requireDb("pg");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const { prisma, botLockPool, PrismaTradeRepository, PrismaBotStateRepository, PrismaPriceSnapshotRepository,
  PrismaSystemLogRepository, PrismaAlertRepository } = await import("@grid-bot/db");
const { BotEngineService, PaperExecutionAdapter, ExecutionService, GridStrategyService, RiskManagerService, AlertService,
  ExecutionProvider } = await import("@grid-bot/core");
const RealDate = globalThis.Date;
let clockMs = RealDate.parse("2026-09-10T00:00:00Z");
class SyntheticDate extends RealDate {
  constructor(value?: string | number | Date) { super(arguments.length === 0 ? clockMs : value!); }
  static now() { return clockMs; }
}
const scenarios: Record<string, unknown> = {};
const checks: Record<string, boolean> = {};
let price = 120;
let engine: InstanceType<typeof BotEngineService>;
const states = new PrismaBotStateRepository();
function restartEngine() {
  const paper = new PaperExecutionAdapter();
  // Only the actual paper adapter exists, and live trading remains disabled.
  engine = new BotEngineService(new PrismaBotStateRepository(), new PrismaTradeRepository(),
    new PrismaPriceSnapshotRepository(), new PrismaSystemLogRepository(),
    { getLatestPrice: async () => ({ symbol: "SOL", pair: "SOL/USDC", price, confidence: 0,
      source: "deterministic-synthetic", timestamp: new Date(), sourceObservedAt: new Date(), feedId: "synthetic-sol" }) },
    new ExecutionService({ [ExecutionProvider.Paper]: paper } as never, false),
    new GridStrategyService(), new RiskManagerService(), new AlertService(new PrismaAlertRepository(), []));
}
async function createBot(key: string, strategyMode = "balanced", config = {}) {
  return prisma.bot.create({ data: { key, name: key, baseMint: "SOL", quoteMint: "USDC", baseSymbol: "SOL",
    quoteSymbol: "USDC", baseDecimals: 9, quoteDecimals: 6, strategyMode: strategyMode as never, mode: "paper",
    status: "running", executionProvider: "paper", config: { create: { totalBudgetUsd: 1000,
      maxDeployableUsd: 800, reserveQuoteAmount: 200, lowPrice: 90, highPrice: 130, levelCount: 5,
      gridType: "arithmetic", minOrderQuoteAmount: 10, maxSlippageBps: 50, cooldownMs: 1000,
      maxOrdersPerHour: 100, maxDrawdownPct: 90, maxConsecutiveFailures: 3, levelLockMs: 1000,
      priceConfirmationWindowMs: 1000, recenterMode: "manual_recenter", autoRecenterMinIntervalMs: 60000,
      autoRecenterMaxPerDay: 2, ...config } } } });
}
async function tick(id: string, nextPrice: number, elapsedMs = 2000) {
  clockMs += elapsedMs; price = nextPrice; await engine.runBot(id);
  const aggregate = await states.getBotAggregate(id); assert(aggregate?.latestState);
  assert.notEqual(aggregate.bot.status, "error", JSON.stringify(await prisma.systemLog.findMany({ where: { botId: id } })));
  return aggregate;
}
async function capture(id: string) {
  const aggregate = await states.getBotAggregate(id); assert(aggregate?.latestState);
  const executions = await prisma.execution.findMany({ where: { botId: id }, include: { order: true }, orderBy: { createdAt: "asc" } });
  return { config: aggregate.config, state: aggregate.latestState, lots: aggregate.openLots,
    executions: executions.map((e) => ({ side: e.order.side, status: e.status, input: Number(e.executedInputAmount),
      output: Number(e.executedOutputAmount), fee: Number(e.executedFeeAmount), rail: Number(e.order.targetPrice), rawReport: e.rawReport })) };
}
try {
  const tables = await client.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
  assert.equal(tables.rows[0].count, 0, "Refusing nonempty database: use a NEW disposable container");
  const migrationRoot = resolve(root, "packages/db/prisma/migrations");
  const migrations = (await readdir(migrationRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const migration of migrations) await client.query(await readFile(resolve(migrationRoot, migration.name, "migration.sql"), "utf8"));
  globalThis.Date = SyntheticDate as DateConstructor;
  restartEngine();
  for (const mode of ["accumulate_usdc", "balanced", "accumulate_base"]) {
    const bot = await createBot(mode, mode);
    const start = await tick(bot.id, 115);
    assert.equal(start.latestState!.availableQuoteAmount, 1000); assert.equal(start.openLots.length, 0);
    const pending = await tick(bot.id, 109);
    assert.equal(pending.openLots.length, 0); assert(pending.latestState!.metadata.pendingSignal);
    // Recreate repositories, engine and adapter after the pending signal was persisted.
    restartEngine();
    const bought = await tick(bot.id, 109);
    assert.equal(bought.openLots.length, 1);
    const inventoryBeforePause = bought.latestState!.availableBaseAmount;
    await prisma.bot.update({ where: { id: bot.id }, data: { status: "paused" } });
    const paused = await tick(bot.id, 121);
    assert.equal(paused.bot.status, "paused"); assert.equal(paused.latestState!.availableBaseAmount, inventoryBeforePause);
    assert(!(await states.listRunnableBots()).some((b) => b.bot.id === bot.id));
    await prisma.bot.update({ where: { id: bot.id }, data: { status: "running" } });
    restartEngine();
    await tick(bot.id, 121);
    await tick(bot.id, 121);
    scenarios[mode] = await capture(bot.id);
    const result = scenarios[mode] as Awaited<ReturnType<typeof capture>>;
    checks[`${mode}:observedExecutionPrices`] = result.executions.every((e) =>
      (e.rawReport as { referencePrice: number }).referencePrice === (e.side === "buy" ? 109 : 121));
    checks[`${mode}:closedTradingCycle`] = !result.lots.some((lot) => lot.kind !== "retained");
    checks[`${mode}:retention`] = mode === "accumulate_usdc" ? result.lots.length === 0 : result.lots.some((lot) => lot.kind === "retained");
    const count = await prisma.execution.count({ where: { botId: bot.id } });
    restartEngine(); await tick(bot.id, 125);
    checks[`${mode}:retainedNotResoldAfterRestart`] = await prisma.execution.count({ where: { botId: bot.id } }) === count;
  }
  checks.pendingConfirmationRestart = true; checks.pauseResume = true;
  // A full descending ladder pressures both principal+fee deployability and the cash floor.
  const budget = await createBot("budget-pressure", "accumulate_usdc");
  await tick(budget.id, 125);
  const balances = [];
  for (const p of [119, 109, 99, 90]) { await tick(budget.id, p); const a = await tick(budget.id, p); balances.push({ price: p,
    quote: a.latestState!.availableQuoteAmount, deployed: a.latestState!.deployedQuoteAmount }); }
  scenarios.budget = { balances, ...(await capture(budget.id)), blockedOrders: await prisma.order.count({ where: { botId: budget.id, status: "blocked" } }) };
  checks.reservePreserved = balances.every((b) => b.quote >= 200 - 1e-8);
  checks.maxDeployablePreserved = balances.every((b) => b.deployed <= 800 + 1e-8);
  const feeOnly = await createBot("fees-at-budget-limit", "accumulate_usdc", { levelCount: 2 });
  await tick(feeOnly.id, 115); await tick(feeOnly.id, 89); await tick(feeOnly.id, 89);
  const feeGuard = await capture(feeOnly.id);
  checks.principalFitsButFeesBlocked = feeGuard.executions.length === 0 && feeGuard.state.availableQuoteAmount === 1000 &&
    (await prisma.systemLog.findMany({ where: { botId: feeOnly.id } })).some((l) => l.message.includes("input and fees exceed"));
  scenarios.feesAtBudgetLimit = feeGuard;
  const recenter = await createBot("flat-auto-recenter", "balanced", { recenterMode: "auto_recenter" });
  await tick(recenter.id, 115); await tick(recenter.id, 145);
  const before = await tick(recenter.id, 145, 29999);
  assert.equal(before.config.highPrice, 130);
  restartEngine(); const after = await tick(recenter.id, 145, 1);
  assert(after.config.lowPrice > 90 && after.config.highPrice > 130);
  assert(after.config.lowPrice < 145 && after.config.highPrice > 145);
  assert.equal(after.latestState!.metadata.recenterHistory.length, 1);
  assert.equal(await prisma.alert.count({ where: { botId: recenter.id, type: "recenter_performed" } }), 1);
  checks.autoRecenterPersistedAfterConfirmationAndRestart = true;
  scenarios.recenter = await capture(recenter.id);
  const allExecutions = await prisma.execution.findMany();
  assert(allExecutions.every((e) => e.provider === "paper" && e.mode === "paper" && e.status === "simulated"));
  assert.equal(externalNetworkCalls, 0);
  const result = { kind: "operational integration against real disposable PostgreSQL with synthetic prices/application time",
    realMarketObservation: false, profitabilityEvidence: false, database: "disposable PostgreSQL 17-alpine loopback only",
    migrations: migrations.map((m) => m.name), syntheticStart: "2026-09-10T00:00:00Z", syntheticEnd: new Date().toISOString(),
    checks, externalNetworkCalls, executions: allExecutions.length, scenarios };
  await writeFile(resolve(root, "audits/2026-09-10/paper-operational-results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ checks, executions: allExecutions.length }, null, 2));
  assert(Object.values(checks).every(Boolean), "Operational paper contract failed: see paper-operational-results.json");
} finally {
  globalThis.Date = RealDate;
  await prisma.$disconnect(); await botLockPool.end(); await client.end();
}
