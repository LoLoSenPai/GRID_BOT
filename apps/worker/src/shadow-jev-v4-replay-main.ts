import { capturedExecutionConstraints } from './shadow-replay-fidelity';
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { ShadowJevV4EvaluationService, type ShadowJevV3EvaluationRequest, type ShadowDecisionCandidateSet } from "@grid-bot/core";
import { createShadowObservationClient, type ShadowObservationClientHandle } from "@grid-bot/db";
import { evaluateStoredShadowV3, parseReplayArgs } from "./shadow-jev-v3-replay-main";

type Client = Pick<ShadowObservationClientHandle["client"], "shadowJevObservation" | "marketCandle"> &
  Partial<Pick<ShadowObservationClientHandle["client"], "execution" | "capitalLedgerEntry">>;
export interface StoredV4ReplayOptions {
  btcReference?: boolean;
  executionFidelity?: boolean;
  comparisonClock?: "recorded_latency" | "matched_next_candle";
}
export async function evaluateStoredShadowV4(client: Client, observationId: string, nativeFeeUsd: number,
  cashflows: Array<{ id: string; at: Date; amountUsd: number }> = [], options: StoredV4ReplayOptions = {}) {
  const observation = await client.shadowJevObservation.findUnique({ where: { id: observationId }, include: { snapshot: true, outbox: true, outcome: true } });
  const censor = (reason: string) => ({ observationId, status: "censored", reasons: [reason] });
  if (!observation || !["shadow-jev-v4", "shadow-jev-v4.1", "shadow-jev-v4.2"].includes(observation.questionSetVersion)) return censor("not_v4_observation");
  const set = observation.candidateSet as unknown as ShadowDecisionCandidateSet;
  const legacy = observation.questionSetVersion === "shadow-jev-v4";
  const reference = observation.questionSetVersion === "shadow-jev-v4.2";
  const referenceMarketObservation = reference && (observation.snapshot.provenance as Record<string, unknown>)?.provider === "coinbase-reference";
  if (set?.version !== (legacy ? "shadow-decisions-v4" : reference ? "shadow-decisions-v4.2" : "shadow-decisions-v4.1") ||
    set.grid?.version !== (legacy ? "shadow-grid-candidates-v3.1" : reference ? "shadow-grid-candidates-v3.3" : "shadow-grid-candidates-v3.2")) return censor("invalid_v4_candidate_version");
  if (!observation.outbox?.completedAt || observation.outbox.status !== "completed") return censor("jev_not_completed");
  const probabilities = observation.outbox.probabilities as { grid_candidate?: { candidate_id?: string }; exit_candidate?: { candidate_id?: string } } | null;
  if (!probabilities?.grid_candidate?.candidate_id || !probabilities.exit_candidate?.candidate_id) return censor("missing_v4_choices");
  const outcome = observation.outcome;
  const context = observation.context as Record<string, any>;
  const referenceAssumption = reference && context?.referenceObserver === true && outcome?.status === "observed_only";
  if (!referenceAssumption && (!outcome?.effectiveDecision || !["wait", "applied", "rejected"].includes(outcome.status))) return censor("missing_effective_engine_outcome");
  const engineDecision = referenceAssumption ? { action: "wait", reason: "No recorded live adaptation at this reference close; fixed initial geometry is assumed.",
    nextLowPrice: null, nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null } : outcome!.effectiveDecision;
  let prepared: ShadowJevV3EvaluationRequest | undefined;
  // Reuse the strict historical source loader, without weakening the V3 replay's provenance checks.
  const adapted = { ...observation, questionSetVersion: legacy ? "shadow-jev-v3.1" : reference ? "shadow-jev-v3.3" : "shadow-jev-v3.2", candidateSet: set.grid };
  const loaded = await evaluateStoredShadowV3({ marketCandle: client.marketCandle,
    execution: client.execution, capitalLedgerEntry: client.capitalLedgerEntry,
    shadowJevObservation: { findUnique: async () => adapted } } as unknown as Client,
    observationId, nativeFeeUsd, input => { prepared = input; }, options.btcReference ?? referenceMarketObservation);
  if (!prepared) return { ...loaded, observationId, reasons: loaded.reasons };
  const fineProvenance = [];
  const markets = [];
  for (const market of prepared.markets) {
    const referenceMarket = market.provider === "coinbase-reference";
    const rows = await client.marketCandle.findMany({ where: { provider: market.provider, symbol: referenceMarket ? "BTC_REF" : market.assetSymbol,
      quoteSymbol: referenceMarket ? "USD" : "USDC", resolution: "5m", sourceMarket: market.sourceMarket,
      openTime: { gte: observation.observedAt, lt: new Date(+observation.observedAt + 24 * 3_600_000) } }, orderBy: { openTime: "asc" } });
    if (rows.some(r => r.provider !== market.provider || r.symbol !== (referenceMarket ? "BTC_REF" : market.assetSymbol) || r.quoteSymbol !== (referenceMarket ? "USD" : "USDC") ||
      r.resolution !== "5m" || r.sourceMarket !== market.sourceMarket || !r.closeTime ||
      +r.closeTime - +r.openTime !== 300_000 || r.fetchedAt < r.closeTime)) return censor("invalid_fine_market_provenance");
    const candles = rows.map(r => ({ timestamp: r.openTime, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    markets.push({ ...market, futureExecutionCandles: candles });
    fineProvenance.push({ symbol: market.assetSymbol, resolution: "5m", rowIds: rows.map(r => r.id) });
  }
  const input = { ...prepared, observation: { ...prepared.observation, candidateSet: set,
    initialEngineDecision: engineDecision }, markets,
    selectedGridCandidateId: probabilities.grid_candidate.candidate_id,
    selectedExitCandidateId: probabilities.exit_candidate.candidate_id,
    decisionAvailableAt: observation.outbox.completedAt, cashflows,
    ...(options.executionFidelity ? { executionFidelity: { model: "rail_one_intent_v1" as const,
      compareOhlcPaths: true, constraintsByBand: capturedExecutionConstraints(prepared) },
      comparisonClock: options.comparisonClock ?? "recorded_latency" } : {}) };
  const evaluation = new ShadowJevV4EvaluationService().evaluate(input);
  if (referenceAssumption) {
    evaluation.policyBaselineSource = "reference_no_adaptation_assumption";
    if (evaluation.executionFidelity && evaluation.executionFidelity.denseRuleSource !== "captured_valid_density") {
      evaluation.executionFidelity.denseRuleSource = "reference_no_adaptation_assumption";
    }
    evaluation.assumptions.push("This independent reference observer has no same-hour live engine outcome. Initial unchanged geometry is an explicit assumption; future deterministic policy uses the exported reference prices.");
  }
  return { observationId, status: evaluation.status, reasons: evaluation.reasons,
    provenance: { ...loaded.provenance, questionSetVersion: observation.questionSetVersion,
      decisionTiming: "after_recorded_response_completion", fineMarkets: fineProvenance,
      initialEngineEvidence: referenceAssumption ? "reference_observer_no_adaptation_assumption" : "recorded_engine_outcome",
      replayInputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex") },
    // Retain the exact public inputs in the exported artifact, not just mutable cache references.
    frozenReplayInput: input, evaluation };
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== "--");
  const replayOptions: StoredV4ReplayOptions = { executionFidelity: true };
  for (const flag of ["--btc-reference", "--matched-clock", "--legacy-fills"]) {
    const i = args.indexOf(flag);
    if (i < 0) continue;
    args.splice(i, 1);
    if (flag === "--btc-reference") replayOptions.btcReference = true;
    else if (flag === "--matched-clock") replayOptions.comparisonClock = "matched_next_candle";
    else replayOptions.executionFidelity = false;
  }
  const index = args.indexOf("--cashflows");
  let cashflows: Array<{ id: string; at: Date; amountUsd: number }> = [];
  if (index >= 0) {
    const file = args[index + 1];
    if (!file) throw new Error("--cashflows requires a JSON file.");
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(raw)) throw new Error("Cashflows must be an array.");
    cashflows = raw.map((r: { id: string; at: string; amountUsd: number }) => ({ ...r, at: new Date(r.at) }));
    args.splice(index, 2);
  }
  const options = parseReplayArgs(args), handle = createShadowObservationClient();
  try {
    const output = await handle.client.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return evaluateStoredShadowV4(tx, options.observationId, options.nativeFeeUsd, cashflows, replayOptions);
    }, { isolationLevel: "RepeatableRead" });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally { await handle.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "V4 replay failed"}\n`); process.exitCode = 1; });
}
