import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../client";
import { canonicalShadowHash } from "./shadow-observation-repository";

export interface ShadowJevClaim {
  jobId: string;
  attemptCount: number;
  leaseExpiresAt: Date;
  questionSetVersion: string;
  modelRequested: string;
  observation: {
    id: string;
    portfolioId: string;
    strategyId: string;
    bandId: string;
    botId: string;
    observedAt: Date;
    policyInput: unknown;
    context: unknown;
    botState: unknown;
    marketMeta: unknown;
    proposedDecision: unknown;
    marketSnapshot: {
      id: string;
      contentHash: string;
      candleCount: number;
      candles: unknown;
      provenance: unknown;
      observedAt: Date;
    };
  };
}

export interface ClaimShadowJevJobsInput {
  workerId: string;
  limit?: number;
  leaseMs?: number;
  now?: Date;
}

export interface CompleteShadowJevJobInput {
  jobId: string;
  workerId: string;
  rawRequest: unknown;
  rawResponse: unknown;
  probabilities: unknown;
  modelVersion: string;
  latencyMs: number;
  completedAt?: Date;
}

export interface FailShadowJevJobInput {
  jobId: string;
  workerId: string;
  error: string | { code?: string; message: string; details?: unknown };
  rawRequest?: unknown;
  rawResponse?: unknown;
  modelVersion?: string;
  latencyMs?: number;
  retryAt?: Date;
  terminal?: boolean;
  failedAt?: Date;
}

export class ShadowJevLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Shadow Jev job lease is no longer owned: ${jobId}`);
    this.name = "ShadowJevLeaseLostError";
  }
}

export class PrismaShadowJevOutboxRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async claim(input: ClaimShadowJevJobsInput): Promise<ShadowJevClaim[]> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? 10;
    const leaseMs = input.leaseMs ?? 120_000;
    validateWorkerInput(input.workerId, limit, leaseMs, now);
    const leaseExpiresAt = new Date(+now + leaseMs);
    const claimedIds = await this.client.$transaction(async (tx) => tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id", "attempt_count", "claimed_by", "claimed_at", "raw_request", "raw_response", "model_version", "latency_ms"
        FROM "shadow_jev_outbox"
        WHERE (
          ("status" IN ('pending'::"ShadowJevOutboxStatus", 'failed'::"ShadowJevOutboxStatus")
            AND "terminal" = false AND "available_at" <= ${now})
          OR
          ("status" = 'processing'::"ShadowJevOutboxStatus" AND "lease_expires_at" <= ${now})
        )
        ORDER BY "observed_at" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      ), abandoned AS (
        INSERT INTO "shadow_jev_attempts"
          ("id", "outbox_id", "attempt_number", "worker_id", "status", "started_at", "finished_at", "raw_request",
           "raw_response", "model_version", "latency_ms", "error_code", "error_message", "created_at")
        SELECT candidates."id" || ':lease:' || candidates."attempt_count", candidates."id", candidates."attempt_count",
          candidates."claimed_by", 'failed'::"ShadowJevAttemptStatus", COALESCE(candidates."claimed_at", ${now}), ${now},
          candidates."raw_request", candidates."raw_response", candidates."model_version", candidates."latency_ms",
          'LEASE_EXPIRED', 'Worker lease expired before the attempt was recorded.', CURRENT_TIMESTAMP
        FROM candidates
        JOIN "shadow_jev_outbox" old_jobs ON old_jobs."id" = candidates."id"
        WHERE old_jobs."status" = 'processing'::"ShadowJevOutboxStatus"
        ON CONFLICT ("outbox_id", "attempt_number") DO NOTHING
        RETURNING "outbox_id"
      )
      UPDATE "shadow_jev_outbox" AS jobs
      SET "status" = 'processing'::"ShadowJevOutboxStatus", "terminal" = false,
          "claimed_by" = ${input.workerId}, "claimed_at" = ${now}, "lease_expires_at" = ${leaseExpiresAt},
          "attempt_count" = jobs."attempt_count" + 1, "updated_at" = ${now},
          "raw_request" = NULL, "raw_response" = NULL, "probabilities" = NULL, "model_version" = NULL,
          "latency_ms" = NULL, "error_code" = NULL, "error_message" = NULL, "error_details" = NULL,
          "completed_at" = NULL, "failed_at" = NULL
      FROM candidates
      WHERE jobs."id" = candidates."id"
      RETURNING jobs."id"
    `));
    if (claimedIds.length === 0) return [];
    const claimed = new Set(claimedIds.map(({ id }) => id));
    const rows = await this.client.shadowJevOutbox.findMany({
      where: { id: { in: [...claimed] } },
      orderBy: [{ observedAt: "asc" }, { id: "asc" }],
      include: { observation: { include: { snapshot: true } } },
    });
    return rows.map((row) => ({
      jobId: row.id,
      attemptCount: row.attemptCount,
      leaseExpiresAt: row.leaseExpiresAt!,
      questionSetVersion: row.questionSetVersion,
      modelRequested: row.observation.modelRequested,
      observation: {
        id: row.observation.id,
        portfolioId: row.observation.portfolioId,
        strategyId: row.observation.strategyId,
        bandId: row.observation.bandId,
        botId: row.observation.botId,
        observedAt: row.observation.observedAt,
        policyInput: row.observation.policyInput,
        context: row.observation.context,
        botState: row.observation.botState,
        marketMeta: row.observation.marketMeta,
        proposedDecision: row.observation.proposedDecision,
        marketSnapshot: {
          id: row.observation.snapshot.id,
          contentHash: row.observation.snapshot.contentHash,
          candleCount: row.observation.snapshot.candleCount,
          candles: row.observation.snapshot.candles,
          provenance: row.observation.snapshot.provenance,
          observedAt: row.observation.snapshot.observedAt,
        },
      },
    }));
  }

  async complete(input: CompleteShadowJevJobInput): Promise<void> {
    const completedAt = input.completedAt ?? new Date();
    validateCompletion(input, completedAt);
    const data = {
      rawRequest: jsonValue(input.rawRequest), rawResponse: jsonValue(input.rawResponse),
      probabilities: jsonValue(input.probabilities), modelVersion: input.modelVersion,
      latencyMs: input.latencyMs, completedAt,
    };
    const completed = await this.client.$transaction(async (tx) => {
      const updated = await tx.shadowJevOutbox.updateMany({
        where: { id: input.jobId, status: "processing", claimedBy: input.workerId,
          leaseExpiresAt: { gte: completedAt } },
        data: { ...data, status: "completed", terminal: true, claimedBy: null, leaseExpiresAt: null,
          failedAt: null, errorCode: null, errorMessage: null, errorDetails: Prisma.DbNull },
      });
      if (updated.count !== 1) return false;
      const job = await tx.shadowJevOutbox.findUniqueOrThrow({ where: { id: input.jobId } });
      await tx.shadowJevAttempt.create({ data: {
        outboxId: job.id, attemptNumber: job.attemptCount, workerId: input.workerId, status: "completed",
        startedAt: job.claimedAt ?? completedAt, finishedAt: completedAt,
        rawRequest: data.rawRequest, rawResponse: data.rawResponse, probabilities: data.probabilities,
        modelVersion: data.modelVersion, latencyMs: data.latencyMs,
      } });
      return true;
    });
    if (completed) return;
    const existing = await this.client.shadowJevOutbox.findUnique({ where: { id: input.jobId } });
    if (existing?.status === "completed" && canonicalShadowHash({
      rawRequest: existing.rawRequest, rawResponse: existing.rawResponse, probabilities: existing.probabilities,
      modelVersion: existing.modelVersion, latencyMs: existing.latencyMs, completedAt: existing.completedAt,
    }) === canonicalShadowHash(data)) return;
    throw new ShadowJevLeaseLostError(input.jobId);
  }

  async fail(input: FailShadowJevJobInput): Promise<void> {
    const failedAt = input.failedAt ?? new Date();
    const terminal = input.terminal ?? false;
    const retryAt = terminal ? failedAt : (input.retryAt ?? failedAt);
    validateFailure(input, failedAt, retryAt);
    const error = typeof input.error === "string" ? { message: input.error } : input.error;
    const errorDetails = error.details === undefined ? Prisma.DbNull : jsonValue(error.details);
    const rawRequest = input.rawRequest === undefined ? Prisma.DbNull : jsonValue(input.rawRequest);
    const rawResponse = input.rawResponse === undefined ? Prisma.DbNull : jsonValue(input.rawResponse);
    const failed = await this.client.$transaction(async (tx) => {
      const updated = await tx.shadowJevOutbox.updateMany({
        where: { id: input.jobId, status: "processing", claimedBy: input.workerId,
          leaseExpiresAt: { gte: failedAt } },
        data: {
          status: "failed", terminal, availableAt: retryAt, failedAt, claimedBy: null, leaseExpiresAt: null,
          errorCode: error.code, errorMessage: error.message, errorDetails,
          rawRequest, rawResponse, modelVersion: input.modelVersion ?? null, latencyMs: input.latencyMs ?? null,
        },
      });
      if (updated.count !== 1) return false;
      const job = await tx.shadowJevOutbox.findUniqueOrThrow({ where: { id: input.jobId } });
      await tx.shadowJevAttempt.create({ data: {
        outboxId: job.id, attemptNumber: job.attemptCount, workerId: input.workerId, status: "failed",
        startedAt: job.claimedAt ?? failedAt, finishedAt: failedAt,
        rawRequest, rawResponse, modelVersion: input.modelVersion, latencyMs: input.latencyMs,
        errorCode: error.code, errorMessage: error.message, errorDetails,
      } });
      return true;
    });
    if (failed) return;
    const existing = await this.client.shadowJevOutbox.findUnique({
      where: { id: input.jobId },
      include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
    });
    if (existing?.status === "failed" && existing.attempts[0]?.attemptNumber === existing.attemptCount &&
      existing.attempts[0].workerId === input.workerId) return;
    throw new ShadowJevLeaseLostError(input.jobId);
  }
}

function validateWorkerInput(workerId: string, limit: number, leaseMs: number, now: Date): void {
  if (!workerId?.trim()) throw new Error("workerId is required.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100.");
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) throw new Error("leaseMs is out of range.");
  if (!Number.isFinite(+now)) throw new Error("Invalid claim time.");
}

function validateCompletion(input: CompleteShadowJevJobInput, completedAt: Date): void {
  if (!input.jobId || !input.workerId || !input.modelVersion.trim()) throw new Error("Invalid shadow completion identity.");
  if (!Number.isInteger(input.latencyMs) || input.latencyMs < 0) throw new Error("Invalid shadow latency.");
  if (!Number.isFinite(+completedAt)) throw new Error("Invalid completion time.");
}

function validateFailure(input: FailShadowJevJobInput, failedAt: Date, retryAt: Date): void {
  if (!input.jobId || !input.workerId) throw new Error("Invalid shadow failure identity.");
  const error = typeof input.error === "string" ? input.error : input.error?.message;
  if (!error?.trim()) throw new Error("Shadow failure requires an error message.");
  if (!Number.isFinite(+failedAt) || !Number.isFinite(+retryAt) || +retryAt < +failedAt) throw new Error("Invalid retry time.");
  if (input.latencyMs !== undefined && (!Number.isInteger(input.latencyMs) || input.latencyMs < 0)) {
    throw new Error("Invalid shadow latency.");
  }
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
