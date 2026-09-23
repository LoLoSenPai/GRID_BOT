import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../client";

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
    const context = jsonValue(input.context);
    const botState = jsonValue(input.botState);
    const marketMeta = jsonValue(input.marketMeta);
    const proposedDecision = jsonValue(input.proposedDecision);
    const provenance = jsonValue({
      provider: input.marketMeta.provider,
      symbol: input.marketMeta.symbol.toUpperCase(),
      quoteSymbol: input.marketMeta.quoteSymbol.toUpperCase(),
      resolution: input.marketMeta.resolution,
      sourceMarket: input.marketMeta.sourceMarket ?? null,
    });
    const contentHash = shadowMarketContentHash(input.marketMeta, candles);
    const observationHash = canonicalHash({
      portfolioId: input.portfolioId, strategyId: input.strategyId, bandId: input.bandId, botId: input.botId,
      observedAt, questionSetVersion: input.questionSetVersion, modelRequested: input.modelRequested,
      contentHash, policyInput, context, botState, marketMeta, proposedDecision,
    });

    return this.client.$transaction(async (tx) => {
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
           "market_meta", "proposed_decision", "created_at")
        VALUES
          (${proposedObservationId}, ${input.portfolioId}, ${input.strategyId}, ${input.bandId}, ${input.botId},
           ${snapshot.id}, ${observedAt}, ${input.questionSetVersion}, ${input.modelRequested}, ${observationHash},
           ${JSON.stringify(policyInput)}::jsonb, ${JSON.stringify(context)}::jsonb, ${JSON.stringify(botState)}::jsonb,
           ${JSON.stringify(marketMeta)}::jsonb, ${JSON.stringify(proposedDecision)}::jsonb, CURRENT_TIMESTAMP)
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
      return { observationId: observation.id, snapshotId: snapshot.id };
    });
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
  for (const name of ["provider", "symbol", "quoteSymbol", "resolution"] as const) {
    if (typeof input.marketMeta?.[name] !== "string" || input.marketMeta[name].trim() === "") {
      throw new Error(`Invalid marketMeta.${name}.`);
    }
  }
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
