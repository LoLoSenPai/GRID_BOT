import { randomUUID } from "node:crypto";
import { MINTS } from "@grid-bot/common";
import { buildObservedCostProfile, decomposeShadowExecutionCost, type ShadowCostExecution,
  type ShadowCostProfileOptions } from "@grid-bot/core";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../client";
import { canonicalShadowHash } from "./shadow-observation-repository";

export interface CaptureShadowQuoteComparisonInput {
  portfolioId: string; botId: string; capturedAt: Date; payload: unknown;
}

export class PrismaShadowCostRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async readProfile(portfolioId: string, botId: string, asOf: Date, options: ShadowCostProfileOptions = {}) {
    const { bot, executions, truncated } = await this.readExecutions(portfolioId, botId, asOf, options);
    const profile = buildObservedCostProfile({ portfolioId, botId, asOf, assetSymbol: bot.baseSymbol,
      baseMint: bot.baseMint, quoteMint: bot.quoteMint, executions, options });
    if (truncated) { profile.usable = false; profile.coverageWarnings.push("execution_read_limit_exceeded"); }
    return profile;
  }

  async readAuditReport(portfolioId: string, botId: string, asOf: Date, options: ShadowCostProfileOptions = {}) {
    const { bot, executions, truncated } = await this.readExecutions(portfolioId, botId, asOf, options);
    const profile = buildObservedCostProfile({ portfolioId, botId, asOf, assetSymbol: bot.baseSymbol,
      baseMint: bot.baseMint, quoteMint: bot.quoteMint, executions, options });
    if (truncated) { profile.usable = false; profile.coverageWarnings.push("execution_read_limit_exceeded"); }
    return { profile,
      executions: executions.map(decomposeShadowExecutionCost) };
  }

  /** Insert only, deduplicate exact payload/time/identity; immutable trigger also protects against direct writes. */
  async captureQuoteComparison(input: CaptureShadowQuoteComparisonInput): Promise<{ id: string; contentHash: string }> {
    if (!input.portfolioId || !input.botId || !Number.isFinite(input.capturedAt.getTime())) throw new Error("Invalid shadow quote capture.");
    assertCompactPayload(input.payload);
    const completedAt = input.payload && typeof input.payload === "object" && "completedAt" in input.payload
      ? new Date(String(input.payload.completedAt)).getTime() : null;
    if (completedAt !== null && (!Number.isFinite(completedAt) || completedAt > input.capturedAt.getTime()))
      throw new Error("Shadow quote evidence must be completed before capture.");
    const payload = JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue;
    const contentHash = canonicalShadowHash({ ...input, payload });
    const id = randomUUID();
    await this.client.$executeRaw(Prisma.sql`
      INSERT INTO "shadow_quote_comparisons" ("id", "content_hash", "portfolio_id", "bot_id", "captured_at", "payload")
      VALUES (${id}, ${contentHash}, ${input.portfolioId}, ${input.botId}, ${input.capturedAt}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT ("content_hash") DO NOTHING
    `);
    const rows = await this.client.$queryRaw<Array<{ id: string; contentHash: string }>>(Prisma.sql`
      SELECT "id", "content_hash" AS "contentHash" FROM "shadow_quote_comparisons" WHERE "content_hash" = ${contentHash}
    `);
    if (!rows[0]) throw new Error("Shadow quote capture could not be recovered.");
    return rows[0];
  }

  async readQuoteComparisons(portfolioId: string, botId: string, asOf: Date, limit = 100) {
    if (!Number.isFinite(asOf.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid quote read bounds.");
    return this.client.$queryRaw<Array<{ id: string; contentHash: string; capturedAt: Date; payload: unknown }>>(Prisma.sql`
      SELECT "id", "content_hash" AS "contentHash", "captured_at" AS "capturedAt", "payload"
      FROM "shadow_quote_comparisons" WHERE "portfolio_id" = ${portfolioId} AND "bot_id" = ${botId} AND "captured_at" <= ${asOf}
      ORDER BY "captured_at" DESC, "id" DESC LIMIT ${limit}
    `);
  }

  private async readExecutions(portfolioId: string, botId: string, asOf: Date, options: ShadowCostProfileOptions) {
    if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid observed cost asOf.");
    const days = options.windowDays ?? 30;
    if (!Number.isFinite(days) || days <= 0) throw new Error("Invalid observed cost window.");
    const start = options.windowStart === undefined ? new Date(asOf.getTime() - days * 86_400_000) : new Date(options.windowStart);
    if (!Number.isFinite(start.getTime()) || start > asOf) throw new Error("Invalid observed cost window.");
    const bot = await this.client.bot.findFirst({ where: { id: botId,
      gridBand: { assetStrategy: { portfolioId } } },
      select: { id: true, baseSymbol: true, baseMint: true, quoteMint: true, baseDecimals: true, quoteDecimals: true } });
    if (!bot) throw new Error("Shadow cost bot does not belong to the requested portfolio.");
    const rows = await this.client.execution.findMany({ where: { botId, provider: "jupiter", mode: "live", status: "filled",
      completedAt: { gte: start, lte: asOf } }, orderBy: [{ completedAt: "desc" }, { id: "desc" }], take: 501,
      // Only public reports, never execution_attempts.payload / transaction authorizations.
      select: { id: true, botId: true, provider: true, mode: true, status: true, createdAt: true, completedAt: true,
        executedInputAmount: true, executedOutputAmount: true, executedFeeAmount: true, rawReport: true, order: { select: { side: true } } } });
    // Index-backed single reference per non-SOL fill; never scan a month of high-frequency snapshots.
    const executions: ShadowCostExecution[] = [];
    for (const row of rows.slice(0, 500).reverse()) {
      const execution: ShadowCostExecution = { ...row, side: row.order.side, assetSymbol: bot.baseSymbol, baseMint: bot.baseMint, quoteMint: bot.quoteMint,
        baseDecimals: bot.baseDecimals, quoteDecimals: bot.quoteDecimals,
        executedInputAmount: row.executedInputAmount === null ? null : Number(row.executedInputAmount),
        executedOutputAmount: row.executedOutputAmount === null ? null : Number(row.executedOutputAmount),
        executedFeeAmount: row.executedFeeAmount == null ? null : Number(row.executedFeeAmount),
        // commitExecution sets completedAt and executedFeeAmount in the same UPDATE, after native USD valuation.
        // This is an availability upper bound, not an invented timestamp of a market-price observation.
        executedFeeValuedAt: row.completedAt, nativeUsdReference: null };
      const hasNativeUsdEvidence = decomposeShadowExecutionCost(execution).walletNativeCostUsd !== null;
      const price = bot.baseMint === MINTS.SOL || hasNativeUsdEvidence ? null : await this.client.priceSnapshot.findFirst({ where: {
        symbol: "SOL", createdAt: { lte: asOf }, capturedAt: { gte: new Date(row.completedAt!.getTime() - 60 * 60 * 1_000), lte: row.completedAt! } },
        select: { price: true, capturedAt: true }, orderBy: { capturedAt: "desc" } });
      execution.nativeUsdReference = price ? { price: Number(price.price), capturedAt: price.capturedAt } : null;
      executions.push(execution);
    }
    return { bot, executions, truncated: rows.length > 500 };
  }
}

function assertCompactPayload(payload: unknown) {
  const json = JSON.stringify(payload);
  if (!json || json.length > 100_000) throw new Error("Shadow quote payload is missing or too large.");
  function check(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (/transaction|instruction|secret|api.?key|signature|private.?key|authorization/i.test(key))
        throw new Error("Shadow quote payload must contain public compact quote fields only.");
      check(entry);
    }
  }
  check(payload);
}
