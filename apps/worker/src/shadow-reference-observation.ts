import { logger, MINTS } from "@grid-bot/common";
import { DEFAULT_PORTFOLIO_POLICY, evaluatePortfolioPolicy, type PortfolioPolicyInput,
  type PortfolioPolicyParameters } from "@grid-bot/core";
import { PrismaShadowObservationRepository, type CaptureShadowObservationInput,
  type FinalizeShadowOutcomeInput, type ShadowObservationClientHandle } from "@grid-bot/db";
import { BTC_REFERENCE_IDENTITY, btcReferenceQuality } from "./shadow-btc-reference";
import { v4ModelRequested, v4ReferenceQuestionSetVersion } from "./shadow-jev-v4-questions";

const HOUR = 3_600_000;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function referencePriceGap(live: number, reference: number): number | null {
  return [live, reference].every(v => Number.isFinite(v) && v > 0) ? Math.abs(live / reference - 1) : null;
}
export function referenceBaselineOutcome(context: unknown): FinalizeShadowOutcomeInput {
  const witness = object(object(context).referenceEngineWitness);
  const outcome = object(witness.outcome);
  if (["applied", "wait", "rejected", "observed_only"].includes(String(outcome.status))) {
    return { status: outcome.status as FinalizeShadowOutcomeInput["status"],
      ...(outcome.status !== "observed_only" && outcome.effectiveDecision != null ? { effectiveDecision: outcome.effectiveDecision } : {}) };
  }
  return { status: "observed_only" };
}

/** Separate shadow process only. Persist judgments; never call the portfolio mutation or execution services. */
export function createShadowReferenceObserver(handle: ShadowObservationClientHandle,
  storage: Pick<PrismaShadowObservationRepository, "capture" | "finalizeOutcome"> = new PrismaShadowObservationRepository(handle.client),
  publish?: (input: CaptureShadowObservationInput, outcome: FinalizeShadowOutcomeInput) => Promise<void>) {
  const client = handle.client;
  return async (now: Date): Promise<void> => {
    const observedAt = new Date(Math.floor(+now / HOUR) * HOUR);
    const rows = await client.marketCandle.findMany({ where: { ...BTC_REFERENCE_IDENTITY, resolution: "1h",
      openTime: { gte: new Date(+observedAt - 80 * HOUR) }, closeTime: { lte: observedAt }, fetchedAt: { lte: now } },
      orderBy: { openTime: "asc" }, take: 80 });
    const quality = btcReferenceQuality(rows.map(row => ({ ...row, open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) })),
      "1h", new Date(+observedAt - 80 * HOUR), observedAt);
    if (quality.stale || quality.missingIntervals || rows.length !== 80) {
      logger.warn({ quality }, "BTC reference observation skipped: incomplete causal hourly prefix"); return;
    }
    const [sanityRow] = await client.marketCandle.findMany({ where: { ...BTC_REFERENCE_IDENTITY, resolution: "5m",
      closeTime: { gte: new Date(+now - 10 * 60_000), lte: now }, fetchedAt: { lte: now } },
      orderBy: { closeTime: "desc" }, take: 1 });
    const sanityReferencePrice = Number(sanityRow?.close);
    const sanityReferenceAsOf = sanityRow?.closeTime;
    if (!sanityRow || !sanityReferenceAsOf || +sanityReferenceAsOf > +now || +now - +sanityReferenceAsOf > 10 * 60_000 ||
      +sanityRow.fetchedAt > +now || sanityRow.provider !== BTC_REFERENCE_IDENTITY.provider ||
      sanityRow.symbol !== BTC_REFERENCE_IDENTITY.symbol || sanityRow.quoteSymbol !== BTC_REFERENCE_IDENTITY.quoteSymbol ||
      sanityRow.sourceMarket !== BTC_REFERENCE_IDENTITY.sourceMarket || sanityRow.resolution !== "5m" ||
      +sanityReferenceAsOf - +sanityRow.openTime !== 300_000 || referencePriceGap(sanityReferencePrice, sanityReferencePrice) === null) {
      logger.warn("BTC reference observation skipped: recent causal 5m price reference unavailable"); return;
    }
    const bands = await client.gridBand.findMany({ where: { status: { not: "CLOSED" },
      assetStrategy: { baseSymbol: "BTC", baseMint: MINTS.BTC, portfolio: { shadowJevEnabled: true } },
      bot: { baseSymbol: "BTC", baseMint: MINTS.BTC, quoteMint: MINTS.USDC, archivedAt: null } },
      orderBy: { id: "asc" }, take: 3, include: { assetStrategy: { include: { portfolio: true } },
        bot: { include: { config: true, positionLots: { where: { closedAt: null } },
          stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 } } },
        revisions: { orderBy: { sequence: "desc" }, take: 1 }, exitCommitments: { where: { fulfilledAt: null } } } });
    for (const band of bands) {
      try {
        const existing = await client.shadowJevObservation.findFirst({ where: { bandId: band.id, observedAt,
          questionSetVersion: v4ReferenceQuestionSetVersion,
          context: { path: ["referenceObserver"], equals: true } }, include: { outcome: true } });
        if (existing) {
          if (!existing.outcome) await storage.finalizeOutcome(existing.id, referenceBaselineOutcome(existing.context));
          continue;
        }
        const revision = band.revisions[0], config = band.bot.config, state = band.bot.stateSnapshots[0];
        const livePrice = Number(band.bot.currentPrice), referencePrice = Number(rows.at(-1)!.close);
        const gap = referencePriceGap(livePrice, sanityReferencePrice);
        if (!revision || !config || gap === null || gap > 0.01 || !band.bot.lastHeartbeatAt ||
          +now - +band.bot.lastHeartbeatAt > 120_000 || +band.bot.lastHeartbeatAt > +now) {
          logger.warn({ bandId: band.id, relativePriceGap: gap }, "BTC reference observation skipped: live price/state sanity"); continue;
        }
        const latest = await client.shadowJevObservation.findFirst({ where: { bandId: band.id,
          questionSetVersion: { in: ["shadow-jev-v4.1", "shadow-jev-v4.2"] },
          marketMeta: { path: ["provider"], equals: "gecko-terminal" },
          observedAt: { lte: observedAt }, createdAt: { lte: now } }, orderBy: { observedAt: "desc" },
          include: { outcome: true } });
        const rawParameters = object(object(latest?.policyInput).parameters);
        const parameters: PortfolioPolicyParameters = Object.keys(rawParameters).length
          ? rawParameters as unknown as PortfolioPolicyParameters : { ...DEFAULT_PORTFOLIO_POLICY };
        const peers = await client.gridBand.findMany({ where: { status: { not: "CLOSED" },
          assetStrategy: { portfolioId: band.assetStrategy.portfolioId } }, include: { bot: { include: {
            positionLots: { where: { closedAt: null } } } }, exitCommitments: { where: { fulfilledAt: null } } } });
        const sameAsset = peers.filter(peer => peer.assetStrategyId === band.assetStrategyId);
        const commitments = sameAsset.flatMap(peer => peer.exitCommitments);
        const policyInput: PortfolioPolicyInput = { now: observedAt, price: referencePrice, assetSymbol: "BTC",
          band: { id: band.id, lowPrice: Number(revision.lowPrice), highPrice: Number(revision.highPrice),
            levelCount: revision.levelCount, spacing: (Number(revision.highPrice) - Number(revision.lowPrice)) / (revision.levelCount - 1),
            status: band.status === "PARKED_BELOW" ? "parked" : "active", allocatedCapitalUsd: Number(band.allocatedQuoteAmount),
            idleQuoteUsd: Number(band.availableQuoteAmount) - Number(band.reservedQuoteAmount),
            openTradingLots: sameAsset.flatMap(peer => peer.bot.positionLots.map(lot => ({ entryPrice: Number(lot.entryPrice),
              remainingBaseAmount: Number(lot.remainingBaseAmount), costQuote: Number(lot.costQuote),
              kind: lot.kind === "retained" ? "retained" as const : "trading" as const }))),
            lastRevisionAt: revision.observedAt, revisionsToday: Array.isArray(object(state?.metadata).recenterHistory)
              ? (object(state?.metadata).recenterHistory as unknown[]).filter(t => typeof t === "string" && t.slice(0, 10) === observedAt.toISOString().slice(0, 10)).length : 0 },
          bandCount: sameAsset.length, assetAttributedCapitalUsd: Number(band.assetStrategy.allocatedQuoteAmount),
          availableCashUsd: Number(band.assetStrategy.portfolio.freeQuoteAmount),
          totalPortfolioCapitalUsd: Number(band.assetStrategy.portfolio.freeQuoteAmount) + peers.reduce((sum, peer) => sum + Number(peer.allocatedQuoteAmount), 0),
          candles: rows.map(row => ({ openedAt: row.openTime, closedAt: row.closeTime!, open: Number(row.open),
            high: Number(row.high), low: Number(row.low), close: Number(row.close) })), candleIntervalMs: HOUR, maxCandleAgeMs: 2 * HOUR,
          parameters: { ...parameters, minUsefulOrderUsd: Math.max(parameters.minUsefulOrderUsd, Number(config.minOrderQuoteAmount)) } };
        const exactWitness = latest && +latest.observedAt === +observedAt && latest.outcome && +latest.outcome.createdAt <= +now ? latest : null;
        const context = { portfolio: { ...band.assetStrategy.portfolio,
            freeQuoteAmount: Number(band.assetStrategy.portfolio.freeQuoteAmount) },
          strategy: { ...band.assetStrategy, portfolio: undefined,
            allocatedQuoteAmount: Number(band.assetStrategy.allocatedQuoteAmount), retainedBaseAmount: Number(band.assetStrategy.retainedBaseAmount) },
          band: { id: band.id, botId: band.botId, status: band.status,
            allocatedQuoteAmount: Number(band.allocatedQuoteAmount), availableQuoteAmount: Number(band.availableQuoteAmount),
            reservedQuoteAmount: Number(band.reservedQuoteAmount), deployedCostQuote: Number(band.deployedCostQuote),
            realizedLossQuote: Number(band.realizedLossQuote), activeRevision: { ...revision,
              lowPrice: Number(revision.lowPrice), highPrice: Number(revision.highPrice) } },
          exitCommitments: commitments.map(commitment => ({ ...commitment, buyTargetPrice: commitment.buyTargetPrice === null ? null : Number(commitment.buyTargetPrice),
            sellTargetPrice: commitment.sellTargetPrice === null ? null : Number(commitment.sellTargetPrice) })),
          referenceObserver: true, shadowMarketReference: { ...BTC_REFERENCE_IDENTITY, referenceOnly: true,
            executableBaseMint: band.bot.baseMint, executableQuoteMint: band.bot.quoteMint, quoteConversionAssumption: "USD reference; executable quote remains USDC",
            relativePriceGap: gap, referencePrice, hourlyReferencePrice: referencePrice, hourlyReferenceAsOf: observedAt,
            sanityReferencePrice, sanityReferenceAsOf, sanityReferenceResolution: "5m", sanityCheckedAt: now,
            livePrice, livePriceObservedAt: band.bot.lastHeartbeatAt, quality },
          shadowTiming: { marketClosedAt: observedAt, stateReadAt: now },
          referenceEngineWitness: exactWitness ? { observationId: exactWitness.id, outcome: { status: exactWitness.outcome!.status,
            effectiveDecision: exactWitness.outcome!.effectiveDecision }, capturedAsOf: now } : null,
          referenceBaselineAssumption: exactWitness ? "recorded_live_engine_outcome" : "live_policy_observation_unavailable_wait_assumption",
          parametersSourceObservationId: latest?.id ?? null };
        const input: CaptureShadowObservationInput = { portfolioId: band.assetStrategy.portfolioId,
          strategyId: band.assetStrategyId, bandId: band.id, botId: band.botId, observedAt,
          questionSetVersion: v4ReferenceQuestionSetVersion, modelRequested: v4ModelRequested, policyInput, context,
          botState: state ?? { currentPrice: livePrice, lastHeartbeatAt: band.bot.lastHeartbeatAt },
          marketMeta: { ...BTC_REFERENCE_IDENTITY, resolution: "1h", from: rows[0]!.openTime, to: observedAt,
            cacheHit: true, stale: false, fetchedAt: new Date(Math.max(...rows.map(row => +row.fetchedAt))) },
          proposedDecision: evaluatePortfolioPolicy(policyInput) };
        if (publish) await publish(input, referenceBaselineOutcome(context));
        else {
          const captured = await storage.capture(input);
          const frozen = await client.shadowJevObservation.findUniqueOrThrow({ where: { id: captured.observationId }, select: { context: true } });
          await storage.finalizeOutcome(captured.observationId, referenceBaselineOutcome(frozen.context));
        }
      } catch (error) { logger.warn({ bandId: band.id, error }, "Independent BTC reference observation failed; retry next collector cycle"); }
    }
  };
}
