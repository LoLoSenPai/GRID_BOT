import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { ShadowJevV4EvaluationService, type ShadowJevV3EvaluationRequest, type ShadowDecisionCandidateSet } from "@grid-bot/core";
import { createShadowObservationClient, type ShadowObservationClientHandle } from "@grid-bot/db";
import { evaluateStoredShadowV3, parseReplayArgs } from "./shadow-jev-v3-replay-main";

type Client = Pick<ShadowObservationClientHandle["client"], "shadowJevObservation" | "marketCandle">;
export async function evaluateStoredShadowV4(client: Client, observationId: string, nativeFeeUsd: number,
  cashflows: Array<{ id: string; at: Date; amountUsd: number }> = []) {
  const observation = await client.shadowJevObservation.findUnique({ where: { id: observationId }, include: { snapshot: true, outbox: true } });
  const censor = (reason: string) => ({ observationId, status: "censored", reasons: [reason] });
  if (!observation || observation.questionSetVersion !== "shadow-jev-v4") return censor("not_v4_observation");
  const set = observation.candidateSet as unknown as ShadowDecisionCandidateSet;
  if (set?.version !== "shadow-decisions-v4") return censor("invalid_v4_candidate_version");
  if (!observation.outbox?.completedAt || observation.outbox.status !== "completed") return censor("jev_not_completed");
  const probabilities = observation.outbox.probabilities as { grid_candidate?: { candidate_id?: string }; exit_candidate?: { candidate_id?: string } } | null;
  if (!probabilities?.grid_candidate?.candidate_id || !probabilities.exit_candidate?.candidate_id) return censor("missing_v4_choices");
  let prepared: ShadowJevV3EvaluationRequest | undefined;
  // Reuse the strict historical source loader, without weakening the V3 replay's provenance checks.
  const adapted = { ...observation, questionSetVersion: "shadow-jev-v3.1", candidateSet: set.grid };
  const loaded = await evaluateStoredShadowV3({ marketCandle: client.marketCandle,
    shadowJevObservation: { findUnique: async () => adapted } } as unknown as Client,
    observationId, nativeFeeUsd, input => { prepared = input; });
  if (!prepared) return { ...loaded, observationId, reasons: loaded.reasons };
  const fineProvenance = [];
  const markets = [];
  for (const market of prepared.markets) {
    const rows = await client.marketCandle.findMany({ where: { provider: market.provider, symbol: market.assetSymbol,
      quoteSymbol: "USDC", resolution: "5m", sourceMarket: market.sourceMarket,
      openTime: { gte: observation.observedAt, lt: new Date(+observation.observedAt + 24 * 3_600_000) } }, orderBy: { openTime: "asc" } });
    if (rows.some(r => r.provider !== market.provider || r.symbol !== market.assetSymbol || r.quoteSymbol !== "USDC" ||
      r.resolution !== "5m" || r.sourceMarket !== market.sourceMarket || !r.closeTime ||
      +r.closeTime - +r.openTime !== 300_000 || r.fetchedAt < r.closeTime)) return censor("invalid_fine_market_provenance");
    const candles = rows.map(r => ({ timestamp: r.openTime, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    markets.push({ ...market, futureExecutionCandles: candles });
    fineProvenance.push({ symbol: market.assetSymbol, resolution: "5m", rowIds: rows.map(r => r.id) });
  }
  const input = { ...prepared, observation: { ...prepared.observation, candidateSet: set }, markets,
    selectedGridCandidateId: probabilities.grid_candidate.candidate_id,
    selectedExitCandidateId: probabilities.exit_candidate.candidate_id,
    decisionAvailableAt: observation.outbox.completedAt, cashflows };
  const evaluation = new ShadowJevV4EvaluationService().evaluate(input);
  return { observationId, status: evaluation.status, reasons: evaluation.reasons,
    provenance: { ...loaded.provenance, questionSetVersion: observation.questionSetVersion,
      decisionTiming: "after_recorded_response_completion", fineMarkets: fineProvenance,
      replayInputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex") },
    // Retain the exact public inputs in the exported artifact, not just mutable cache references.
    frozenReplayInput: input, evaluation };
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== "--");
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
      return evaluateStoredShadowV4(tx, options.observationId, options.nativeFeeUsd, cashflows);
    }, { isolationLevel: "RepeatableRead" });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally { await handle.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "V4 replay failed"}\n`); process.exitCode = 1; });
}
