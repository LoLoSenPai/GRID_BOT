import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../client";
import { logger } from "@grid-bot/common";
import { buildShadowDecisionCandidates, type PortfolioPolicyInput, type PortfolioPolicyDecision,
  type ShadowObservedCostProfile } from "@grid-bot/core";
import { PrismaShadowCostRepository } from "./shadow-cost-repository";

export interface ShadowMarketMeta {
  provider: string;
  symbol: string;
  quoteSymbol: string;
  resolution: string;
  sourceMarket?: string | null;
  from?: Date;
  to?: Date;
  cacheHit?: boolean;
  stale?: boolean;
  fetchedAt?: Date;
}

export interface CaptureShadowObservationInput {
  portfolioId: string;
  strategyId: string;
  bandId: string;
  botId: string;
  observedAt: Date;
  questionSetVersion: string;
  modelRequested: string;
  policyInput: { candles: readonly unknown[] };
  context: unknown;
  botState: unknown;
  marketMeta: ShadowMarketMeta;
  proposedDecision: unknown;
  candidateSet?: unknown;
}

export interface CaptureShadowObservationResult {
  observationId: string;
  snapshotId: string;
}

export interface FinalizeShadowOutcomeInput {
  status: "applied" | "wait" | "rejected" | "observed_only";
  effectiveDecision?: unknown;
  error?: string | { code?: string; message: string; details?: unknown };
}

export class PrismaShadowObservationRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async capture(input: CaptureShadowObservationInput): Promise<CaptureShadowObservationResult> {
    validateCapture(input);
    const observedAt = new Date(input.observedAt);
    const candles = jsonValue(input.policyInput.candles) as Prisma.InputJsonArray;
    const { candles: _candles, ...policyWithoutCandles } = input.policyInput as { candles: readonly unknown[] } & object;
    const policyInput = jsonValue(policyWithoutCandles);
    const suppliedContext = jsonValue(input.context);
    const botState = jsonValue(input.botState);
    const marketMeta = jsonValue(input.marketMeta);
    const proposedDecision = jsonValue(input.proposedDecision);
    let candidateSet = input.candidateSet === undefined ? null : jsonValue(input.candidateSet);
    let costProfile: ShadowObservedCostProfile | null = null;
    if (isV4Question(input.questionSetVersion)) {
      try {
        costProfile = await new PrismaShadowCostRepository(this.client).readProfile(input.portfolioId, input.botId, observedAt);
      } catch (error) {
        logger.warn({ botId: input.botId, error }, "Shadow cost profile unavailable; freeze legacy assumptions");
      }
    }
    const provenance = jsonValue({
      provider: input.marketMeta.provider,
      symbol: input.marketMeta.symbol.toUpperCase(),
      quoteSymbol: input.marketMeta.quoteSymbol.toUpperCase(),
      resolution: input.marketMeta.resolution,
      sourceMarket: input.marketMeta.sourceMarket ?? null,
    });
    const contentHash = shadowMarketContentHash(input.marketMeta, candles);
    const immutableObservationHash = isV3Question(input.questionSetVersion)
      ? canonicalHash({ portfolioId: input.portfolioId, strategyId: input.strategyId,
        bandId: input.bandId, botId: input.botId, observedAt,
        questionSetVersion: input.questionSetVersion, modelRequested: input.modelRequested }) : undefined;
    return retryCaptureTransaction(() => this.client.$transaction(async (tx) => {
      if (immutableObservationHash) {
        const existing = await tx.shadowJevObservation.findUnique({ where: { observationHash: immutableObservationHash } });
        // A committed observation already includes its outbox. A durable outcome
        // retry must still work after the original band has closed or changed.
        if (existing) return { observationId: existing.id, snapshotId: existing.snapshotId };
      }
      // The replay state must come from one MVCC view of the shadow database. The
      // normal portfolio cycle has already returned before this transaction runs.
      let context = isV3Question(input.questionSetVersion)
        ? jsonValue({ ...(suppliedContext as object), shadowReplayV3:
          await readShadowReplayV3(tx, input.portfolioId, input.strategyId, input.bandId, input.botId) })
        : suppliedContext;
      if (isV4Question(input.questionSetVersion)) {
        const full = context as unknown as Record<string, unknown>;
        const snapshot = full.shadowReplayV3 as { capturedAt: string; strategies: Array<{ baseSymbol: string; allocatedQuoteAmount: string }> };
        const supplied = suppliedContext as unknown as { exitCommitments?: Array<{ targetStatus: string; fulfilledAt?: unknown }> };
        candidateSet = jsonValue(buildShadowDecisionCandidates({
          decisionVersion: input.questionSetVersion === "shadow-jev-v4" ? "shadow-decisions-v4" : "shadow-decisions-v4.1",
          policyInput: restorePolicyInput(input.policyInput), proposedDecision: input.proposedDecision as PortfolioPolicyDecision,
          replaySnapshot: snapshot, costProfile,
          options: { assetAllocations: snapshot.strategies.map(strategy => ({ assetSymbol: strategy.baseSymbol,
            allocatedCapitalUsd: Number(strategy.allocatedQuoteAmount) })),
            hasUnknownExitCommitment: supplied.exitCommitments?.some(c => c.targetStatus === "UNKNOWN" && !c.fulfilledAt) },
        }));
        const fineMarket = await captureFineMarket(tx, input, new Date(snapshot.capturedAt));
        context = jsonValue({ ...full, shadowFineMarket: fineMarket });
      }
      // A V3 retry can read the same portfolio a few seconds later. Keep the
      // first immutable observation for that band/hour instead of enqueuing a
      // second judgment solely because capturedAt or a bot tick changed.
      const observationHash = immutableObservationHash ?? canonicalHash({
          portfolioId: input.portfolioId, strategyId: input.strategyId, bandId: input.bandId, botId: input.botId,
          observedAt, questionSetVersion: input.questionSetVersion, modelRequested: input.modelRequested,
          contentHash, policyInput, context, botState, marketMeta, proposedDecision,
          ...(candidateSet === null ? {} : { candidateSet }),
        });
      const proposedSnapshotId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "shadow_market_snapshots"
          ("id", "content_hash", "candle_count", "candles", "provenance", "observed_at", "created_at")
        VALUES
          (${proposedSnapshotId}, ${contentHash}, ${candles.length}, ${JSON.stringify(candles)}::jsonb,
           ${JSON.stringify(provenance)}::jsonb, ${observedAt}, CURRENT_TIMESTAMP)
        ON CONFLICT ("content_hash") DO NOTHING
      `);
      const snapshot = await tx.shadowMarketSnapshot.findUniqueOrThrow({ where: { contentHash } });

      const proposedObservationId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "shadow_jev_observations"
          ("id", "portfolio_id", "strategy_id", "band_id", "bot_id", "snapshot_id", "observed_at",
           "question_set_version", "model_requested", "observation_hash", "policy_input", "context", "bot_state",
           "market_meta", "proposed_decision", "candidate_set", "created_at")
        VALUES
          (${proposedObservationId}, ${input.portfolioId}, ${input.strategyId}, ${input.bandId}, ${input.botId},
           ${snapshot.id}, ${observedAt}, ${input.questionSetVersion}, ${input.modelRequested}, ${observationHash},
           ${JSON.stringify(policyInput)}::jsonb, ${JSON.stringify(context)}::jsonb, ${JSON.stringify(botState)}::jsonb,
           ${JSON.stringify(marketMeta)}::jsonb, ${JSON.stringify(proposedDecision)}::jsonb,
           ${candidateSet === null ? null : JSON.stringify(candidateSet)}::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT ("observation_hash") DO NOTHING
      `);
      const observation = await tx.shadowJevObservation.findUniqueOrThrow({
        where: { observationHash },
      });
      if (observation.observationHash !== observationHash) {
        throw new Error("A different shadow observation already uses this idempotency key.");
      }

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "shadow_jev_outbox"
          ("id", "observation_id", "portfolio_id", "band_id", "observed_at", "question_set_version",
           "status", "terminal", "attempt_count", "available_at", "created_at", "updated_at")
        VALUES
          (${randomUUID()}, ${observation.id}, ${input.portfolioId}, ${input.bandId}, ${observedAt},
           ${input.questionSetVersion}, 'pending'::"ShadowJevOutboxStatus", false, 0, CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("observation_id") DO NOTHING
      `);
      const outbox = await tx.shadowJevOutbox.findUniqueOrThrow({ where: { observationId: observation.id } });
      if (outbox.observationId !== observation.id) {
        throw new Error("Shadow outbox idempotency collision.");
      }
      return { observationId: observation.id, snapshotId: observation.snapshotId };
    }, isV3Question(input.questionSetVersion)
      ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      : undefined), input.botId);
  }

  async finalizeOutcome(observationId: string, input: FinalizeShadowOutcomeInput): Promise<void> {
    if (!observationId || !["applied", "wait", "rejected", "observed_only"].includes(input.status) ||
      (input.status === "observed_only" && input.effectiveDecision !== undefined)) {
      throw new Error("Invalid shadow engine outcome.");
    }
    const error = normalizeError(input.error);
    const effectiveDecision = input.effectiveDecision === undefined ? undefined : jsonValue(input.effectiveDecision);
    const errorDetails = error.details === undefined ? undefined : jsonValue(error.details);
    const outcomeHash = canonicalHash({ status: input.status, effectiveDecision: effectiveDecision ?? null,
      errorCode: error.code ?? null, errorMessage: error.message ?? null, errorDetails: errorDetails ?? null });

    const existing = await this.client.shadowEngineOutcome.findUnique({ where: { observationId } });
    if (existing) {
      if (existing.outcomeHash !== outcomeHash) throw new Error("Shadow engine outcome is immutable.");
      return;
    }
    try {
      await this.client.shadowEngineOutcome.create({ data: {
        observationId, status: input.status, effectiveDecision,
        errorCode: error.code, errorMessage: error.message, errorDetails, outcomeHash,
      } });
    } catch (caught) {
      if (!(caught instanceof Prisma.PrismaClientKnownRequestError) || caught.code !== "P2002") throw caught;
      const concurrent = await this.client.shadowEngineOutcome.findUniqueOrThrow({ where: { observationId } });
      if (concurrent.outcomeHash !== outcomeHash) throw new Error("Shadow engine outcome is immutable.");
    }
  }
}

// Repeat the complete transaction after serialization/deadlock rollback. Do not
// retry individual statements or general database failures. The immutable key
// and ON CONFLICT writes preserve the first successfully committed observation.
async function retryCaptureTransaction<T>(operation: () => Promise<T>, botId: string): Promise<T> {
  const delays = [50, 100, 200];
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const code = captureConflictCode(error);
      if (!code) throw error;
      const delayMs = delays[attempt - 1];
      logger.warn({ botId, code, attempt, maxAttempts: delays.length + 1, exhausted: delayMs === undefined },
        "Shadow capture transaction conflict");
      if (delayMs === undefined) throw error;
      await delay(delayMs);
    }
  }
}

function captureConflictCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 5) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["code", "originalCode"] as const) {
    if (["P2034", "40001", "40P01"].includes(String(record[key]))) return String(record[key]);
  }
  // Prisma's pg adapter wraps SQLSTATE under meta.driverAdapterError.cause.
  // Inspect only documented wrappers, never arbitrary message text.
  for (const key of ["meta", "driverAdapterError", "cause"] as const) {
    const code = captureConflictCode(record[key], depth + 1);
    if (code) return code;
  }
  return undefined;
}

async function readShadowReplayV3(tx: Prisma.TransactionClient, portfolioId: string,
  strategyId: string, bandId: string, botId: string): Promise<Prisma.InputJsonValue> {
  const capturedAt = new Date();
  const source = await tx.portfolio.findUniqueOrThrow({
    where: { id: portfolioId },
    select: {
      id: true, mode: true, quoteMint: true, freeQuoteAmount: true, version: true,
      autoLive: true, shadowJevEnabled: true, nativeFeeReserveSol: true, createdAt: true, updatedAt: true,
      assetStrategies: {
        orderBy: { id: "asc" },
        include: {
          bands: {
            where: { status: { not: "CLOSED" } }, orderBy: { id: "asc" },
            include: {
              bot: {
                include: {
                  config: true, position: true,
                  positionLots: { where: { closedAt: null }, orderBy: { id: "asc" } },
                  stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 },
                  executionAttempt: { select: {
                    botId: true, executionId: true, orderId: true, uncertain: true,
                    createdAt: true, updatedAt: true,
                    order: { select: {
                      id: true, orderKey: true, side: true, levelIndex: true, targetPrice: true,
                      requestedBaseAmount: true, requestedQuoteAmount: true, status: true,
                      reason: true, createdAt: true, updatedAt: true,
                    } },
                  } },
                },
              },
              revisions: { orderBy: { sequence: "desc" } },
              exitCommitments: { where: { fulfilledAt: null }, orderBy: { id: "asc" } },
              capitalReservations: {
                where: { status: { in: ["RESERVED", "UNKNOWN"] } }, orderBy: { id: "asc" },
              },
            },
          },
        },
      },
      capitalReservations: {
        where: { status: { in: ["RESERVED", "UNKNOWN"] } }, orderBy: { id: "asc" },
      },
    },
  });
  const target = source.assetStrategies.find(strategy => strategy.id === strategyId)
    ?.bands.find(band => band.id === bandId && band.botId === botId);
  if (!target) throw new Error("The target shadow band is no longer open in the captured portfolio.");
  const { assetStrategies, capitalReservations, ...portfolio } = source;
  // Attempt payloads/results and wallet identity are deliberately excluded: neither
  // is required to replay the economic state and either could contain private data.
  return jsonValue({ schemaVersion: "shadow-replay-v3", capturedAt, source: {
    portfolioId, strategyId, bandId, botId, portfolioVersion: source.version,
  }, portfolio, strategies: assetStrategies, reservations: capitalReservations });
}

function validateCapture(input: CaptureShadowObservationInput): void {
  for (const [name, value] of Object.entries({ portfolioId: input.portfolioId, strategyId: input.strategyId,
    bandId: input.bandId, botId: input.botId, questionSetVersion: input.questionSetVersion,
    modelRequested: input.modelRequested })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid ${name}.`);
  }
  if (!(input.observedAt instanceof Date) || !Number.isFinite(+input.observedAt)) throw new Error("Invalid observedAt.");
  if (!Array.isArray(input.policyInput?.candles) || input.policyInput.candles.length === 0) {
    throw new Error("A shadow observation requires the complete effective candle series.");
  }
  if (["shadow-jev-v2", "shadow-jev-v3", "shadow-jev-v3.1", "shadow-jev-v3.2"].includes(input.questionSetVersion) &&
    input.candidateSet === undefined) {
    throw new Error("A V2/V3 shadow observation requires its immutable candidate set.");
  }
  for (const name of ["provider", "symbol", "quoteSymbol", "resolution"] as const) {
    if (typeof input.marketMeta?.[name] !== "string" || input.marketMeta[name].trim() === "") {
      throw new Error(`Invalid marketMeta.${name}.`);
    }
  }
}

function isV3Question(version: string): boolean {
  return version === "shadow-jev-v3" || version === "shadow-jev-v3.1" || version === "shadow-jev-v3.2" || isV4Question(version);
}

function isV4Question(version: string): boolean {
  return version === "shadow-jev-v4" || version === "shadow-jev-v4.1";
}

function restorePolicyInput(raw: CaptureShadowObservationInput["policyInput"]): PortfolioPolicyInput {
  const policy = raw as unknown as PortfolioPolicyInput;
  return { ...policy, now: new Date(policy.now), candles: policy.candles.map(c => ({ ...c,
    openedAt: new Date(c.openedAt), closedAt: new Date(c.closedAt) })) };
}

/** Reference one immutable 5m snapshot rather than copying candles into every observation. */
async function captureFineMarket(tx: Prisma.TransactionClient, input: CaptureShadowObservationInput, capturedAt: Date) {
  const rows = await tx.marketCandle.findMany({ where: {
    provider: input.marketMeta.provider, symbol: input.marketMeta.symbol.toUpperCase(), quoteSymbol: "USDC", resolution: "5m",
    sourceMarket: input.marketMeta.sourceMarket ?? undefined,
    closeTime: { lte: input.observedAt, gte: new Date(+input.observedAt - 2 * 3_600_000) }, fetchedAt: { lte: capturedAt },
  }, orderBy: { openTime: "asc" } });
  if (!rows.length) return { status: "missing_at_capture" };
  const last = rows.at(-1)!;
  if (!last.closeTime || +input.observedAt - +last.closeTime > 10 * 60_000 ||
    rows.some((r, i) => !r.closeTime || +r.closeTime - +r.openTime !== 300_000 ||
      (i > 0 && +r.openTime - +rows[i - 1]!.openTime !== 300_000))) return { status: "incomplete_at_capture" };
  const candles = rows.map(r => ({ openedAt: r.openTime.toISOString(), closedAt: r.closeTime!.toISOString(),
    open: r.open.toNumber(), high: r.high.toNumber(), low: r.low.toNumber(), close: r.close.toNumber() }));
  const meta = { ...input.marketMeta, resolution: "5m" };
  const contentHash = shadowMarketContentHash(meta, candles);
  const provenance = { provider: meta.provider, symbol: meta.symbol.toUpperCase(), quoteSymbol: "USDC",
    resolution: "5m", sourceMarket: meta.sourceMarket ?? null };
  await tx.$executeRaw(Prisma.sql`INSERT INTO shadow_market_snapshots
    (id, content_hash, candle_count, candles, provenance, observed_at, created_at)
    VALUES (${randomUUID()}, ${contentHash}, ${candles.length}, ${JSON.stringify(candles)}::jsonb,
      ${JSON.stringify(provenance)}::jsonb, ${input.observedAt}, CURRENT_TIMESTAMP)
    ON CONFLICT (content_hash) DO NOTHING`);
  const stored = await tx.shadowMarketSnapshot.findUniqueOrThrow({ where: { contentHash } });
  return { status: "captured", snapshotId: stored.id, contentHash, candleCount: candles.length,
    closedThrough: last.closeTime.toISOString() };
}

function normalizeError(error: FinalizeShadowOutcomeInput["error"]): {
  code?: string; message?: string; details?: unknown;
} {
  if (typeof error === "string") return { message: error };
  return error ?? {};
}

export function canonicalShadowHash(value: unknown): string {
  return canonicalHash(value);
}

export function shadowMarketContentHash(meta: ShadowMarketMeta, candles: readonly unknown[]): string {
  return canonicalHash({
    provenance: {
      provider: meta.provider,
      symbol: meta.symbol.toUpperCase(),
      quoteSymbol: meta.quoteSymbol.toUpperCase(),
      resolution: meta.resolution,
      sourceMarket: meta.sourceMarket ?? null,
    },
    candles,
  });
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Shadow JSON contains a non-finite number.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalize(item));
  if (typeof value === "object") {
    if ("toJSON" in value && typeof value.toJSON === "function") return canonicalize(value.toJSON());
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  throw new Error(`Unsupported shadow JSON value: ${typeof value}.`);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return canonicalize(value) as Prisma.InputJsonValue;
}
