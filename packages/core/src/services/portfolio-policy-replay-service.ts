import type { BacktestMarketSeries, HistoricalCandle } from "../domain/types";
import { CandleReplayService } from "./candle-replay-service";
import { blocksDuplicateEntry } from "./portfolio-policy-service";
import { evaluatePortfolioPolicy, type PortfolioPolicyDecision, type PortfolioPolicyParameters, type PolicyBandState, type PolicyCandle, type PolicyLot } from "./portfolio-policy-service";

export interface PortfolioReplayAllocation { assetSymbol: string; series: BacktestMarketSeries; warmupCandles?: HistoricalCandle[]; initialBudgetUsd: number; lowPrice: number; highPrice: number; levelCount: number; strategy: "accumulate_base" | "accumulate_usdc"; }
export interface PortfolioPolicyReplayRequest { allocations: PortfolioReplayAllocation[]; totalStartingCapitalUsd: number; freeCashUsd?: number; policyParameters: PortfolioPolicyParameters; feeBps: number; slippageBps?: number; minOrderQuoteUsd?: number; candleIntervalMs?: number; adaptive?: boolean; nativeFeeUsd?: number; }
export interface PortfolioReplayPoint { timestamp: Date; priceByAsset: Record<string, number>; equityUsd: number; cashUsd: number; tradingCostUsd: number; retainedBaseByAsset: Record<string, number>; openTradingLots: number; closedCycles: number; }
export interface PortfolioReplayAction { timestamp: Date; assetSymbol: string; action: PortfolioPolicyDecision["action"]; reason: string; bandId: string; }
export interface PortfolioPolicyReplayResult { points: PortfolioReplayPoint[]; actions: PortfolioReplayAction[]; endingEquityUsd: number; endingCashUsd: number; endingTradingCostUsd: number; retainedBaseByAsset: Record<string, number>; closedCycles: number; policyParameters: PortfolioPolicyParameters; }

type Lot = PolicyLot & { id: number; bandId: string; exitPrice: number; assetSymbol: string; entrySpacing: number };
type Band = PolicyBandState & { assetSymbol: string; strategy: PortfolioReplayAllocation["strategy"]; previousPrice: number | null };

/** OHLC paths are synthetic. This validates causal accounting/policy, not intrabar execution quality. */
export class PortfolioPolicyReplayService {
  constructor(private readonly path = new CandleReplayService()) {}

  compare(request: PortfolioPolicyReplayRequest) {
    return { fixed: this.replay({ ...request, adaptive: false }), adaptive: this.replay({ ...request, adaptive: true }) };
  }

  replay(request: PortfolioPolicyReplayRequest): PortfolioPolicyReplayResult {
    validateRequest(request);
    const interval = request.candleIntervalMs ?? this.path.estimateIntervalMs(request.allocations[0]!.series.candles);
    if (!Number.isFinite(interval) || interval <= 0) throw new Error("Invalid candle interval.");
    let freeCash = request.freeCashUsd ?? 0;
    let closedCycles = 0;
    const fee = request.feeBps / 10_000, slip = (request.slippageBps ?? 0) / 10_000;
    const nativeFee = request.nativeFeeUsd ?? 0;
    const bands: Band[] = request.allocations.map((a, i) => ({ id: `${a.assetSymbol}:${i}`, assetSymbol: a.assetSymbol,
      strategy: a.strategy, lowPrice: a.lowPrice, highPrice: a.highPrice, levelCount: a.levelCount,
      spacing: (a.highPrice - a.lowPrice) / (a.levelCount - 1), status: "active",
      allocatedCapitalUsd: a.initialBudgetUsd, idleQuoteUsd: a.initialBudgetUsd, openTradingLots: [], previousPrice: null, lastRevisionAt: a.series.candles[0]!.timestamp }));
    const lots: Lot[] = [], actions: PortfolioReplayAction[] = [], points: PortfolioReplayPoint[] = [];
    const prices: Record<string, number> = {};
    const closed: Record<string, PolicyCandle[]> = Object.fromEntries(request.allocations.map(a => [a.assetSymbol, (a.warmupCandles ?? []).filter(c => +c.timestamp + interval <= +a.series.candles[0]!.timestamp).map(c => ({ openedAt: c.timestamp, closedAt: new Date(+c.timestamp + interval), open: c.open, high: c.high, low: c.low, close: c.close }))]));
    type Event = { time: number; phase: number; asset: string; price: number; candle?: HistoricalCandle };
    const events: Event[] = request.allocations.flatMap(a => a.series.candles.flatMap(c => [
      ...this.path.buildIntrabougiePath(c, interval).map((t, i) => ({ time: +t.timestamp, phase: i === 0 ? 2 : 0, asset: a.assetSymbol, price: t.price })),
      { time: +c.timestamp + interval, phase: 1, asset: a.assetSymbol, price: c.close, candle: c },
    ]));
    events.sort((a, b) => a.time - b.time || a.phase - b.phase || a.asset.localeCompare(b.asset));
    const totalCash = () => freeCash + bands.reduce((s, b) => s + b.idleQuoteUsd, 0);
    const attributions = (asset: string) => bands.filter(b => b.assetSymbol === asset).reduce((s, b) => s + b.allocatedCapitalUsd, 0);
    for (const event of events) {
      const now = new Date(event.time);
      prices[event.asset] = event.price;
      if (!event.candle) {
        // Lot ownership and target never depend on the current entry-grid revision.
        for (const lot of lots.filter(l => l.assetSymbol === event.asset && l.kind !== "retained" && l.remainingBaseAmount > 0)) {
          if (event.price < lot.exitPrice) continue;
          const band = bands.find(b => b.id === lot.bandId)!;
          const netUnit = event.price * (1 - slip) * (1 - fee);
          const sold = band.strategy === "accumulate_base" ? Math.ceil((lot.costQuote + nativeFee) / netUnit * 1e8) / 1e8 : lot.remainingBaseAmount;
          if (sold > lot.remainingBaseAmount || (band.strategy === "accumulate_base" && lot.remainingBaseAmount - sold < 1e-8)) continue;
          const net = sold * netUnit - nativeFee;
          if (net + 1e-9 < lot.costQuote) continue;
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
            const base = Math.floor((spend - nativeFee) * (1 - fee) / (event.price * (1 + slip)) * 1e8) / 1e8;
            if (base <= 0) continue;
            band.idleQuoteUsd = Math.max(0, band.idleQuoteUsd - spend);
            lots.push({ id: lots.length, bandId: band.id, assetSymbol: event.asset, entryPrice: rail,
              remainingBaseAmount: base, costQuote: spend, kind: "trading", exitPrice: rail + band.spacing, entrySpacing: band.spacing });
          }
        }
      } else {
        const c = event.candle;
        (closed[event.asset] ??= []).push({ openedAt: c.timestamp, closedAt: now, open: c.open, high: c.high, low: c.low, close: c.close });
        if (request.adaptive !== false) {
          for (const band of bands.filter(b => b.assetSymbol === event.asset)) {
            const sameDay = band.lastRevisionAt?.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
            const assetLots = lots.filter(l => l.assetSymbol === event.asset);
            const decision = evaluatePortfolioPolicy({ now, price: event.price, assetSymbol: event.asset,
              band: { ...band, revisionsToday: sameDay ? band.revisionsToday : 0, openTradingLots: assetLots },
              bandCount: bands.filter(b => b.assetSymbol === event.asset).length, assetAttributedCapitalUsd: attributions(event.asset),
              candles: closed[event.asset]!.slice(-80), candleIntervalMs: interval, maxCandleAgeMs: interval * 2,
              availableCashUsd: freeCash, totalPortfolioCapitalUsd: request.totalStartingCapitalUsd,
              parameters: request.policyParameters });
            if (decision.action === "revise") {
              Object.assign(band, { lowPrice: decision.nextLowPrice!, highPrice: decision.nextHighPrice!,
                levelCount: decision.nextLevelCount!, spacing: decision.nextSpacing!, previousPrice: null,
                lastRevisionAt: now, revisionsToday: (sameDay ? band.revisionsToday ?? 0 : 0) + 1, status: "active" });
            } else if (decision.action === "park") band.status = "parked";
            else if (decision.action === "reactivate") { band.status = "active"; band.previousPrice = null; }
            else if (decision.action === "create_band" && decision.candidate) {
              const candidate = decision.candidate;
              const least = [...new Set(bands.map(b => b.assetSymbol))].sort((a, b) => attributions(a) - attributions(b) || a.localeCompare(b))[0];
              if (least !== event.asset || candidate.requestedCapitalUsd > freeCash) continue;
              freeCash -= candidate.requestedCapitalUsd;
              band.status = "parked";
              bands.push({ ...band, id: `${event.asset}:${bands.length}`, lowPrice: candidate.lowPrice,
                highPrice: candidate.highPrice, levelCount: candidate.levelCount, spacing: candidate.spacing,
                allocatedCapitalUsd: candidate.requestedCapitalUsd, idleQuoteUsd: candidate.requestedCapitalUsd,
                previousPrice: null, status: "active", lastRevisionAt: now, revisionsToday: 1, openTradingLots: [] });
            }
            if (decision.action !== "wait") actions.push({ timestamp: now, assetSymbol: event.asset, action: decision.action, reason: decision.reason, bandId: band.id });
          }
        }
        const retainedBaseByAsset: Record<string, number> = {};
        for (const lot of lots.filter(l => l.kind === "retained")) retainedBaseByAsset[lot.assetSymbol] = (retainedBaseByAsset[lot.assetSymbol] ?? 0) + lot.remainingBaseAmount;
        points.push({ timestamp: now, priceByAsset: { ...prices }, cashUsd: totalCash(),
          equityUsd: totalCash() + lots.reduce((s, l) => s + l.remainingBaseAmount * (prices[l.assetSymbol] ?? 0), 0),
          tradingCostUsd: lots.reduce((s, l) => s + l.costQuote, 0), retainedBaseByAsset,
          openTradingLots: lots.filter(l => l.kind !== "retained" && l.remainingBaseAmount > 0).length, closedCycles });
      }
    }
    const last = points.at(-1);
    return { points, actions, endingCashUsd: totalCash(), endingEquityUsd: last?.equityUsd ?? totalCash(),
      endingTradingCostUsd: last?.tradingCostUsd ?? 0, retainedBaseByAsset: last?.retainedBaseByAsset ?? {},
      closedCycles, policyParameters: { ...request.policyParameters } };
  }
}

function validateRequest(r: PortfolioPolicyReplayRequest) {
  if (!r.allocations.length || new Set(r.allocations.map(a => a.assetSymbol)).size !== r.allocations.length ||
    ![r.totalStartingCapitalUsd, r.freeCashUsd ?? 0, r.feeBps, r.slippageBps ?? 0, r.nativeFeeUsd ?? 0, r.minOrderQuoteUsd ?? 0].every(v => Number.isFinite(v) && v >= 0) ||
    r.feeBps >= 10_000 || (r.slippageBps ?? 0) >= 10_000) throw new Error("Invalid portfolio replay request.");
  if (Math.abs(r.allocations.reduce((s, a) => s + a.initialBudgetUsd, r.freeCashUsd ?? 0) - r.totalStartingCapitalUsd) > 1e-8) throw new Error("Allocations and free cash must equal total starting capital.");
  for (const a of r.allocations) {
    if (!Number.isFinite(a.initialBudgetUsd) || a.initialBudgetUsd < 0 || !Number.isInteger(a.levelCount) || a.levelCount < 2 ||
      !Number.isFinite(a.lowPrice) || !Number.isFinite(a.highPrice) || a.lowPrice <= 0 || a.highPrice <= a.lowPrice || !a.series.candles.length) throw new Error("Invalid allocation.");
    if (!a.series.candles.every((c, i) => c.timestamp instanceof Date && Number.isFinite(+c.timestamp) &&
      (i === 0 || +c.timestamp > +a.series.candles[i - 1]!.timestamp) &&
      [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))) throw new Error("Invalid historical candles.");
  }
}
