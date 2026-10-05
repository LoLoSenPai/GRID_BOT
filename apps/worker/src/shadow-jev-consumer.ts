import type {
  ClaimShadowJevJobsInput,
  CompleteShadowJevJobInput,
  FailShadowJevJobInput,
  ShadowJevClaim,
} from "@grid-bot/db";
import type { PortfolioPolicyInput, ShadowGridCandidateSet, ShadowDecisionCandidateSet } from "@grid-bot/core";
import { buildJevV4Request, v4QuestionSetVersion, v4ModelRequested, type ShadowJevV4Request } from "./shadow-jev-v4-questions";
import { evaluateJevV4 } from "./shadow-jev-v4-client";

import { evaluateJev, type JevClient, type ShadowJevEvaluation } from "./shadow-jev-client";
import { buildJevRequest, modelRequested, questionSetVersion, type ShadowJevRequest } from "./shadow-jev-questions";
import { evaluateJevV2 } from "./shadow-jev-v2-client";
import { buildJevV2Request, v2ModelRequested, v2QuestionSetVersion,
  type ShadowJevV2Request } from "./shadow-jev-v2-questions";
import { evaluateJevV3 } from "./shadow-jev-v3-client";
import { buildJevV3Request, currentV3QuestionSetVersion, v3ModelRequested, v3QuestionSetVersion,
  type ShadowJevV3Request } from "./shadow-jev-v3-questions";

export interface ShadowJevOutboxStore {
  claim(input: ClaimShadowJevJobsInput): Promise<ShadowJevClaim[]>;
  complete(input: CompleteShadowJevJobInput): Promise<void>;
  fail(input: FailShadowJevJobInput): Promise<void>;
}

const LEASE_MS = 45_000;
const EVALUATION_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;

/** This consumer has no reference to the trading engine or portfolio mutation store. */
export class ShadowJevConsumer {
  constructor(private readonly outbox: ShadowJevOutboxStore, private readonly client: JevClient,
    private readonly workerId: string) {}

  async processOne(): Promise<boolean> {
    const [job] = await this.outbox.claim({ workerId: this.workerId, limit: 1, leaseMs: LEASE_MS });
    if (!job) return false;
    await this.processClaim(job);
    return true;
  }

  private async processClaim(job: ShadowJevClaim): Promise<void> {
    let request: ShadowJevRequest | ShadowJevV2Request | ShadowJevV3Request | ShadowJevV4Request | undefined;
    const startedAt = performance.now();
    try {
      if (job.questionSetVersion === questionSetVersion && job.modelRequested === modelRequested) {
        request = buildJevRequest({ observedAt: job.observation.observedAt,
          policyInput: restorePolicyInput(job), strategy: readStrategy(job.observation.context) });
        const result = await evaluateJev(request, this.client, { timeoutMs: EVALUATION_TIMEOUT_MS });
        await this.outbox.complete({ jobId: job.jobId, workerId: this.workerId, rawRequest: request,
          rawResponse: result.rawResponse, probabilities: fullProbabilities(result),
          modelVersion: result.modelResolved, latencyMs: elapsedMs(startedAt) });
      } else if (job.questionSetVersion === v2QuestionSetVersion && job.modelRequested === v2ModelRequested) {
        const prepared = buildJevV2Request({ observedAt: job.observation.observedAt,
          policyInput: restorePolicyInput(job), objective: readV2Objective(job.observation.context),
          candidateSet: job.observation.candidateSet as ShadowGridCandidateSet });
        request = prepared.request;
        const result = await evaluateJevV2(request, this.client, { timeoutMs: EVALUATION_TIMEOUT_MS });
        const candidateProbabilities = Object.fromEntries(Object.entries(result.probabilities)
          .map(([option, probability]) => [prepared.optionToCandidateId[option] ?? option, probability]));
        await this.outbox.complete({ jobId: job.jobId, workerId: this.workerId, rawRequest: request,
          rawResponse: result.rawResponse, probabilities: { grid_candidate: {
            option: result.choice, candidate_id: prepared.optionToCandidateId[result.choice] ?? null,
            probabilities: candidateProbabilities, option_probabilities: result.probabilities,
            confidence: result.confidence } },
          modelVersion: result.modelResolved, latencyMs: elapsedMs(startedAt) });
      } else if ((job.questionSetVersion === v3QuestionSetVersion ||
        job.questionSetVersion === "shadow-jev-v3.1" || job.questionSetVersion === currentV3QuestionSetVersion) && job.modelRequested === v3ModelRequested) {
        const candidateSet = job.observation.candidateSet as ShadowGridCandidateSet;
        const expectedCandidateVersion = job.questionSetVersion === currentV3QuestionSetVersion
          ? "shadow-grid-candidates-v3.2" : job.questionSetVersion === "shadow-jev-v3.1"
          ? "shadow-grid-candidates-v3.1" : "shadow-grid-candidates-v3";
        if (candidateSet?.version !== expectedCandidateVersion) {
          throw new Error("V3 shadow question and candidate-set versions do not match.");
        }
        const prepared = buildJevV3Request({ observedAt: job.observation.observedAt,
          stateReadAt: readV3StateReadAt(job.observation.context),
          policyInput: restorePolicyInput(job), objective: readV2Objective(job.observation.context),
          candidateSet });
        request = prepared.request;
        const result = await evaluateJevV3(prepared.request, this.client, { timeoutMs: EVALUATION_TIMEOUT_MS });
        const candidateProbabilities = Object.fromEntries(Object.entries(result.probabilities)
          .map(([option, probability]) => [prepared.optionToCandidateId[option] ?? option, probability]));
        await this.outbox.complete({ jobId: job.jobId, workerId: this.workerId, rawRequest: request,
          rawResponse: result.rawResponse, probabilities: { grid_candidate: {
            option: result.choice, candidate_id: prepared.optionToCandidateId[result.choice] ?? null,
            probabilities: candidateProbabilities, option_probabilities: result.probabilities,
            confidence: result.confidence } },
          modelVersion: result.modelResolved, latencyMs: elapsedMs(startedAt) });
      } else if (["shadow-jev-v4", v4QuestionSetVersion].includes(job.questionSetVersion) && job.modelRequested === v4ModelRequested) {
        const set = job.observation.candidateSet as ShadowDecisionCandidateSet;
        const legacy = job.questionSetVersion === "shadow-jev-v4";
        if (set?.version !== (legacy ? "shadow-decisions-v4" : "shadow-decisions-v4.1") ||
          set.grid?.version !== (legacy ? "shadow-grid-candidates-v3.1" : "shadow-grid-candidates-v3.2")) {
          throw new Error("V4 shadow question and candidate-set versions do not match.");
        }
        const prepared = buildJevV4Request({ observedAt: job.observation.observedAt,
          stateReadAt: readV3StateReadAt(job.observation.context), policyInput: restorePolicyInput(job),
          objective: readV2Objective(job.observation.context), candidateSet: job.observation.candidateSet as ShadowDecisionCandidateSet,
          fineMarketSnapshot: job.observation.fineMarketSnapshot });
        request = prepared.request;
        const result = await evaluateJevV4(prepared.request, this.client, { timeoutMs: EVALUATION_TIMEOUT_MS });
        const probabilities = Object.fromEntries((["grid_candidate", "exit_candidate"] as const).map(id => {
          const answer = result.answers[id];
          const mapping: Record<string, string> = id === "grid_candidate" ? prepared.gridOptionToCandidateId : prepared.exitOptionToCandidateId;
          return [id, { option: answer.choice, candidate_id: mapping[answer.choice],
            probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([k, p]) => [mapping[k] ?? k, p])),
            option_probabilities: answer.probabilities, confidence: answer.confidence }];
        }));
        await this.outbox.complete({ jobId: job.jobId, workerId: this.workerId, rawRequest: request,
          rawResponse: result.rawResponse, probabilities, modelVersion: result.modelResolved, latencyMs: elapsedMs(startedAt) });
      } else {
        throw new Error(`Unsupported shadow question/model version: ${job.questionSetVersion}/${job.modelRequested}`);
      }
    } catch (error) {
      const terminal = job.attemptCount >= MAX_ATTEMPTS || !request;
      const retryAt = terminal ? undefined : new Date(Date.now() + retryDelayMs(job.attemptCount));
      await this.outbox.fail({ jobId: job.jobId, workerId: this.workerId,
        error: { code: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message.slice(0, 2048) : "Unknown Jev error" },
        rawRequest: request, rawResponse: readRawResponse(error),
        latencyMs: elapsedMs(startedAt), retryAt, terminal });
    }
  }
}

function restorePolicyInput(job: ShadowJevClaim): PortfolioPolicyInput {
  const input = record(job.observation.policyInput, "observation.policyInput");
  const candles = job.observation.marketSnapshot.candles;
  if (!Array.isArray(candles) || candles.length !== job.observation.marketSnapshot.candleCount) {
    throw new Error("Market snapshot candle count is inconsistent.");
  }
  return { ...input, candles } as unknown as PortfolioPolicyInput;
}

function readStrategy(context: unknown): { objective?: string | null } | undefined {
  if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
  const strategy = (context as Record<string, unknown>).strategy;
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) return undefined;
  const objective = (strategy as Record<string, unknown>).objective;
  return typeof objective === "string" ? { objective } : undefined;
}

function readV2Objective(context: unknown): "accumulate_base" | "accumulate_usdc" {
  const objective = readStrategy(context)?.objective;
  if (objective !== "accumulate_base" && objective !== "accumulate_usdc") {
    throw new Error("V2 shadow observation requires a known strategy objective.");
  }
  return objective;
}

function readV3StateReadAt(context: unknown): Date | string {
  const timing = record(record(context, "observation.context").shadowTiming, "observation.context.shadowTiming");
  if (typeof timing.stateReadAt !== "string") throw new Error("V3 shadow observation requires stateReadAt.");
  return timing.stateReadAt;
}

function fullProbabilities(result: ShadowJevEvaluation) {
  const current = result.answers.currentBandSuitable.noul;
  const temporary = result.answers.temporaryOutsideExcursion?.noul;
  return {
    market_regime: { choice: result.answers.marketRegime.choice,
      probabilities: result.answers.marketRegime.probabilities,
      confidence: result.answers.marketRegime.confidence },
    current_band_suitable: { true: current, false: 1 - current },
    ...(temporary === undefined ? {} : { temporary_outside_excursion: { true: temporary, false: 1 - temporary } }),
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is invalid.`);
  return value as Record<string, unknown>;
}

function readRawResponse(error: unknown): unknown | undefined {
  if (!error || typeof error !== "object") return undefined;
  return "rawResponse" in error ? (error as { rawResponse?: unknown }).rawResponse : undefined;
}

function elapsedMs(startedAt: number): number { return Math.max(0, Math.round(performance.now() - startedAt)); }
function retryDelayMs(attemptCount: number): number { return Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, attemptCount - 1)); }
