import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { GECKOTERMINAL_POOLS, MINTS } from "@grid-bot/common";
import { ShadowJevV3EvaluationService, type HistoricalCandle, type ShadowJevV3EvaluationRequest, type ShadowInventoryEvidence, type ShadowBandCapitalEvidence } from "@grid-bot/core";
import { createShadowObservationClient, type ShadowObservationClientHandle } from "@grid-bot/db";

const HOUR_MS = 3_600_000;
const WARMUP_HOURS = 80;
const HORIZON_HOURS = 24;
const SYMBOLS = ["BTC", "SOL"] as const;
type SymbolName = typeof SYMBOLS[number];
type ReadClient = Pick<ShadowObservationClientHandle["client"], "shadowJevObservation" | "marketCandle"> &
  Partial<Pick<ShadowObservationClientHandle["client"], "execution" | "capitalLedgerEntry">>;

interface ReplayOutput {
  observationId: string;
  status: "evaluated" | "partial" | "censored";
  reasons: string[];
  provenance: Record<string, unknown>;
  evaluation?: ReturnType<ShadowJevV3EvaluationService["evaluate"]>;
}

/** Reads the immutable observation and cached candles only. No market or Jev client is constructed. */
export async function evaluateStoredShadowV3(client: ReadClient, observationId: string,
  nativeFeeUsd: number, onPrepared?: (input: ShadowJevV3EvaluationRequest) => void): Promise<ReplayOutput> {
  const observation = await client.shadowJevObservation.findUnique({
    where: { id: observationId }, include: { snapshot: true, outbox: true },
  });
  const provenance: Record<string, unknown> = { observationId, readAt: new Date().toISOString(),
    futureDataSource: "market_candles_cache", networkFetch: false };
  const censor = (...reasons: string[]): ReplayOutput => ({ observationId, status: "censored", reasons, provenance });
  if (!observation) return censor("observation_not_found");
  provenance.observationHash = observation.observationHash;
  provenance.snapshotId = observation.snapshotId;
  provenance.marketContentHash = observation.snapshot.contentHash;
  provenance.observedAt = observation.observedAt.toISOString();
  provenance.questionSetVersion = observation.questionSetVersion;
  provenance.modelRequested = observation.modelRequested;
  provenance.decisionTiming = "hypothetical_at_candle_close";
  provenance.jevCompletedAt = observation.outbox?.completedAt?.toISOString() ?? null;
  provenance.jevLatencyMs = observation.outbox?.latencyMs ?? null;
  const expectedCandidateVersion = observation.questionSetVersion === "shadow-jev-v3.2"
    ? "shadow-grid-candidates-v3.2" : observation.questionSetVersion === "shadow-jev-v3.1"
    ? "shadow-grid-candidates-v3.1" : observation.questionSetVersion === "shadow-jev-v3"
      ? "shadow-grid-candidates-v3" : null;
  if (!expectedCandidateVersion) return censor("not_v3_observation");
  if (object(observation.candidateSet)?.version !== expectedCandidateVersion) {
    return censor("question_candidate_version_mismatch");
  }
  if (!observation.outbox?.terminal || observation.outbox.status !== "completed") return censor("jev_not_completed");
  const context = object(observation.context);
  const replay = object(context?.shadowReplayV3);
  const portfolio = object(replay?.portfolio);
  const strategies = Array.isArray(replay?.strategies) ? replay.strategies : null;
  const snapshotMeta = object(observation.snapshot.provenance);
  const marketMeta = object(observation.marketMeta);
  if (!replay || replay.schemaVersion !== "shadow-replay-v3" || !portfolio || !strategies ||
    object(replay.source)?.portfolioVersion !== portfolio.version) return censor("invalid_portfolio_snapshot");
  if (!snapshotMeta || !marketMeta || !sameMarket(snapshotMeta, marketMeta) ||
    observation.snapshot.candleCount !== (Array.isArray(observation.snapshot.candles)
      ? observation.snapshot.candles.length : -1)) return censor("invalid_market_snapshot");
  if (snapshotMeta.provider !== "gecko-terminal" || snapshotMeta.resolution !== "1h" ||
    snapshotMeta.quoteSymbol !== "USDC" || portfolio.quoteMint !== MINTS.USDC) {
    return censor("unsupported_market_identity");
  }
  const targetSymbol = snapshotMeta.symbol;
  if (targetSymbol !== "BTC" && targetSymbol !== "SOL") return censor("unsupported_target_asset");
  const targetPool = poolFor(targetSymbol);
  if (snapshotMeta.sourceMarket !== targetPool) return censor("target_source_market_mismatch");
  const selectedCandidateId = object(object(observation.outbox.probabilities)?.grid_candidate)?.candidate_id;
  if (typeof selectedCandidateId !== "string" || !selectedCandidateId) return censor("missing_jev_candidate");

  const snapshotCandles = parseSnapshotCandles(observation.snapshot.candles, observation.observedAt);
  if (!snapshotCandles) return censor("invalid_or_discontinuous_observed_candles");
  const policy = object(observation.policyInput);
  const parameters = object(policy?.parameters);
  if (!parameters) return censor("missing_policy_parameters");
  const feeBps = finiteNonnegative(parameters.estimatedExecutionFeeBps);
  const slippageBps = finiteNonnegative(parameters.estimatedSlippageBps);
  if (feeBps === null || slippageBps === null) return censor("invalid_cost_assumptions");
  if (!Number.isFinite(nativeFeeUsd) || nativeFeeUsd <= 0) return censor("native_fee_estimate_required");

  const markets = [];
  const marketProvenance = [];
  for (const symbol of SYMBOLS) {
    const strategy = strategies.map(object).find(item => item?.baseSymbol === symbol);
    const bands = Array.isArray(strategy?.bands) ? strategy.bands.map(object).filter(Boolean) : [];
    if (!strategy || strategy.baseMint !== MINTS[symbol] || bands.length === 0 || bands.some(band => {
      const bot = object(band?.bot);
      return !bot || bot.baseMint !== MINTS[symbol] || bot.quoteMint !== MINTS.USDC;
    })) return censor(`invalid_${symbol.toLowerCase()}_mint_or_band`);
    const pool = poolFor(symbol);
    const rows = await client.marketCandle.findMany({ where: {
      provider: "gecko-terminal", symbol, quoteSymbol: "USDC", resolution: "1h",
      openTime: { gte: new Date(+observation.observedAt - WARMUP_HOURS * HOUR_MS),
        lt: new Date(+observation.observedAt + HORIZON_HOURS * HOUR_MS) },
    }, orderBy: { openTime: "asc" } });
    if (rows.some(row => row.sourceMarket !== pool || !row.closeTime ||
      +row.closeTime !== +row.openTime + HOUR_MS || +row.fetchedAt < +row.closeTime)) {
      return censor(`invalid_${symbol.toLowerCase()}_cache_provenance`);
    }
    const warmup = symbol === targetSymbol ? snapshotCandles : contiguousSuffix(
      rows.filter(row => +row.openTime < +observation.observedAt).map(candleFromRow),
      +observation.observedAt, WARMUP_HOURS);
    if (warmup.length < 20 || +warmup.at(-1)!.timestamp + HOUR_MS !== +observation.observedAt) {
      return censor(`insufficient_${symbol.toLowerCase()}_warmup`);
    }
    const future = contiguousPrefix(rows.filter(row => +row.openTime >= +observation.observedAt)
      .map(candleFromRow), +observation.observedAt, HORIZON_HOURS);
    if (future.length === 0) return censor(`missing_${symbol.toLowerCase()}_future`);
    markets.push({ assetSymbol: symbol, baseMint: MINTS[symbol], quoteMint: MINTS.USDC,
      provider: "gecko-terminal", sourceMarket: pool,
      inputId: symbol === targetSymbol ? observation.snapshot.contentHash :
        `market-candles:${symbol}:${rows.filter(row => warmup.some(candle => +candle.timestamp === +row.openTime))
          .map(row => row.id).join(",")}`,
      warmupCandles: warmup, futureCandles: future });
    marketProvenance.push({ symbol, provider: "gecko-terminal", sourceMarket: pool,
      baseMint: MINTS[symbol], quoteMint: MINTS.USDC, warmupCount: warmup.length, futureCount: future.length,
      firstFutureOpen: future[0]!.timestamp.toISOString(), lastFutureOpen: future.at(-1)!.timestamp.toISOString(),
      cacheRowIds: rows.filter(row => +row.openTime >= +observation.observedAt &&
        +row.openTime <= +future.at(-1)!.timestamp).map(row => row.id) });
  }
  provenance.markets = marketProvenance;
  provenance.costInputs = { feeBps, slippageBps, nativeFeeUsd,
    feeAndSlippageSource: "frozen_policy_input_parameters",
    nativeFeeSource: "explicit_cli_estimate_per_trade" };
  provenance.mintEvidence = "Portfolio bot/strategy mints checked against configured Solana mints; cache rows do not attest pool token mints.";
  provenance.nonTargetWarmupAvailability = "not_attested_at_t0; reconstructed_from_later_cache";
  try {
    const inventoryEvidence = await loadShadowInventoryEvidence(client, strategies);
    const capitalEvidence = await loadShadowCapitalEvidence(client, strategies, String(portfolio.id), observation.observedAt);
    provenance.inventoryEvidence = { source: "reconstructed_after_capture", exhaustiveQuery: !!client.execution,
      hash: createHash("sha256").update(JSON.stringify(inventoryEvidence)).digest("hex"),
      scope: "all_bot_executions_through_position_state", extractedAt: inventoryEvidence[0]?.extractedAt ?? null,
      warning: "Persisted receipts attest compatibility; the hash does not prove completeness or exclude past operator repairs." };
    provenance.capitalEvidence = { source: "reconstructed_after_capture", exhaustiveQuery: !!client.capitalLedgerEntry,
      hash: createHash("sha256").update(JSON.stringify(capitalEvidence)).digest("hex"), scope: "all_band_entries_through_state" };
    const replayInput: ShadowJevV3EvaluationRequest = { observation: {
      observedAt: observation.observedAt, bandId: observation.bandId, context: observation.context,
      candidateSet: observation.candidateSet, proposedDecision: observation.proposedDecision,
      policyInput: observation.policyInput,
    }, selectedCandidateId, markets, feeBps, slippageBps, nativeFeeUsd, inventoryEvidence, capitalEvidence };
    onPrepared?.(replayInput);
    const evaluation = new ShadowJevV3EvaluationService().evaluate(replayInput);
    return { observationId, status: evaluation.status, reasons: evaluation.reasons, provenance, evaluation };
  } catch (error) {
    return censor(`replay_invalid:${error instanceof Error ? error.message : "unknown"}`);
  }
}

/** Exhaustive persisted executions, including failure/unknown statuses. No network or state mutation. */
export async function loadShadowInventoryEvidence(client: ReadClient, strategies: unknown[]): Promise<ShadowInventoryEvidence[]> {
  if (!client.execution) return [];
  const evidence: ShadowInventoryEvidence[] = [], extractedAt = new Date().toISOString();
  for (const strategyValue of strategies) {
    const strategy = object(strategyValue);
    for (const rawBand of Array.isArray(strategy?.bands) ? strategy.bands : []) {
      const bot = object(object(rawBand)?.bot), position = object(bot?.position);
      if (!bot || !position || typeof bot.id !== "string" || !["live", "paper"].includes(String(bot.mode)) ||
        typeof bot.createdAt !== "string" || typeof position.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(position.updatedAt))) throw new Error("Invalid receipt extraction boundary.");
      // No status filter, LIMIT, or start-date truncation: each bot's full history through its frozen state.
      const rows = await client.execution.findMany({ where: { botId: bot.id,
        createdAt: { lte: new Date(position.updatedAt) } }, include: { order: { select: { side: true, botId: true } } },
        orderBy: [{ completedAt: "asc" }, { id: "asc" }] });
      if (rows.some(row => row.order.botId !== bot.id)) throw new Error("Execution/order bot mismatch.");
      evidence.push({ version: "ordered-receipts-v1", scope: "all_bot_executions_through_position_state",
        botId: bot.id, mode: bot.mode as "live" | "paper", baseMint: String(bot.baseMint), quoteMint: String(bot.quoteMint),
        botCreatedAt: bot.createdAt, stateAt: position.updatedAt, extractedAt,
        rows: rows.map(row => ({ id: row.id, botId: row.botId, mode: row.mode, side: row.order.side,
          status: row.status, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
          executedInputAmount: row.executedInputAmount?.toString() ?? null,
          executedOutputAmount: row.executedOutputAmount?.toString() ?? null })) });
    }
  }
  return evidence;
}

export async function loadShadowCapitalEvidence(client: ReadClient, strategies: unknown[], portfolioId: string,
  observedAt: Date): Promise<ShadowBandCapitalEvidence[]> {
  if (!client.capitalLedgerEntry) return [];
  const evidence: ShadowBandCapitalEvidence[] = [], extractedAt = new Date().toISOString();
  for (const value of strategies) for (const raw of Array.isArray(object(value)?.bands) ? object(value)!.bands as unknown[] : []) {
    const band = object(raw); if (!band || typeof band.id !== "string") throw new Error("Invalid ledger band.");
    const rows = await client.capitalLedgerEntry.findMany({ where: { bandId: band.id, createdAt: { lte: observedAt } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    evidence.push({ version: "band-ledger-v1", scope: "all_band_entries_through_state", bandId: band.id, portfolioId,
      stateAt: observedAt.toISOString(), extractedAt, rows: rows.map(row => ({ id: row.id, portfolioId: row.portfolioId,
        bandId: row.bandId!, entryType: row.entryType, createdAt: row.createdAt.toISOString(), executionId: row.executionId,
        allocatedDelta: row.bandAllocatedQuoteDelta.toString(), availableDelta: row.bandAvailableQuoteDelta.toString(),
        deployedDelta: row.bandDeployedCostDelta.toString(), reservedDelta: row.bandReservedQuoteDelta.toString(),
        externalFeeDelta: row.externalFeeQuoteDelta.toString(), metadata: row.metadata })) });
  }
  return evidence;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function sameMarket(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return ["provider", "symbol", "quoteSymbol", "resolution", "sourceMarket"]
    .every(key => (left[key] ?? null) === (right[key] ?? null));
}
function poolFor(symbol: SymbolName): string {
  return `solana:${symbol === "BTC" ? GECKOTERMINAL_POOLS.BTC_USDC : GECKOTERMINAL_POOLS.SOL_USDC}`;
}
function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function candleFromRow(row: { openTime: Date; open: { toNumber(): number }; high: { toNumber(): number };
  low: { toNumber(): number }; close: { toNumber(): number } }): HistoricalCandle {
  return { timestamp: row.openTime, open: row.open.toNumber(), high: row.high.toNumber(),
    low: row.low.toNumber(), close: row.close.toNumber() };
}
function parseSnapshotCandles(raw: unknown, observedAt: Date): HistoricalCandle[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed: HistoricalCandle[] = [];
  for (const item of raw) {
    const candle = object(item);
    if (!candle || typeof candle.openedAt !== "string" || typeof candle.closedAt !== "string") return null;
    const timestamp = new Date(candle.openedAt);
    const closedAt = new Date(candle.closedAt);
    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (!Number.isFinite(+timestamp) || +closedAt !== +timestamp + HOUR_MS ||
      prices.some(price => typeof price !== "number" || !Number.isFinite(price) || price <= 0)) return null;
    parsed.push({ timestamp, open: candle.open as number, high: candle.high as number,
      low: candle.low as number, close: candle.close as number });
  }
  return parsed.length >= 20 && +parsed.at(-1)!.timestamp + HOUR_MS === +observedAt &&
    parsed.every((candle, index) => index === 0 || +candle.timestamp === +parsed[index - 1]!.timestamp + HOUR_MS)
    ? parsed : null;
}
function contiguousSuffix(candles: HistoricalCandle[], endMs: number, limit: number): HistoricalCandle[] {
  const result: HistoricalCandle[] = [];
  for (let index = candles.length - 1; index >= 0 && result.length < limit; index--) {
    const candle = candles[index]!;
    if (+candle.timestamp !== endMs - (result.length + 1) * HOUR_MS) break;
    result.unshift(candle);
  }
  return result;
}
function contiguousPrefix(candles: HistoricalCandle[], startMs: number, limit: number): HistoricalCandle[] {
  const result: HistoricalCandle[] = [];
  for (const candle of candles) {
    if (result.length === limit || +candle.timestamp !== startMs + result.length * HOUR_MS) break;
    result.push(candle);
  }
  return result;
}

export function parseReplayArgs(rawArgs: string[]): { observationId: string; nativeFeeUsd: number } {
  // pnpm passes the separator through to the script; direct tsx execution does not.
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const feeIndex = args.indexOf("--native-fee-usd");
  const idIndex = args.indexOf("--observation-id");
  const nativeFeeUsd = feeIndex >= 0 ? Number(args[feeIndex + 1]) : Number.NaN;
  if (args.length !== 4 || idIndex < 0 || feeIndex < 0 || !args[idIndex + 1] ||
    !Number.isFinite(nativeFeeUsd) || nativeFeeUsd <= 0) {
    throw new Error("Usage: pnpm --filter @grid-bot/worker shadow:replay:v3 -- --observation-id <id> --native-fee-usd <positive estimate>");
  }
  return { observationId: args[idIndex + 1]!, nativeFeeUsd };
}

async function main(): Promise<void> {
  const { observationId, nativeFeeUsd } = parseReplayArgs(process.argv.slice(2));
  const handle = createShadowObservationClient();
  try {
    const result = await handle.client.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return evaluateStoredShadowV3(tx, observationId, nativeFeeUsd);
    }, { isolationLevel: "RepeatableRead" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
