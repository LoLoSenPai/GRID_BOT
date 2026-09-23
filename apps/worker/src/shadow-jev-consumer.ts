import type {
  ClaimShadowJevJobsInput,
  CompleteShadowJevJobInput,
  FailShadowJevJobInput,
  ShadowJevClaim,
} from "@grid-bot/db";
import type { PortfolioPolicyInput } from "@grid-bot/core";

import { evaluateJev, type JevClient, type ShadowJevEvaluation } from "./shadow-jev-client";
import { buildJevRequest, modelRequested, questionSetVersion, type ShadowJevRequest } from "./shadow-jev-questions";

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
    let request: ShadowJevRequest | undefined;
    const startedAt = performance.now();
    try {
      if (job.questionSetVersion !== questionSetVersion || job.modelRequested !== modelRequested) {
        throw new Error(`Unsupported shadow question/model version: ${job.questionSetVersion}/${job.modelRequested}`);
      }
      request = buildJevRequest({ observedAt: job.observation.observedAt,
        policyInput: restorePolicyInput(job), strategy: readStrategy(job.observation.context) });
      const result = await evaluateJev(request, this.client, { timeoutMs: EVALUATION_TIMEOUT_MS });
      await this.outbox.complete({ jobId: job.jobId, workerId: this.workerId, rawRequest: request,
        rawResponse: result.rawResponse, probabilities: fullProbabilities(result),
        modelVersion: result.modelResolved, latencyMs: elapsedMs(startedAt) });
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
