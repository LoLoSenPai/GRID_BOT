/**
 * Bounded SOL paper-pilot observer.
 *
 * Run (the caller must provide a fresh disposable PostgreSQL container):
 *   pnpm --filter @grid-bot/worker exec tsx scripts/observe-paper-pilot.mts \
 *     <port> <configJsonPath> <durationSeconds> [outputDir]
 *
 * Fills are synthetic PaperExecutionAdapter fills. Prices are read from
 * Jupiter Price V3, and this script never constructs a live execution adapter.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [portArg, configPathArg, durationArg, outputDirArg] = process.argv.slice(2);
const port = Number(portArg);
const durationSeconds = Number(durationArg);
assert(Number.isInteger(port) && port > 1024 && port <= 65535, "Pass the isolated Docker host port explicitly.");
assert(configPathArg, "Pass a candidate portfolio JSON path.");
assert(Number.isInteger(durationSeconds) && durationSeconds >= 60 && durationSeconds <= 172_800,
  "durationSeconds must be an integer from 60 through 172800.");

const configPath = isAbsolute(configPathArg) ? configPathArg : resolve(process.cwd(), configPathArg);
const outputDir = outputDirArg
  ? (isAbsolute(outputDirArg) ? outputDirArg : resolve(process.cwd(), outputDirArg))
  : resolve(root, "audits/2026-09-10/paper-pilot");
const statusPath = resolve(outputDir, "status.json");
const priceObservationsPath = resolve(outputDir, "price-observations.jsonl");
const portfolioSnapshotsPath = resolve(outputDir, "portfolio-snapshots.jsonl");
const databaseUrl = `postgresql://postgres:isolated-only@127.0.0.1:${port}/grid_bot_pilot_test`;
const POLL_INTERVAL_MS = 5_000;
const HTTP_TIMEOUT_MS = 5_000;
const RATE_LIMIT_MAX = 3;
const EPSILON = 1e-7;

type CandidateConfig = import("@grid-bot/core").BacktestConfig;
type CandidateInput = {
  portfolios: Array<{
    id: string;
    totalBudgetUsd: number;
    reserveQuoteAmount: number;
    allocations: Array<{ id: string; config: CandidateConfig }>;
  }>;
  symbol: "SOL";
  purpose: "research_only";
};

type OutputState = {
  status: "starting" | "running" | "completed" | "stopped" | "error";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationSeconds: number;
  polls: number;
  freshPriceTicks: number;
  omittedSourceTicks: number;
  rateLimitedTicks: number;
  portfolioSnapshots: number;
  latestPriceStatus?: "fresh" | "omitted_source";
  latestPrice?: { pair: string; price: number; checkedAt: string; sourceBlockId: number | null; quoteSourceBlockId: number | null };
  stalePeriods: Array<{ startedAt: string; endedAt?: string; polls: number; lastReason: string }>;
  stopReason?: string;
  error?: { name: string; message: string; httpStatus?: number };
  metadata: Record<string, unknown>;
  portfolios: Array<Record<string, unknown>>;
};

const startedAt = new Date().toISOString();
const state: OutputState = {
  status: "starting",
  startedAt,
  updatedAt: startedAt,
  durationSeconds,
  polls: 0,
  freshPriceTicks: 0,
  omittedSourceTicks: 0,
  rateLimitedTicks: 0,
  portfolioSnapshots: 0,
  stalePeriods: [],
  metadata: {
    kind: "sol-paper-pilot-observation",
    symbol: "SOL",
    quoteSymbol: "USDC",
    purpose: "research_only",
    executionMode: "paper",
    executionProvider: "paper",
    fillSource: "synthetic PaperExecutionAdapter fills",
    priceSource: "real Jupiter Price V3 read-only GET tick feed",
    financialValidation: false,
    comparison: "wide versus zones at identical portfolio total capital, including external reserve",
    initialRanges: "fixed at supplied lowPrice/highPrice values; not optimized during this run or presented as future optimization",
    assumptions: "real price observations, synthetic fills, local disposable PostgreSQL state; no mainnet fills"
  },
  portfolios: []
};

let stopRequested = false;
let stopReason: string | undefined;
const stopWaiters = new Set<() => void>();
const requestStop = (reason: string) => {
  if (stopRequested) return;
  stopRequested = true;
  stopReason = reason;
  for (const resolveWait of stopWaiters) resolveWait();
  stopWaiters.clear();
};
const onSigInt = () => requestStop("SIGINT");
const onSigTerm = () => requestStop("SIGTERM");
process.once("SIGINT", onSigInt);
process.once("SIGTERM", onSigTerm);

let pgClient: { connect(): Promise<void>; query(query: string): Promise<{ rows: Array<{ count: number }> }>; end(): Promise<void> } | undefined;
let prisma: { $disconnect(): Promise<void>; bot: any; execution: any; order: any } | undefined;
let botLockPool: { end(): Promise<void> } | undefined;
let envForRedaction: { JUPITER_API_KEY?: string } | undefined;
let outputStatusWritable = true;

function safeErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const key = envForRedaction?.JUPITER_API_KEY;
  return key ? raw.split(key).join("[redacted]") : raw.replace(/x-api-key[=:]\s*[^\s,;]+/gi, "x-api-key=[redacted]");
}

function httpStatusOf(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string.`);
  return value.trim();
}

function requireFiniteNumber(value: unknown, label: string, options: { integer?: boolean; min?: number } = {}) {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number.`);
  if (options.integer) assert(Number.isInteger(value), `${label} must be an integer.`);
  if (options.min !== undefined) assert(value >= options.min, `${label} must be >= ${options.min}.`);
  return value;
}

function validateCandidate(value: unknown): CandidateInput {
  assert(isRecord(value), "Candidate JSON must be an object.");
  assert(value.symbol === "SOL", "Candidate symbol must be SOL.");
  assert(value.purpose === "research_only", "Candidate purpose must be research_only.");
  assert(Array.isArray(value.portfolios) && value.portfolios.length > 0, "Candidate portfolios must be a non-empty array.");
  const portfolioIds = new Set<string>();
  const portfolios = value.portfolios.map((rawPortfolio, portfolioIndex) => {
    assert(isRecord(rawPortfolio), `portfolios[${portfolioIndex}] must be an object.`);
    const id = requireString(rawPortfolio.id, `portfolios[${portfolioIndex}].id`);
    assert(!portfolioIds.has(id), `Duplicate portfolio id: ${id}.`);
    portfolioIds.add(id);
    const totalBudgetUsd = requireFiniteNumber(rawPortfolio.totalBudgetUsd, `${id}.totalBudgetUsd`, { min: 0 });
    const reserveQuoteAmount = requireFiniteNumber(rawPortfolio.reserveQuoteAmount, `${id}.reserveQuoteAmount`, { min: 0 });
    assert(Array.isArray(rawPortfolio.allocations) && rawPortfolio.allocations.length > 0, `${id}.allocations must be a non-empty array.`);
    const allocationIds = new Set<string>();
    const allocations = rawPortfolio.allocations.map((rawAllocation, allocationIndex) => {
      assert(isRecord(rawAllocation), `${id}.allocations[${allocationIndex}] must be an object.`);
      const allocationId = requireString(rawAllocation.id, `${id}.allocations[${allocationIndex}].id`);
      assert(!allocationIds.has(allocationId), `Duplicate allocation id in ${id}: ${allocationId}.`);
      allocationIds.add(allocationId);
      assert(isRecord(rawAllocation.config), `${id}/${allocationId}.config must be an object.`);
      const config = validateBacktestConfig(rawAllocation.config, `${id}/${allocationId}.config`);
      return { id: allocationId, config };
    });
    const allocated = allocations.reduce((sum, allocation) => sum + allocation.config.budgetUsd, 0);
    assert(Math.abs(allocated + reserveQuoteAmount - totalBudgetUsd) <= EPSILON * Math.max(1, totalBudgetUsd),
      `${id}: sum(config.budgetUsd) + reserveQuoteAmount must equal totalBudgetUsd.`);
    return { id, totalBudgetUsd, reserveQuoteAmount, allocations };
  });
  return { portfolios, symbol: "SOL", purpose: "research_only" };
}

function validateBacktestConfig(raw: Record<string, unknown>, label: string): CandidateConfig {
  const config = raw as unknown as CandidateConfig;
  requireFiniteNumber(config.budgetUsd, `${label}.budgetUsd`, { min: 0 });
  requireFiniteNumber(config.lowPrice, `${label}.lowPrice`, { min: Number.EPSILON });
  requireFiniteNumber(config.highPrice, `${label}.highPrice`, { min: Number.EPSILON });
  assert(config.highPrice > config.lowPrice, `${label}.highPrice must exceed lowPrice.`);
  requireFiniteNumber(config.levelCount, `${label}.levelCount`, { integer: true, min: 2 });
  assert(config.gridType === "arithmetic" || config.gridType === "geometric", `${label}.gridType is invalid.`);
  assert(config.strategyMode === "accumulate_base" || config.strategyMode === "accumulate_usdc" || config.strategyMode === "balanced", `${label}.strategyMode is invalid.`);
  assert(config.minOrderMode === "auto" || config.minOrderMode === "manual", `${label}.minOrderMode is invalid.`);
  requireFiniteNumber(config.minOrderQuoteAmount, `${label}.minOrderQuoteAmount`, { min: 0 });
  requireFiniteNumber(config.maxSlippageBps, `${label}.maxSlippageBps`, { min: 0 });
  requireFiniteNumber(config.cooldownMs, `${label}.cooldownMs`, { integer: true, min: 0 });
  requireFiniteNumber(config.maxOrdersPerHour, `${label}.maxOrdersPerHour`, { integer: true, min: 1 });
  requireFiniteNumber(config.maxDrawdownPct, `${label}.maxDrawdownPct`, { min: 0 });
  requireFiniteNumber(config.maxConsecutiveFailures, `${label}.maxConsecutiveFailures`, { integer: true, min: 1 });
  requireFiniteNumber(config.levelLockMs, `${label}.levelLockMs`, { integer: true, min: 0 });
  requireFiniteNumber(config.priceConfirmationWindowMs, `${label}.priceConfirmationWindowMs`, { integer: true, min: 0 });
  assert(config.recenterMode === "manual_recenter", `${label}.recenterMode must be manual_recenter for this fixed-range research run.`);
  assert((config.rangeControlMode ?? "static") === "static", `${label}.rangeControlMode must be static for this fixed-range research run.`);
  assert(Math.abs((config.executionFeeBps ?? 10) - 10) <= EPSILON,
    `${label}.executionFeeBps must be 10 bps to match PaperExecutionAdapter.`);
  assert(typeof config.outOfRangePause === "boolean", `${label}.outOfRangePause must be boolean.`);
  if (config.maxDeployableUsd !== undefined) requireFiniteNumber(config.maxDeployableUsd, `${label}.maxDeployableUsd`, { min: 0 });
  if (config.reserveQuoteAmount !== undefined) requireFiniteNumber(config.reserveQuoteAmount, `${label}.reserveQuoteAmount`, { min: 0 });
  if (config.maxDeployableUsd !== undefined && config.reserveQuoteAmount !== undefined) {
    assert(config.maxDeployableUsd + config.reserveQuoteAmount <= config.budgetUsd + EPSILON,
      `${label}: maxDeployableUsd plus reserveQuoteAmount exceeds budgetUsd.`);
  }
  return config;
}

function dbConfig(config: CandidateConfig, defaults: { defaultAutoRecenterMinIntervalMs: number; defaultAutoRecenterMaxPerDay: number }) {
  const reserve = config.reserveQuoteAmount ?? 0;
  const maxDeployable = config.maxDeployableUsd ?? Math.max(0, config.budgetUsd - reserve);
  assert(maxDeployable + reserve <= config.budgetUsd + EPSILON, "Allocation deployable amount plus reserve exceeds budget.");
  return {
    totalBudgetUsd: config.budgetUsd,
    maxDeployableUsd: maxDeployable,
    reserveQuoteAmount: reserve,
    lowPrice: config.lowPrice,
    highPrice: config.highPrice,
    levelCount: config.levelCount,
    gridType: config.gridType,
    minOrderQuoteAmount: config.minOrderQuoteAmount,
    maxSlippageBps: config.maxSlippageBps,
    cooldownMs: config.cooldownMs,
    maxOrdersPerHour: config.maxOrdersPerHour,
    maxDrawdownPct: config.maxDrawdownPct,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    levelLockMs: config.levelLockMs,
    priceConfirmationWindowMs: config.priceConfirmationWindowMs,
    recenterMode: config.recenterMode,
    entryMode: config.entryMode ?? "normal",
    autoRecenterMinIntervalMs: config.autoRecenterMinIntervalMs ?? defaults.defaultAutoRecenterMinIntervalMs,
    autoRecenterMaxPerDay: config.autoRecenterMaxPerDay ?? defaults.defaultAutoRecenterMaxPerDay,
    outOfRangePause: config.outOfRangePause
  };
}

async function saveStatus() {
  state.updatedAt = new Date().toISOString();
  await writeFile(statusPath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function appendPriceObservation(observation: Record<string, unknown>) {
  await appendFile(priceObservationsPath, JSON.stringify(observation) + "\n", "utf8");
}

async function appendPortfolioSnapshot(snapshot: Record<string, unknown>) {
  await appendFile(portfolioSnapshotsPath, JSON.stringify(snapshot) + "\n", "utf8");
}

async function waitForPoll(ms: number) {
  if (stopRequested || ms <= 0) return;
  await new Promise<void>((resolveWait) => {
    let timer: ReturnType<typeof setTimeout>;
    const waiter = () => {
      clearTimeout(timer);
      stopWaiters.delete(waiter);
      resolveWait();
    };
    timer = setTimeout(waiter, ms);
    stopWaiters.add(waiter);
  });
}

async function portfolioStatus(
  portfolios: CandidateInput["portfolios"],
  botIds: Map<string, string>,
  initialCashByBot: Map<string, number>,
  repositories: { states: { getBotAggregate(botId: string): Promise<any> } }
) {
  return Promise.all(portfolios.map(async (portfolio) => {
    const allocations = await Promise.all(portfolio.allocations.map(async (allocation) => {
      const botId = botIds.get(`${portfolio.id}/${allocation.id}`)!;
      const [aggregate, executions] = await Promise.all([
        repositories.states.getBotAggregate(botId),
        prisma!.execution.findMany({ where: { botId }, select: { status: true, order: { select: { side: true } } } })
      ]);
      const counts = { total: executions.length, simulated: 0, buys: 0, sells: 0, failed: 0 };
      for (const execution of executions) {
        if (execution.status === "simulated") counts.simulated += 1;
        if (execution.status === "failed") counts.failed += 1;
        if (execution.order?.side === "buy") counts.buys += 1;
        if (execution.order?.side === "sell") counts.sells += 1;
      }
      const latest = aggregate?.latestState;
      const currentPrice = latest?.currentPrice === null || latest?.currentPrice === undefined ? null : Number(latest.currentPrice);
      const activeLots = (aggregate?.openLots ?? []).filter((lot: any) => !lot.closedAt && Number(lot.remainingBaseAmount) > 0);
      const retainedBaseAmount = activeLots.filter((lot: any) => lot.kind === "retained")
        .reduce((sum: number, lot: any) => sum + Number(lot.remainingBaseAmount), 0);
      const cashUsd = latest ? Number(latest.availableQuoteAmount) : initialCashByBot.get(botId) ?? allocation.config.budgetUsd;
      const baseAmount = latest ? Number(latest.availableBaseAmount) : 0;
      const equityUsd = latest ? Number(latest.totalEquityUsd) : cashUsd;
      const realizedPnlUsd = latest ? Number(latest.realizedPnlUsd) : 0;
      const unrealizedPnlUsd = latest ? Number(latest.unrealizedPnlUsd) : 0;
      return {
        id: allocation.id,
        botId,
        allocatedBudgetUsd: allocation.config.budgetUsd,
        lowPrice: allocation.config.lowPrice,
        highPrice: allocation.config.highPrice,
        status: aggregate?.bot?.status ?? "missing",
        currentPrice,
        cashUsd,
        baseAmount,
        heldBaseAmount: baseAmount,
        equityUsd,
        realizedPnlUsd,
        unrealizedPnlUsd,
        heldPlusRetainedBaseAmount: baseAmount,
        retainedBaseAmount,
        strandedBelowRangeCost: currentPrice !== null && currentPrice < allocation.config.lowPrice
          ? (latest ? Number(latest.deployedQuoteAmount) : 0) : 0,
        deployedQuoteAmount: latest ? Number(latest.deployedQuoteAmount) : 0,
        tradeCounts: counts
      };
    }));
    const botEquityUsd = allocations.reduce((sum, allocation) => sum + allocation.equityUsd, 0);
    const botCashUsd = allocations.reduce((sum, allocation) => sum + allocation.cashUsd, 0);
    return {
      id: portfolio.id,
      totalBudgetUsd: portfolio.totalBudgetUsd,
      allocatedBudgetUsd: portfolio.allocations.reduce((sum, allocation) => sum + allocation.config.budgetUsd, 0),
      externalReserveQuoteAmount: portfolio.reserveQuoteAmount,
      botEquityUsd,
      equityUsd: botEquityUsd + portfolio.reserveQuoteAmount,
      equityIncludingExternalReserveUsd: botEquityUsd + portfolio.reserveQuoteAmount,
      botCashUsd,
      cashUsd: botCashUsd + portfolio.reserveQuoteAmount,
      cashIncludingExternalReserveUsd: botCashUsd + portfolio.reserveQuoteAmount,
      baseAmount: allocations.reduce((sum, allocation) => sum + allocation.baseAmount, 0),
      heldBaseAmount: allocations.reduce((sum, allocation) => sum + allocation.heldBaseAmount, 0),
      heldPlusRetainedBaseAmount: allocations.reduce((sum, allocation) => sum + allocation.heldPlusRetainedBaseAmount, 0),
      retainedBaseAmount: allocations.reduce((sum, allocation) => sum + allocation.retainedBaseAmount, 0),
      realizedPnlUsd: allocations.reduce((sum, allocation) => sum + allocation.realizedPnlUsd, 0),
      unrealizedPnlUsd: allocations.reduce((sum, allocation) => sum + allocation.unrealizedPnlUsd, 0),
      strandedBelowRangeCost: allocations.reduce((sum, allocation) => sum + allocation.strandedBelowRangeCost, 0),
      allocations,
      tradeCounts: allocations.reduce((sum, allocation) => ({
        total: sum.total + allocation.tradeCounts.total,
        simulated: sum.simulated + allocation.tradeCounts.simulated,
        buys: sum.buys + allocation.tradeCounts.buys,
        sells: sum.sells + allocation.tradeCounts.sells,
        failed: sum.failed + allocation.tradeCounts.failed
      }), { total: 0, simulated: 0, buys: 0, sells: 0, failed: 0 })
    };
  }));
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  try {
    await readFile(statusPath, "utf8");
    outputStatusWritable = false;
    throw new Error("Refusing outputDir containing an existing status.json; choose a fresh output directory.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  const parsedConfig = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const candidate = validateCandidate(parsedConfig);
  const configSHA = createHash("sha256").update(JSON.stringify(candidate), "utf8").digest("hex");
  state.metadata.configPath = configPath;
  state.metadata.outputDir = outputDir;
  state.metadata.database = "grid_bot_pilot_test on loopback PostgreSQL, disposable only";
  state.metadata.configSHA = configSHA;
  state.metadata.configSHA256 = configSHA;
  state.metadata.startedAt = startedAt;
  state.metadata.frozenRules = {
    rangeControlMode: "static",
    recenterMode: "manual_recenter",
    paperExecutionFeeBps: 10,
    source: "PaperExecutionAdapter.PAPER_EXECUTION_FEE_RATE = 0.001"
  };
  await saveStatus();

  // These overrides are applied before the first import of @grid-bot/common,
  // so getEnv() can still read only the existing .env Jupiter key.
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    ADMIN_USERNAME: "test",
    ADMIN_PASSWORD: "test",
    SESSION_SECRET: "isolated-paper-pilot-session-secret",
    RPC_HTTP_URL: "http://127.0.0.1:1",
    RPC_WS_URL: "ws://127.0.0.1:1",
    EXECUTION_WALLET_SECRET_KEY_PATH: "",
    LIVE_TRADING_ENABLED: "false",
    DISCORD_WEBHOOK_URL: "",
    JUPITER_PRICE_BASE_URL: "https://api.jup.ag/price/v3"
  });

  const requireDb = createRequire(resolve(root, "packages/db/package.json"));
  type PgClient = NonNullable<typeof pgClient>;
  const Client = requireDb("pg").Client as new (options: { connectionString: string }) => PgClient;
  const connectedClient = new Client({ connectionString: databaseUrl });
  pgClient = connectedClient;
  await connectedClient.connect();
  const tables = await connectedClient.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
  assert.equal(tables.rows[0]?.count, 0, "Refusing nonempty database: use a NEW disposable container.");
  const migrationRoot = resolve(root, "packages/db/prisma/migrations");
  const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const migration of migrations) {
    await connectedClient.query(await readFile(resolve(migrationRoot, migration.name, "migration.sql"), "utf8"));
  }

  const common = await import("@grid-bot/common");
  const env = common.getEnv();
  envForRedaction = env;
  assert(env.LIVE_TRADING_ENABLED === false && env.EXECUTION_WALLET_SECRET_KEY_PATH === "" && env.DISCORD_WEBHOOK_URL === "",
    "Paper pilot safety environment was not applied.");
  const core = await import("@grid-bot/core");
  const db = await import("@grid-bot/db");
  prisma = db.prisma;
  botLockPool = db.botLockPool;
  const states = new db.PrismaBotStateRepository();
  const tradeRepository = new db.PrismaTradeRepository();
  const marketPriceService = new core.MarketPriceService({
    apiKey: env.JUPITER_API_KEY,
    baseUrl: "https://api.jup.ag/price/v3",
    timeoutMs: HTTP_TIMEOUT_MS,
    retryDelaysMs: [],
    fetchFn: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== "https://api.jup.ag" || url.pathname !== "/price/v3" || (init?.method ?? "GET") !== "GET") {
        throw new Error("Price observer permits only Jupiter Price V3 GET reads.");
      }
      return fetch(input, { ...init, redirect: "error" });
    }
  });
  // Deliberately provide only the paper adapter. ExecutionService selects it
  // from BotMode.Paper before consulting any provider enum.
  const executionService = new core.ExecutionService({
    [core.ExecutionProvider.Paper]: new core.PaperExecutionAdapter()
  } as never, false);
  const engine = new core.BotEngineService(
    states,
    tradeRepository,
    new db.PrismaPriceSnapshotRepository(),
    new db.PrismaSystemLogRepository(),
    marketPriceService,
    executionService,
    new core.GridStrategyService(),
    new core.RiskManagerService(),
    new core.AlertService(new db.PrismaAlertRepository(), [])
  );

  const botIds = new Map<string, string>();
  const initialCashByBot = new Map<string, number>();
  let botIndex = 0;
  for (const portfolio of candidate.portfolios) {
    for (const allocation of portfolio.allocations) {
      const key = `paper-pilot-${portfolio.id}-${allocation.id}-${botIndex++}`;
      const bot = await prisma.bot.create({ data: {
        key,
        name: `${portfolio.id}/${allocation.id}`,
        baseMint: common.MINTS.SOL,
        quoteMint: common.MINTS.USDC,
        baseSymbol: "SOL",
        quoteSymbol: "USDC",
        baseDecimals: 9,
        quoteDecimals: 6,
        strategyMode: allocation.config.strategyMode,
        mode: core.BotMode.Paper,
        status: "running",
        executionProvider: core.ExecutionProvider.Paper,
        config: { create: dbConfig(allocation.config, {
          defaultAutoRecenterMinIntervalMs: common.DEFAULTS.autoRecenterMinIntervalMs,
          defaultAutoRecenterMaxPerDay: common.DEFAULTS.autoRecenterMaxPerDay
        }) }
      } });
      botIds.set(`${portfolio.id}/${allocation.id}`, bot.id);
      initialCashByBot.set(bot.id, allocation.config.budgetUsd);
    }
  }

  state.status = "running";
  const deadline = Date.now() + durationSeconds * 1_000;
  let stalePeriod: { startedAt: string; endedAt?: string; polls: number; lastReason: string } | undefined;
  let rateLimitCount = 0;
  let backoffUntil = 0;
  while (!stopRequested && Date.now() < deadline) {
    if (backoffUntil > Date.now()) {
      await waitForPoll(Math.min(backoffUntil - Date.now(), Math.max(0, deadline - Date.now())));
      continue;
    }
    state.polls += 1;
    const checkedAt = new Date().toISOString();
    try {
      const marketPrice = await marketPriceService.fetchLatestPrice("SOL", "USDC");
      const freshPrice = marketPriceService.getCachedPrice("SOL", "USDC");
      assert(freshPrice && freshPrice.price === marketPrice.price, "Price service did not publish a fresh SOL/USDC price.");
      rateLimitCount = 0;
      backoffUntil = 0;
      state.freshPriceTicks += 1;
      state.latestPriceStatus = "fresh";
      state.latestPrice = {
        pair: marketPrice.pair,
        price: marketPrice.price,
        checkedAt,
        sourceBlockId: marketPrice.sourceBlockId ?? null,
        quoteSourceBlockId: marketPrice.quoteSourceBlockId ?? null
      };
      await appendPriceObservation({
        checkedAt,
        status: "fresh",
        symbol: marketPrice.symbol,
        pair: marketPrice.pair,
        price: marketPrice.price,
        source: marketPrice.source,
        sourceBlockId: marketPrice.sourceBlockId ?? null,
        quoteSourceBlockId: marketPrice.quoteSourceBlockId ?? null,
        sourceObservedAt: marketPrice.sourceObservedAt?.toISOString() ?? null,
        freshnessBasis: marketPrice.freshnessBasis ?? null
      });
      if (stalePeriod) {
        stalePeriod.endedAt = checkedAt;
        state.stalePeriods.push(stalePeriod);
        stalePeriod = undefined;
      }
      for (const botId of botIds.values()) await engine.runBot(botId);
    } catch (error) {
      const httpStatus = httpStatusOf(error);
      const reason = httpStatus === 401 || httpStatus === 403
        ? `jupiter_http_${httpStatus}`
        : httpStatus === 429 ? "jupiter_http_429_rate_limited"
          : safeErrorMessage(error).toLowerCase().includes("stale") || safeErrorMessage(error).toLowerCase().includes("warming")
            ? "stalled_stale_or_warming_source" : "source_unavailable";
      state.omittedSourceTicks += 1;
      state.latestPriceStatus = "omitted_source";
      if (httpStatus === 429) {
        state.rateLimitedTicks += 1;
        rateLimitCount += 1;
        backoffUntil = Date.now() + Math.min(60_000, 5_000 * (2 ** (rateLimitCount - 1)));
      }
      if (!stalePeriod) stalePeriod = { startedAt: checkedAt, polls: 0, lastReason: reason };
      stalePeriod.polls += 1;
      stalePeriod.lastReason = reason;
      await appendPriceObservation({ checkedAt, status: "omitted_source", sourceStatus: "stalled_or_omitted", reason, httpStatus: httpStatus ?? null });
      if (httpStatus === 401 || httpStatus === 403) requestStop(reason);
      if (httpStatus === 429 && rateLimitCount >= RATE_LIMIT_MAX) requestStop("jupiter_http_429_rate_limit_bound");
    }
    state.portfolios = await portfolioStatus(candidate.portfolios, botIds, initialCashByBot, { states });
    state.portfolioSnapshots += 1;
    await appendPortfolioSnapshot({
      poll: state.polls,
      checkedAt,
      priceStatus: state.latestPriceStatus ?? "omitted_source",
      latestPrice: state.latestPrice ?? null,
      portfolios: state.portfolios
    });
    await saveStatus();
    if (stopRequested) break;
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining <= 0) break;
    const backoffRemaining = Math.max(0, backoffUntil - Date.now());
    await waitForPoll(Math.min(POLL_INTERVAL_MS, backoffRemaining > 0 ? backoffRemaining : POLL_INTERVAL_MS, remaining));
  }
  if (stalePeriod) state.stalePeriods.push({ ...stalePeriod });
  state.stopReason = stopReason ?? "duration_elapsed";
  state.status = stopRequested ? "stopped" : "completed";
  state.completedAt = new Date().toISOString();
  state.metadata.endedAt = state.completedAt;
  await saveStatus();
}

try {
  await main();
} catch (error) {
  state.status = "error";
  state.stopReason = stopReason ?? "fatal_error";
  const httpStatus = httpStatusOf(error);
  state.error = { name: error instanceof Error ? error.name : "Error", message: safeErrorMessage(error), ...(httpStatus === undefined ? {} : { httpStatus }) };
  state.metadata.endedAt = new Date().toISOString();
  if (outputStatusWritable) {
    try {
      await mkdir(outputDir, { recursive: true });
      await saveStatus();
    } catch {
      // Preserve the original failure for the process result; status writes are best effort here.
    }
  }
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", onSigInt);
  process.removeListener("SIGTERM", onSigTerm);
  try { await prisma?.$disconnect(); } catch { /* best effort during shutdown */ }
  try { await botLockPool?.end(); } catch { /* best effort during shutdown */ }
  try { await pgClient?.end(); } catch { /* best effort during shutdown */ }
}
