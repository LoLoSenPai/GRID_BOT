import { IndicatorService } from "./indicator-service";
import { gridCostFloorPct } from "../utils/grid-cost-floor";
export type PortfolioPolicyAction = "wait" | "revise" | "park" | "reactivate" | "create_band";
export interface PolicyCandle { openedAt: Date; closedAt: Date; open: number; high: number; low: number; close: number; }
export interface PolicyLot { entryPrice: number; remainingBaseAmount: number; costQuote: number; kind?: "trading" | "retained"; }
export interface PolicyBandState { id: string; lowPrice: number; highPrice: number; levelCount: number; spacing: number; status: "active" | "parked"; allocatedCapitalUsd: number; idleQuoteUsd: number; openTradingLots: PolicyLot[]; commitments?: Array<{ lowPrice: number; highPrice: number; reason?: string }>; lastRevisionAt?: Date | null; revisionsToday?: number; }
export interface PortfolioPolicyInput { now: Date; price: number; assetSymbol: string; band: PolicyBandState; bandCount: number; assetAttributedCapitalUsd: number; candles: PolicyCandle[]; candleIntervalMs: number; maxCandleAgeMs: number; indicators?: { observedAt?: Date; atrPct?: number; realizedVolPct?: number; amplitudePct?: number; fillFrequencyPerDay?: number }; availableCashUsd: number; totalPortfolioCapitalUsd: number; parameters: PortfolioPolicyParameters; }
export interface PortfolioPolicyParameters { persistenceClosedBars: number; cooldownMs: number; maxDailyRevisions: number; atrMultiplier: number; realizedVolMultiplier: number; amplitudeMultiplier: number; minWidthPct: number; maxWidthPct: number; minUsefulOrderUsd: number; maxBands: number; maxLevels: number; maxExposurePct: number; lowerBandOffsetPct: number; lowerBandWidthPct: number; minimumSpacingPct: number; minimumMovementPct?: number; estimatedExecutionFeeBps?: number; estimatedSlippageBps?: number; }
export interface PortfolioPolicyDecision { action: PortfolioPolicyAction; reason: string; nextLowPrice: number | null; nextHighPrice: number | null; nextLevelCount: number | null; nextSpacing: number | null; protectedLowPrice: number | null; protectedHighPrice: number | null; candidate?: { lowPrice: number; highPrice: number; levelCount: number; spacing: number; requestedCapitalUsd: number }; }
export interface DuplicateExposureInput { oldEntryPrice: number; currentPrice: number; widerSpacing: number; openTradingLot: boolean; }
export interface AssetAllocationState { assetSymbol: string; historicalAllocatedCapitalUsd: number; idleAssignedCapitalUsd: number; initialTargetUsd: number; }

/** Exploratory paper defaults, fixed before evaluation; not a profitability recommendation. */
export const DEFAULT_PORTFOLIO_POLICY: Readonly<PortfolioPolicyParameters> = Object.freeze({
  persistenceClosedBars: 3, cooldownMs: 6 * 3_600_000, maxDailyRevisions: 3,
  atrMultiplier: 6, realizedVolMultiplier: 6, amplitudeMultiplier: 3,
  minWidthPct: 6, maxWidthPct: 24, minUsefulOrderUsd: 25,
  maxBands: 3, maxLevels: 24, maxExposurePct: 70,
  lowerBandOffsetPct: 3, lowerBandWidthPct: 6, minimumSpacingPct: 0.4, minimumMovementPct: 0.75,
  estimatedExecutionFeeBps: 10, estimatedSlippageBps: 50,
});

export function evaluatePortfolioPolicy(input: PortfolioPolicyInput): PortfolioPolicyDecision {
  const invalid = validateInput(input);
  if (invalid) return result("wait", invalid);
  const { band, parameters: p } = input;
  const candles = input.candles.filter(c => c.closedAt <= input.now).sort((a, b) => +a.closedAt - +b.closedAt);
  const recent = candles.slice(-p.persistenceClosedBars);
  const below = input.price < band.lowPrice;
  const above = input.price > band.highPrice;
  if (band.status === "parked" && !below && !above && recent.every(c => c.close >= band.lowPrice && c.close <= band.highPrice)) {
    return result("reactivate", "Confirmed return inside the existing band.");
  }
  if ((below && !recent.every(c => c.close < band.lowPrice)) || (above && !recent.every(c => c.close > band.highPrice))) {
    return result("wait", "Waiting for contiguous same-side closed-bar confirmation.");
  }
  if ((band.lastRevisionAt && +input.now - +band.lastRevisionAt < p.cooldownMs) || (band.revisionsToday ?? 0) >= p.maxDailyRevisions) {
    return result("wait", "Revision cooldown or daily limit reached.");
  }
  // Each candidate uses only its own historical prefix. A transient wick cannot move the envelope.
  const candidates = recent.map((_, i) => envelope(candles.slice(0, candles.length - recent.length + i + 1), p));
  const oldCenter = (band.lowPrice + band.highPrice) / 2;
  const oldWidth = band.highPrice - band.lowPrice;
  const moved = candidates.every(c => Math.abs(c.center / oldCenter - 1) * 100 >= (p.minimumMovementPct ?? p.minimumSpacingPct)) &&
    (candidates.every(c => c.center > oldCenter) || candidates.every(c => c.center < oldCenter));
  const resized = candidates.every(c => Math.abs((c.high - c.low) / oldWidth - 1) >= 0.2) &&
    (candidates.every(c => c.high - c.low > oldWidth) || candidates.every(c => c.high - c.low < oldWidth));
  if (!below && !above && !moved && !resized) return result("wait", "No persistent change in center or volatility.");
  const proposed = candidates.at(-1)!;
  if (input.price < proposed.low || input.price > proposed.high) return result("wait", "Current market moved outside the closed-bar candidate; wait for confirmation.");
  const lots = band.openTradingLots.filter(l => l.kind !== "retained" && l.remainingBaseAmount > 0 && l.costQuote > 0);
  const usefulEntries = Array.from({ length: proposed.levelCount - 1 }, (_, i) => proposed.low + i * proposed.spacing)
    .filter(price => !lots.some(l => blocksDuplicateEntry({ oldEntryPrice: l.entryPrice, currentPrice: price,
      widerSpacing: Math.max(band.spacing, proposed.spacing), openTradingLot: true })));
  const protectedPrices = lots.map(l => l.entryPrice).concat((band.commitments ?? []).flatMap(c => [c.lowPrice, c.highPrice]));
  const protection = { protectedLowPrice: protectedPrices.length ? Math.min(...protectedPrices) : null,
    protectedHighPrice: protectedPrices.length ? Math.max(...protectedPrices) : null };
  // Revising spends no new capital. Old lot targets need not fit inside this new envelope.
  if (usefulEntries.length && band.idleQuoteUsd >= p.minUsefulOrderUsd) {
    return { ...result("revise", "Adapt future entries while keeping existing lot exits unchanged."), ...protection,
      nextLowPrice: proposed.low, nextHighPrice: proposed.high, nextLevelCount: proposed.levelCount, nextSpacing: proposed.spacing };
  }
  if (!below || !lots.length) return { ...result("wait", "No useful funded entry; existing exits remain active."), ...protection };
  const requiredCapital = p.minUsefulOrderUsd * (proposed.levelCount - 1);
  const exposureAfter = (input.assetAttributedCapitalUsd + requiredCapital) / input.totalPortfolioCapitalUsd * 100;
  if (usefulEntries.length && input.bandCount < p.maxBands && input.availableCashUsd >= requiredCapital && exposureAfter <= p.maxExposurePct) {
    return { ...result("create_band", "Lower band is a funded fallback for immobilized inventory."), ...protection,
      candidate: { lowPrice: proposed.low, highPrice: proposed.high, levelCount: proposed.levelCount,
        spacing: proposed.spacing, requestedCapitalUsd: requiredCapital } };
  }
  return { ...result("park", "Lower band cannot be funded safely; hold inventory and preserve its exits."), ...protection };
}

export function blocksDuplicateEntry(input: DuplicateExposureInput): boolean {
  return input.openTradingLot && [input.oldEntryPrice, input.currentPrice, input.widerSpacing].every(Number.isFinite) &&
    input.widerSpacing > 0 && Math.abs(input.currentPrice - input.oldEntryPrice) <= input.widerSpacing / 2;
}

export function prioritizeAssetAllocation(assets: AssetAllocationState[]): AssetAllocationState[] {
  return [...assets].sort((a, b) => (b.initialTargetUsd - b.historicalAllocatedCapitalUsd - b.idleAssignedCapitalUsd) -
    (a.initialTargetUsd - a.historicalAllocatedCapitalUsd - a.idleAssignedCapitalUsd) || a.assetSymbol.localeCompare(b.assetSymbol));
}

/** Initial envelope uses the same validated, closed observations as subsequent revisions. */
export function initialPortfolioEnvelope(candles: PolicyCandle[], now: Date, parameters = DEFAULT_PORTFOLIO_POLICY) {
  const closed = candles.filter(c => c.closedAt <= now).sort((a, b) => +a.closedAt - +b.closedAt);
  const price = closed.at(-1)?.close ?? Number.NaN;
  const invalid = validateInput({ now, price, assetSymbol: "INITIAL", candles, candleIntervalMs: 3_600_000,
    maxCandleAgeMs: 2 * 3_600_000, parameters, bandCount: 1, assetAttributedCapitalUsd: 1000,
    availableCashUsd: 0, totalPortfolioCapitalUsd: 2000,
    band: { id: "initial", lowPrice: price * 0.9, highPrice: price * 1.1, levelCount: 2, spacing: price * 0.2,
      allocatedCapitalUsd: 1000, idleQuoteUsd: 1000, status: "active", openTradingLots: [] } });
  if (invalid) throw new Error(invalid);
  const e = envelope(closed, parameters);
  return { lowPrice: e.low, highPrice: e.high, levelCount: e.levelCount };
}

function envelope(candles: PolicyCandle[], p: PortfolioPolicyParameters) {
  const sample = candles.slice(-20);
  const center = average(sample.slice(-p.persistenceClosedBars).map(c => c.close));
  const indicators = new IndicatorService().compute(candles.map(c => ({ timestamp: c.openedAt,
    open: c.open, high: c.high, low: c.low, close: c.close }))).latest;
  const atrPct = indicators?.atrPct14 ?? 0;
  const volPct = indicators?.realizedVol20 ?? 0;
  const amplitudePct = average(sample.map(c => (c.high - c.low) / c.close * 100));
  const widthPct = Math.min(p.maxWidthPct, Math.max(p.minWidthPct, atrPct * p.atrMultiplier,
    volPct * p.realizedVolMultiplier, amplitudePct * p.amplitudeMultiplier));
  const low = center * (1 - widthPct / 200), high = center * (1 + widthPct / 200);
  const costSpacingPct = p.estimatedExecutionFeeBps !== undefined || p.estimatedSlippageBps !== undefined
    ? gridCostFloorPct(p.estimatedSlippageBps ?? 0, p.estimatedExecutionFeeBps ?? 0) + 0.25 : 0;
  const minimumSpacing = high * Math.max(p.minimumSpacingPct, atrPct * 0.5, costSpacingPct) / 100;
  const levelCount = Math.max(2, Math.min(p.maxLevels, Math.floor((high - low) / minimumSpacing) + 1));
  return { low, high, center, levelCount, spacing: (high - low) / (levelCount - 1) };
}

function validateInput(input: PortfolioPolicyInput): string | null {
  const { band, parameters: p } = input;
  if (!(input.now instanceof Date) || !Number.isFinite(+input.now) || !Number.isFinite(input.price) || input.price <= 0) return "Invalid timestamp or price.";
  const numeric = [band.lowPrice, band.highPrice, band.levelCount, band.spacing, band.allocatedCapitalUsd, band.idleQuoteUsd,
    input.candleIntervalMs, input.maxCandleAgeMs, input.bandCount, input.assetAttributedCapitalUsd, input.availableCashUsd,
    input.totalPortfolioCapitalUsd, ...Object.values(p)];
  if (!numeric.every(v => Number.isFinite(v) && v >= 0) || band.lowPrice <= 0 || band.highPrice <= band.lowPrice || band.spacing <= 0 ||
    !Number.isInteger(band.levelCount) || band.levelCount < 2 || input.totalPortfolioCapitalUsd <= 0 || input.candleIntervalMs <= 0 ||
    input.maxCandleAgeMs < input.candleIntervalMs || !Number.isInteger(input.bandCount) || input.bandCount < 1 ||
    !Number.isInteger(p.persistenceClosedBars) || p.persistenceClosedBars < 1 || p.persistenceClosedBars > 20 ||
    !Number.isInteger(p.maxLevels) || p.maxLevels < 2 || !Number.isInteger(p.maxBands) || p.maxBands < 1 ||
    !Number.isInteger(p.maxDailyRevisions) || p.maxExposurePct > 100 || p.minUsefulOrderUsd <= 0 || p.minimumSpacingPct <= 0 ||
    p.minWidthPct <= 0 || p.maxWidthPct < p.minWidthPct || p.maxWidthPct >= 100) return "Invalid policy or capital parameters.";
  if (band.lastRevisionAt && (!Number.isFinite(+band.lastRevisionAt) || band.lastRevisionAt > input.now)) return "Invalid revision timestamp.";
  if (!band.openTradingLots.every(l => [l.entryPrice, l.remainingBaseAmount, l.costQuote].every(v => Number.isFinite(v) && v >= 0))) return "Invalid lot exposure.";
  const candles = input.candles.filter(c => c.closedAt instanceof Date && c.closedAt <= input.now).sort((a, b) => +a.closedAt - +b.closedAt);
  if (candles.length < 20 + p.persistenceClosedBars - 1) return "Incomplete closed-candle history.";
  if (!candles.every(c => c.openedAt instanceof Date && Number.isFinite(+c.openedAt) && Number.isFinite(+c.closedAt) &&
    +c.closedAt - +c.openedAt === input.candleIntervalMs && [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) &&
    c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close))) return "Invalid OHLC history.";
  if (+input.now - +candles.at(-1)!.closedAt > input.maxCandleAgeMs) return "Closed-candle history is stale.";
  if (candles.some((c, i) => i > 0 && +c.closedAt - +candles[i - 1]!.closedAt !== input.candleIntervalMs)) return "Closed-candle history is not contiguous.";
  return null;
}
function average(values: number[]) { return values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length); }
function result(action: PortfolioPolicyAction, reason: string): PortfolioPolicyDecision {
  return { action, reason, nextLowPrice: null, nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
}
