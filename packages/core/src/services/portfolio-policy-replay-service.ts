import type { BacktestMarketSeries, HistoricalCandle } from "../domain/types";
import { CandleReplayService } from "./candle-replay-service";
import { blocksDuplicateEntry } from "./portfolio-policy-service";
import { evaluatePortfolioPolicy, type PortfolioPolicyDecision, type PortfolioPolicyInput, type PortfolioPolicyParameters, type PolicyBandState, type PolicyCandle } from "./portfolio-policy-service";
import { buildShadowGridCandidates, type ShadowGridCandidate, type ShadowGridCandidateSet } from "./shadow-grid-candidate-service";

export interface PortfolioReplayInitialLot { kind: "trading" | "retained"; entryPrice: number;
  remainingBaseAmount: number; costQuote: number; exitPrice: number; entrySpacing: number;
  economicRule?: "accumulate_base" | "accumulate_usdc"; }
export interface PortfolioReplayAllocation { assetSymbol: string; series: BacktestMarketSeries;
  bandId?: string; baseMint?: string; quoteMint?: string; baseDecimals?: number;
  initialPreviousPrice?: number; initialRealizedLossUsd?: number;
  warmupCandles?: HistoricalCandle[]; initialBudgetUsd: number; initialIdleQuoteUsd?: number;
  initialLots?: PortfolioReplayInitialLot[]; lowPrice: number; highPrice: number; levelCount: number;
  initialStatus?: "active" | "parked"; initialLastRevisionAt?: Date; initialRevisionsToday?: number;
  strategy: "accumulate_base" | "accumulate_usdc"; }
export type PortfolioReplayCandidateSelector = (input: { policyInput: PortfolioPolicyInput;
  objective: PortfolioReplayAllocation["strategy"]; candidateSet: ShadowGridCandidateSet;
  candles: readonly PolicyCandle[]; candidates: readonly ShadowGridCandidate[] }) => string;
export interface PortfolioReplayInitialIntervention { bandId: string; observedAt: Date;
  decision: PortfolioPolicyDecision; candidateId?: string; }
export interface PortfolioPolicyReplayRequest { allocations: PortfolioReplayAllocation[]; totalStartingCapitalUsd: number; freeCashUsd?: number; policyParameters: PortfolioPolicyParameters; feeBps: number; slippageBps?: number; minOrderQuoteUsd?: number; candleIntervalMs?: number; adaptive?: boolean; nativeFeeUsd?: number; candidateSelector?: PortfolioReplayCandidateSelector;
  /** Apply this recorded decision once at t0, before processing future candles. */
  initialIntervention?: PortfolioReplayInitialIntervention; }
export interface PortfolioReplayPoint { timestamp: Date; priceByAsset: Record<string, number>; equityUsd: number; cashUsd: number;
  /** Remaining lot cost basis, not transaction fees. */
  tradingCostUsd: number; retainedBaseByAsset: Record<string, number>; openTradingLots: number; closedCycles: number;
  feesUsd: number; slippageCostUsd: number; roundingCostUsd: number; realizedProfitUsd: number; }
export interface PortfolioReplayAction { timestamp: Date; assetSymbol: string; action: PortfolioPolicyDecision["action"]; reason: string; bandId: string; candidateId?: string; policyCandidateId?: string | null; }
export interface PortfolioReplayTrade { timestamp: Date; assetSymbol: string; bandId: string; lotId: number; side: "buy" | "sell";
  baseAmount: number; quoteAmount: number; marketPrice: number; executionPrice: number;
  feesUsd: number; slippageCostUsd: number; roundingCostUsd: number; realizedProfitUsd: number; }
export interface PortfolioPolicyReplayResult { initialPoint: PortfolioReplayPoint; points: PortfolioReplayPoint[]; actions: PortfolioReplayAction[]; trades: PortfolioReplayTrade[];
  endingEquityUsd: number; endingCashUsd: number; endingTradingCostUsd: number; retainedBaseByAsset: Record<string, number>; closedCycles: number; policyParameters: PortfolioPolicyParameters;
  feesUsd: number; slippageCostUsd: number; roundingCostUsd: number; realizedProfitUsd: number;
  endingLots: Array<PortfolioReplayInitialLot & { id: number; bandId: string; assetSymbol: string }>;
  endingBands: Array<{ bandId: string; assetSymbol: string; lowPrice: number; highPrice: number; levelCount: number;
    status: "active" | "parked"; allocatedCapitalUsd: number; idleQuoteUsd: number }>; }

type Lot = PortfolioReplayInitialLot & { id: number; bandId: string; assetSymbol: string; economicRule: PortfolioReplayAllocation["strategy"] };
type Band = PolicyBandState & { assetSymbol: string; strategy: PortfolioReplayAllocation["strategy"]; previousPrice: number | null; baseDecimals: number };

/** OHLC paths are synthetic. This validates causal accounting/policy, not intrabar execution quality. */
export class PortfolioPolicyReplayService {
  constructor(private readonly path = new CandleReplayService()) {}

  compare(request: PortfolioPolicyReplayRequest) {
    return { fixed: this.replay({ ...request, adaptive: false }), adaptive: this.replay({ ...request, adaptive: true }) };
  }

  replay(request: PortfolioPolicyReplayRequest): PortfolioPolicyReplayResult {
    validateRequest(request);
    const interval = request.candleIntervalMs ?? this.path.estimateIntervalMs(request.allocations[0]!.series.candles);
    if (!Number.isFinite(interval) || interval < 3) throw new Error("Invalid candle interval; provide an explicit interval for a single candle.");
    validateTimelines(request, interval);
    // Multiple bands share one market stream; duplicating it would duplicate closes and fills.
    const markets = [...new Map(request.allocations.map(a => [a.assetSymbol, a])).values()];
    let freeCash = request.freeCashUsd ?? 0;
    let closedCycles = 0;
    const fee = request.feeBps / 10_000, slip = (request.slippageBps ?? 0) / 10_000;
    const nativeFee = request.nativeFeeUsd ?? 0;
    const bands: Band[] = request.allocations.map((a, i) => ({ id: a.bandId ?? `${a.assetSymbol}:${i}`, assetSymbol: a.assetSymbol,
      strategy: a.strategy, lowPrice: a.lowPrice, highPrice: a.highPrice, levelCount: a.levelCount,
      spacing: (a.highPrice - a.lowPrice) / (a.levelCount - 1), status: a.initialStatus ?? "active",
      allocatedCapitalUsd: a.initialBudgetUsd, idleQuoteUsd: a.initialIdleQuoteUsd ?? a.initialBudgetUsd,
      openTradingLots: [], previousPrice: a.initialPreviousPrice ?? null, baseDecimals: a.baseDecimals ?? 8,
      lastRevisionAt: a.initialLastRevisionAt ?? a.series.candles[0]!.timestamp,
      revisionsToday: a.initialRevisionsToday ?? 0 }));
    const lots: Lot[] = request.allocations.flatMap((allocation, index) => (allocation.initialLots ?? []).map(lot => ({
      ...lot, id: 0, bandId: bands[index]!.id, assetSymbol: allocation.assetSymbol,
      economicRule: lot.economicRule ?? allocation.strategy,
    })));
    lots.forEach((lot, index) => { lot.id = index; });
    const actions: PortfolioReplayAction[] = [], points: PortfolioReplayPoint[] = [];
    const trades: PortfolioReplayTrade[] = [];
    let feesUsd = 0, slippageCostUsd = 0, roundingCostUsd = 0, realizedProfitUsd = 0;
    const prices: Record<string, number> = Object.fromEntries(markets.map(a => [a.assetSymbol, a.series.candles[0]!.open]));
    const closed: Record<string, PolicyCandle[]> = Object.fromEntries(markets.map(a => [a.assetSymbol, (a.warmupCandles ?? []).map(c => ({ openedAt: c.timestamp, closedAt: new Date(+c.timestamp + interval), open: c.open, high: c.high, low: c.low, close: c.close }))]));
    type Event = { time: number; phase: number; asset: string; price: number; candle?: HistoricalCandle };
    const events: Event[] = markets.flatMap(a => a.series.candles.flatMap(c => [
      ...this.path.buildIntrabougiePath(c, interval).map((t, i) => ({ time: +t.timestamp, phase: i === 0 ? 2 : 0, asset: a.assetSymbol, price: t.price })),
      { time: +c.timestamp + interval, phase: 1, asset: a.assetSymbol, price: c.close, candle: c },
    ]));
    events.sort((a, b) => a.time - b.time || a.phase - b.phase || a.asset.localeCompare(b.asset));
    const totalCash = () => freeCash + bands.reduce((s, b) => s + b.idleQuoteUsd, 0);
    const attributions = (asset: string) => bands.filter(b => b.assetSymbol === asset).reduce((s, b) => s + b.allocatedCapitalUsd, 0);
    const snapshot = (timestamp: Date): PortfolioReplayPoint => {
      const retainedBaseByAsset: Record<string, number> = {};
      for (const lot of lots.filter(l => l.kind === "retained")) retainedBaseByAsset[lot.assetSymbol] = (retainedBaseByAsset[lot.assetSymbol] ?? 0) + lot.remainingBaseAmount;
      return { timestamp, priceByAsset: { ...prices }, cashUsd: totalCash(),
        equityUsd: totalCash() + lots.reduce((sum, lot) => sum + lot.remainingBaseAmount * prices[lot.assetSymbol]!, 0),
        tradingCostUsd: lots.reduce((sum, lot) => sum + lot.costQuote, 0), retainedBaseByAsset,
        openTradingLots: lots.filter(l => l.kind === "trading" && l.remainingBaseAmount > 0).length,
        closedCycles, feesUsd, slippageCostUsd, roundingCostUsd, realizedProfitUsd };
    };
    const recordTrade = (trade: PortfolioReplayTrade) => {
      trades.push(trade);
      feesUsd += trade.feesUsd; slippageCostUsd += trade.slippageCostUsd;
      roundingCostUsd += trade.roundingCostUsd; realizedProfitUsd += trade.realizedProfitUsd;
    };
    const applyDecision = (band: Band, decision: PortfolioPolicyDecision, now: Date, strict: boolean) => {
      validateDecision(decision);
      const sameDay = band.lastRevisionAt?.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
      if (decision.action === "revise") {
        Object.assign(band, { lowPrice: decision.nextLowPrice!, highPrice: decision.nextHighPrice!,
          levelCount: decision.nextLevelCount!, spacing: decision.nextSpacing!, previousPrice: null,
          lastRevisionAt: now, revisionsToday: (sameDay ? band.revisionsToday ?? 0 : 0) + 1, status: "active" });
      } else if (decision.action === "park") band.status = "parked";
      else if (decision.action === "reactivate") { band.status = "active"; band.previousPrice = null; }
      else if (decision.action === "create_band") {
        const candidate = decision.candidate!;
        const least = markets.map(a => a.assetSymbol).sort((a, b) => attributions(a) - attributions(b) || a.localeCompare(b))[0];
        if (least !== band.assetSymbol || candidate.requestedCapitalUsd > freeCash ||
          bands.filter(b => b.assetSymbol === band.assetSymbol).length >= request.policyParameters.maxBands ||
          (attributions(band.assetSymbol) + candidate.requestedCapitalUsd) / request.totalStartingCapitalUsd * 100 > request.policyParameters.maxExposurePct) {
          if (strict) throw new Error("Initial intervention cannot fund or admit the new band.");
          return false;
        }
        freeCash -= candidate.requestedCapitalUsd;
        band.status = "parked";
        let id = `${band.assetSymbol}:${bands.length}`;
        while (bands.some(b => b.id === id)) id += ":new";
        bands.push({ ...band, id, lowPrice: candidate.lowPrice, highPrice: candidate.highPrice,
          levelCount: candidate.levelCount, spacing: candidate.spacing,
          allocatedCapitalUsd: candidate.requestedCapitalUsd, idleQuoteUsd: candidate.requestedCapitalUsd,
          previousPrice: null, status: "active", lastRevisionAt: now, revisionsToday: 1, openTradingLots: [] });
      }
      return true;
    };
    const initialPoint = snapshot(new Date(markets[0]!.series.candles[0]!.timestamp));
    if (request.initialIntervention) {
      const intervention = request.initialIntervention;
      const band = bands.find(b => b.id === intervention.bandId);
      if (!band || +intervention.observedAt !== +initialPoint.timestamp) throw new Error("Initial intervention must target an existing band at replay t0.");
      applyDecision(band, intervention.decision, initialPoint.timestamp, true);
      actions.push({ timestamp: initialPoint.timestamp, assetSymbol: band.assetSymbol, bandId: band.id,
        action: intervention.decision.action, reason: intervention.decision.reason, candidateId: intervention.candidateId });
    }
    for (const [eventIndex, event] of events.entries()) {
      const now = new Date(event.time);
      prices[event.asset] = event.price;
      if (!event.candle) {
        // Lot ownership and target never depend on the current entry-grid revision.
        for (const lot of lots.filter(l => l.assetSymbol === event.asset && l.kind !== "retained" && l.remainingBaseAmount > 0)) {
          if (event.price < lot.exitPrice) continue;
          const band = bands.find(b => b.id === lot.bandId)!;
          const netUnit = event.price * (1 - slip) * (1 - fee);
          const scale = 10 ** band.baseDecimals;
          const sold = lot.economicRule === "accumulate_base" ? Math.ceil((lot.costQuote + nativeFee) / netUnit * scale) / scale : lot.remainingBaseAmount;
          if (sold > lot.remainingBaseAmount || (lot.economicRule === "accumulate_base" && lot.remainingBaseAmount - sold < 1 / scale)) continue;
          const net = sold * netUnit - nativeFee;
          if (net + 1e-9 < lot.costQuote) continue;
          recordTrade({ timestamp: now, assetSymbol: event.asset, bandId: band.id, lotId: lot.id, side: "sell",
            baseAmount: sold, quoteAmount: net, marketPrice: event.price, executionPrice: event.price * (1 - slip),
            feesUsd: sold * event.price * (1 - slip) * fee + nativeFee,
            slippageCostUsd: sold * event.price * slip, roundingCostUsd: 0, realizedProfitUsd: net - lot.costQuote });
          band.idleQuoteUsd += lot.costQuote;
          freeCash += Math.max(0, net - lot.costQuote);
          lot.remainingBaseAmount = Math.max(0, lot.remainingBaseAmount - sold);
          lot.costQuote = 0;
          lot.kind = "retained";
          closedCycles += 1;
        }
        for (const band of bands.filter(b => b.assetSymbol === event.asset)) {
          const previous = band.previousPrice;
          band.previousPrice = event.price;
          if (band.status !== "active" || previous === null || event.price >= previous) continue;
          const rails = Array.from({ length: band.levelCount - 1 }, (_, i) => band.lowPrice + i * band.spacing)
            .filter(p => p < previous && p >= event.price).sort((a, b) => b - a);
          for (const rail of rails) {
            if (lots.some(l => l.assetSymbol === event.asset && blocksDuplicateEntry({ oldEntryPrice: l.entryPrice,
              currentPrice: rail, widerSpacing: Math.max(band.spacing, l.entrySpacing),
              openTradingLot: l.kind !== "retained" && l.remainingBaseAmount > 0 }))) continue;
            const spend = Math.max(request.minOrderQuoteUsd ?? 0, band.allocatedCapitalUsd / (band.levelCount - 1));
            if (spend > band.idleQuoteUsd + 1e-9 || spend <= nativeFee) continue;
            const scale = 10 ** band.baseDecimals;
            const base = Math.floor((spend - nativeFee) * (1 - fee) / (event.price * (1 + slip)) * scale) / scale;
            if (base <= 0) continue;
            recordTrade({ timestamp: now, assetSymbol: event.asset, bandId: band.id, lotId: lots.length, side: "buy",
              baseAmount: base, quoteAmount: spend, marketPrice: event.price, executionPrice: event.price * (1 + slip),
              feesUsd: (spend - nativeFee) * fee + nativeFee, slippageCostUsd: base * event.price * slip,
              roundingCostUsd: Math.max(0, (spend - nativeFee) * (1 - fee) - base * event.price * (1 + slip)), realizedProfitUsd: 0 });
            band.idleQuoteUsd = Math.max(0, band.idleQuoteUsd - spend);
            lots.push({ id: lots.length, bandId: band.id, assetSymbol: event.asset, entryPrice: rail,
              remainingBaseAmount: base, costQuote: spend, kind: "trading", exitPrice: rail + band.spacing,
              entrySpacing: band.spacing, economicRule: band.strategy });
          }
        }
      } else {
        const c = event.candle;
        (closed[event.asset] ??= []).push({ openedAt: c.timestamp, closedAt: now, open: c.open, high: c.high, low: c.low, close: c.close });
        if (request.adaptive !== false) {
          for (const band of bands.filter(b => b.assetSymbol === event.asset)) {
            const sameDay = band.lastRevisionAt?.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
            const assetLots = lots.filter(l => l.assetSymbol === event.asset);
            const policyInput = { now, price: event.price, assetSymbol: event.asset,
              band: { ...band, revisionsToday: sameDay ? band.revisionsToday : 0, openTradingLots: assetLots },
              bandCount: bands.filter(b => b.assetSymbol === event.asset).length, assetAttributedCapitalUsd: attributions(event.asset),
              candles: closed[event.asset]!.slice(-80), candleIntervalMs: interval, maxCandleAgeMs: interval * 2,
              availableCashUsd: freeCash, totalPortfolioCapitalUsd: request.totalStartingCapitalUsd,
              parameters: request.policyParameters };
            const decision = evaluatePortfolioPolicy(policyInput);
            let appliedDecision = decision;
            let candidateId: string | undefined;
            let policyCandidateId: string | null | undefined;
            if (request.candidateSelector) {
              const assetAllocations = [...new Set(bands.map(candidateBand => candidateBand.assetSymbol))]
                .map(assetSymbol => ({ assetSymbol, allocatedCapitalUsd: attributions(assetSymbol) }));
              const candidateSet = buildShadowGridCandidates(policyInput, decision, { assetAllocations });
              const visible = structuredClone({ policyInput, candidateSet });
              const selectedId = request.candidateSelector({ policyInput: visible.policyInput, objective: band.strategy,
                candidateSet: visible.candidateSet, candles: visible.policyInput.candles,
                candidates: visible.candidateSet.candidates });
              const selected = candidateSet.candidates.find(candidate => candidate.id === selectedId);
              if (!selected) throw new Error(`Candidate selector returned unknown candidate ID "${String(selectedId)}".`);
              candidateId = selected.id;
              policyCandidateId = candidateSet.policyCandidateId;
              appliedDecision = selected.decision;
            }
            if (!applyDecision(band, appliedDecision, now, false)) continue;
            if (appliedDecision.action !== "wait" || candidateId) actions.push({ timestamp: now, assetSymbol: event.asset, action: appliedDecision.action, reason: appliedDecision.reason, bandId: band.id, candidateId, policyCandidateId });
          }
        }
        // Record one complete portfolio mark after all assets closed this timestamp.
        const next = events[eventIndex + 1];
        if (!(next?.candle && next.time === event.time)) points.push(snapshot(now));
      }
    }
    const last = points.at(-1);
    return { initialPoint, points, actions, trades, endingCashUsd: totalCash(), endingEquityUsd: last?.equityUsd ?? totalCash(),
      endingTradingCostUsd: last?.tradingCostUsd ?? 0, retainedBaseByAsset: last?.retainedBaseByAsset ?? {},
      closedCycles, policyParameters: { ...request.policyParameters }, feesUsd, slippageCostUsd, roundingCostUsd, realizedProfitUsd,
      endingLots: lots.map(lot => ({ ...lot })),
      endingBands: bands.map(band => ({ bandId: band.id, assetSymbol: band.assetSymbol,
        lowPrice: band.lowPrice, highPrice: band.highPrice, levelCount: band.levelCount, status: band.status,
        allocatedCapitalUsd: band.allocatedCapitalUsd, idleQuoteUsd: band.idleQuoteUsd })) };
  }
}

function validateRequest(r: PortfolioPolicyReplayRequest) {
  if (!r.allocations.length ||
    ![r.totalStartingCapitalUsd, r.freeCashUsd ?? 0, r.feeBps, r.slippageBps ?? 0, r.nativeFeeUsd ?? 0, r.minOrderQuoteUsd ?? 0].every(v => Number.isFinite(v) && v >= 0) ||
    r.feeBps >= 10_000 || (r.slippageBps ?? 0) >= 10_000) throw new Error("Invalid portfolio replay request.");
  if (Math.abs(r.allocations.reduce((s, a) => s + a.initialBudgetUsd, r.freeCashUsd ?? 0) - r.totalStartingCapitalUsd) > 1e-8) throw new Error("Allocations and free cash must equal total starting capital.");
  const ids = r.allocations.map((a, i) => a.bandId ?? `${a.assetSymbol}:${i}`);
  if (ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) throw new Error("Band IDs must be unique.");
  if (r.initialIntervention && (!(r.initialIntervention.observedAt instanceof Date) ||
    !Number.isFinite(+r.initialIntervention.observedAt))) throw new Error("Invalid initial intervention time.");
  for (const a of r.allocations) {
    if (!Number.isFinite(a.initialBudgetUsd) || a.initialBudgetUsd < 0 || !Number.isInteger(a.levelCount) || a.levelCount < 2 ||
      !Number.isFinite(a.lowPrice) || !Number.isFinite(a.highPrice) || a.lowPrice <= 0 || a.highPrice <= a.lowPrice || !a.series.candles.length) throw new Error("Invalid allocation.");
    if (!a.assetSymbol.trim() || a.series.symbol !== a.assetSymbol || !a.series.pair.trim() ||
      (a.strategy !== "accumulate_base" && a.strategy !== "accumulate_usdc") ||
      (a.baseMint !== undefined && !a.baseMint.trim()) || (a.quoteMint !== undefined && !a.quoteMint.trim()) ||
      !Number.isInteger(a.baseDecimals ?? 8) || (a.baseDecimals ?? 8) < 0 || (a.baseDecimals ?? 8) > 12 ||
      !Number.isFinite(a.initialRealizedLossUsd ?? 0) || (a.initialRealizedLossUsd ?? 0) < 0 ||
      (a.initialPreviousPrice !== undefined && (!Number.isFinite(a.initialPreviousPrice) || a.initialPreviousPrice <= 0))) {
      throw new Error("Invalid initial asset state.");
    }
    if ((a.initialLots?.length ?? 0) > 0 && a.initialIdleQuoteUsd === undefined) {
      throw new Error("Seeded lots require explicit initial idle cash.");
    }
    if (a.initialIdleQuoteUsd !== undefined && (!Number.isFinite(a.initialIdleQuoteUsd) || a.initialIdleQuoteUsd < 0 ||
      a.initialIdleQuoteUsd > a.initialBudgetUsd + 1e-8)) throw new Error("Invalid initial idle cash.");
    if (a.initialStatus !== undefined && a.initialStatus !== "active" && a.initialStatus !== "parked") {
      throw new Error("Invalid initial band status.");
    }
    if (a.initialLastRevisionAt !== undefined && (!(a.initialLastRevisionAt instanceof Date) ||
      !Number.isFinite(+a.initialLastRevisionAt) || +a.initialLastRevisionAt > +a.series.candles[0]!.timestamp)) {
      throw new Error("Invalid initial revision time.");
    }
    if (a.initialRevisionsToday !== undefined && (!Number.isInteger(a.initialRevisionsToday) ||
      a.initialRevisionsToday < 0)) throw new Error("Invalid initial revision count.");
    if ((a.initialLots ?? []).some(lot => ![lot.entryPrice, lot.remainingBaseAmount, lot.costQuote,
      lot.exitPrice, lot.entrySpacing].every(value => Number.isFinite(value) && value >= 0) ||
      lot.entryPrice <= 0 || lot.remainingBaseAmount <= 0 || lot.exitPrice <= 0 || lot.entrySpacing <= 0 ||
      (lot.kind !== "retained" && lot.kind !== "trading") ||
      (lot.economicRule !== undefined && lot.economicRule !== "accumulate_base" && lot.economicRule !== "accumulate_usdc") ||
      (lot.kind === "retained" && lot.costQuote !== 0) ||
      (lot.kind === "trading" && lot.costQuote <= 0))) throw new Error("Invalid initial lot.");
    const seededBookCapital = (a.initialIdleQuoteUsd ?? a.initialBudgetUsd) +
      (a.initialLots ?? []).reduce((sum, lot) => sum + lot.costQuote, 0);
    if (Math.abs(seededBookCapital + (a.initialRealizedLossUsd ?? 0) - a.initialBudgetUsd) > 1e-8) {
      throw new Error("Seeded cash, lot cost and declared realized loss must equal assigned capital.");
    }
    if (!a.series.candles.every((c, i) => c.timestamp instanceof Date && Number.isFinite(+c.timestamp) &&
      (i === 0 || +c.timestamp > +a.series.candles[i - 1]!.timestamp) &&
      [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))) throw new Error("Invalid historical candles.");
  }
}

function validateTimelines(request: PortfolioPolicyReplayRequest, interval: number) {
  if (!Number.isInteger(interval)) throw new Error("Candle interval must be an integer.");
  const first = request.allocations[0]!;
  const markets = new Map<string, PortfolioReplayAllocation>();
  const sameCandle = (a: HistoricalCandle, b: HistoricalCandle) => +a.timestamp === +b.timestamp &&
    a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && (a.volume ?? null) === (b.volume ?? null);
  for (const allocation of request.allocations) {
    const candles = allocation.series.candles;
    if (candles.length !== first.series.candles.length || +candles[0]!.timestamp !== +first.series.candles[0]!.timestamp ||
      candles.some((c, i) => i > 0 && +c.timestamp - +candles[i - 1]!.timestamp !== interval)) {
      throw new Error("Replay assets require the same contiguous candle timeline.");
    }
    const warmup = allocation.warmupCandles ?? [];
    if (warmup.some((c, i) => !(c.timestamp instanceof Date) || !Number.isFinite(+c.timestamp) ||
      +c.timestamp + interval > +candles[0]!.timestamp ||
      (i > 0 && +c.timestamp - +warmup[i - 1]!.timestamp !== interval) ||
      ![c.open, c.high, c.low, c.close].every(value => Number.isFinite(value) && value > 0) ||
      c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) ||
      (warmup.length > 0 && +warmup.at(-1)!.timestamp + interval !== +candles[0]!.timestamp)) {
      throw new Error("Warmup must be a contiguous closed prefix ending at replay t0.");
    }
    const peer = markets.get(allocation.assetSymbol);
    if (peer && (peer.baseMint !== allocation.baseMint || peer.quoteMint !== allocation.quoteMint ||
      (peer.baseDecimals ?? 8) !== (allocation.baseDecimals ?? 8) || peer.series.pair !== allocation.series.pair ||
      peer.series.resolution !== allocation.series.resolution ||
      peer.series.candles.some((c, i) => !sameCandle(c, candles[i]!)) ||
      (peer.warmupCandles?.length ?? 0) !== warmup.length ||
      (peer.warmupCandles ?? []).some((c, i) => !sameCandle(c, warmup[i]!)))) {
      throw new Error("Bands of the same asset must share identical market data, mint and precision.");
    }
    if (allocation.quoteMint !== first.quoteMint) throw new Error("Portfolio assets must share the same quote mint.");
    markets.set(allocation.assetSymbol, allocation);
  }
}

function validateDecision(decision: PortfolioPolicyDecision) {
  if (!["wait", "revise", "park", "reactivate", "create_band"].includes(decision.action)) throw new Error("Unknown replay decision.");
  if (decision.action !== "revise" && decision.action !== "create_band") return;
  const geometry = decision.action === "create_band" ? decision.candidate : {
    lowPrice: decision.nextLowPrice, highPrice: decision.nextHighPrice,
    levelCount: decision.nextLevelCount, spacing: decision.nextSpacing,
  };
  if (!geometry || typeof geometry.lowPrice !== "number" || typeof geometry.highPrice !== "number" ||
    typeof geometry.levelCount !== "number" || typeof geometry.spacing !== "number" ||
    ![geometry.lowPrice, geometry.highPrice, geometry.levelCount, geometry.spacing].every(Number.isFinite) ||
    geometry.lowPrice <= 0 || geometry.highPrice <= geometry.lowPrice || !Number.isInteger(geometry.levelCount) || geometry.levelCount < 2 ||
    Math.abs(geometry.spacing - (geometry.highPrice - geometry.lowPrice) / (geometry.levelCount - 1)) > 1e-8 ||
    (decision.action === "create_band" && (!Number.isFinite(decision.candidate!.requestedCapitalUsd) || decision.candidate!.requestedCapitalUsd <= 0))) {
    throw new Error("Invalid replay decision geometry or capital.");
  }
}
