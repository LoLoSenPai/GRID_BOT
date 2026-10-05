import { createHash } from "node:crypto";
import type { ShadowDecisionCandidateSet } from "@grid-bot/core";
import { buildJevV3Request, type ShadowJevV3Input, type ShadowJevV3Request } from "./shadow-jev-v3-questions";

export const v4QuestionSetVersion = "shadow-jev-v4.1" as const;
export const v4ModelRequested = "jev-1.13.0" as const;
type ChoiceQuestion = ShadowJevV3Request["questions"]["grid_candidate"];
export interface ShadowJevV4Request {
  model: typeof v4ModelRequested;
  state: ShadowJevV3Request["state"] & {
    experiment_version: ShadowDecisionCandidateSet["version"];
    observed_cost_profile: ShadowDecisionCandidateSet["costProfile"];
    exit_candidates: Array<{ option: string; family: string; parameters: Record<string, number | string>;
      updates: ShadowDecisionCandidateSet["exit"]["candidates"][number]["updates"] }>;
    recent_5m_candles: Array<{ closed_at: string; open: number; high: number; low: number; close: number }>;
    fine_market_status: string;
  };
  questions: { grid_candidate: ChoiceQuestion; exit_candidate: ChoiceQuestion };
}

/** Frozen inputs only. All model options refer to a separately recorded deterministic plan. */
export function buildJevV4Request(input: Omit<ShadowJevV3Input, "candidateSet"> & {
  candidateSet: ShadowDecisionCandidateSet; fineMarketSnapshot?: { candles: unknown; candleCount: number; provenance: unknown };
}) {
  const set = input.candidateSet;
  if (!["shadow-decisions-v4", "shadow-decisions-v4.1"].includes(set?.version) || set.exit?.version !== "shadow-exits-v1" ||
    !Array.isArray(set.exit.candidates) || set.exit.candidates.length < 1 || set.exit.candidates.length > 3 ||
    set.exit.candidates[0]?.id !== "keep") throw new TypeError("Invalid V4 decision set.");
  const grid = buildJevV3Request({ ...input, candidateSet: set.grid });
  const ordered = [...set.exit.candidates];
  const questionVersion = set.version === "shadow-decisions-v4" ? "shadow-jev-v4" : v4QuestionSetVersion;
  const seed = createHash("sha256").update([questionVersion, grid.request.state.observed_at,
    input.policyInput.band.id, "exits"].join("|")).digest();
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = seed[i]! % (i + 1);
    [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
  }
  const exitOptionToCandidateId: Record<string, string> = { abstain: "abstain" };
  const exitCriteria: Record<string, string> = {};
  const ids = new Set<string>();
  const exitCandidates = ordered.map((candidate, i) => {
    if (!candidate.id || ids.has(candidate.id) || !Array.isArray(candidate.updates)) throw new TypeError("Invalid V4 exit candidate.");
    ids.add(candidate.id);
    const option = `exit_${i}`;
    exitOptionToCandidateId[option] = candidate.id;
    for (const update of candidate.updates) {
      if (!update.sourceLotId || !update.bandId || ![update.oldTargetPrice, update.newTargetPrice,
        update.costQuote, update.remainingBaseAmount, update.minimumNetGainUsd, update.minimumRetainedBaseAmount]
        .every(v => Number.isFinite(v) && v >= 0) || update.newTargetPrice <= 0 ||
        !["accumulate_base", "accumulate_usdc"].includes(update.economicRule)) throw new TypeError("Invalid V4 exit update.");
    }
    exitCriteria[option] = `${candidate.kind}: ${candidate.updates.length} lot exit changes, subject to their recorded net-profit and retained-token floors. See exit_candidates for exact targets.`;
    return { option, family: candidate.kind, parameters: candidate.strategyParameters, updates: candidate.updates };
  });
  exitCriteria.abstain = "Evidence does not justify changing existing exits; retain the current commitments.";
  const fine = projectFineMarket(input.fineMarketSnapshot, +new Date(grid.request.state.observed_at),
    grid.request.state.asset_symbol);
  const request: ShadowJevV4Request = { model: v4ModelRequested,
    state: { ...grid.request.state, experiment_version: set.version, observed_cost_profile: set.costProfile,
      exit_candidates: exitCandidates, recent_5m_candles: fine.candles, fine_market_status: fine.status },
    questions: {
      grid_candidate: { ...grid.request.questions.grid_candidate,
        instructions: { ...grid.request.questions.grid_candidate.instructions,
          question: "Which recorded entry-grid plan is best suited to farming future oscillations over the next 24 hours, given actual inventory, available reserve and costs?",
          evidence_boundary: "Use only recorded closed candles and captured state. Experimental shadow admission is not live approval. The reserve is existing capital, not free extra money. Compare at identical total capital. Existing lot exits are handled by the separate exit question. Choice probabilities are preferences, not probabilities of profit." } },
      exit_candidate: { type: "choice", criteria: exitCriteria,
        instructions: { question: "Which recorded plan for the existing lots' sale targets best balances future net cycles, time immobilised and inventory exposure?",
          horizon: "Next 24 hours, with measurements at 1, 3, 6 and 24 hours after the observation.",
          evidence_boundary: "Only past closed candles and captured lot economics are evidence. Apply changes after the response is available, never retroactively. More cycles alone are not an improvement. Abstain if the data or cost coverage cannot distinguish plans.",
          objective: input.objective === "accumulate_base" ? "BTC: recover lot capital after all costs and retain meaningful BTC; include cash and all held inventory in total value."
            : "SOL: generate net USDC from oscillations while including all held SOL in total value." } },
    } };
  const gridOptionToCandidateId: Record<string, string> = { ...grid.optionToCandidateId, abstain: "abstain" };
  return { request, gridOptionToCandidateId, exitOptionToCandidateId };
}

function projectFineMarket(snapshot: Parameters<typeof buildJevV4Request>[0]["fineMarketSnapshot"],
  observedAt: number, symbol: string) {
  if (!snapshot) return { candles: [], status: "missing_at_capture" };
  const meta = snapshot.provenance as Record<string, unknown>;
  if (!meta || meta.resolution !== "5m" || meta.symbol !== symbol || meta.quoteSymbol !== "USDC" ||
    !Array.isArray(snapshot.candles) || snapshot.candleCount !== snapshot.candles.length) throw new TypeError("Invalid fine market snapshot.");
  const candles = snapshot.candles.slice(-24).map((raw: unknown) => {
    const c = raw as Record<string, unknown>;
    const closeAt = Date.parse(String(c.closedAt)), openAt = Date.parse(String(c.openedAt));
    if (!Number.isFinite(closeAt) || closeAt > observedAt || closeAt - openAt !== 300_000 ||
      ![c.open, c.high, c.low, c.close].every(v => typeof v === "number" && Number.isFinite(v) && v > 0) ||
      Number(c.high) < Math.max(Number(c.open), Number(c.close)) || Number(c.low) > Math.min(Number(c.open), Number(c.close))) {
      throw new TypeError("Invalid or future fine candle.");
    }
    return { closed_at: new Date(closeAt).toISOString(), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) };
  });
  if (candles.some((c, i) => i > 0 && Date.parse(c.closed_at) - Date.parse(candles[i - 1]!.closed_at) !== 300_000)) {
    throw new TypeError("Discontinuous fine candles.");
  }
  return { candles, status: candles.length ? `closed_through:${candles.at(-1)!.closed_at}` : "empty_at_capture" };
}
