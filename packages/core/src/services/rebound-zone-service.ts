import type { HistoricalCandle } from "../domain/types";

/** A support/resistance range supported by independently confirmed pivots. */
export interface ReboundRangeCandidate {
  lowPrice: number;
  highPrice: number;
  supportTouches: number;
  resistanceTouches: number;
  lastSupportAt: Date;
  lastResistanceAt: Date;
  firstObservedAt: Date;
  widthPct: number;
  zoneTolerancePct: number;
  /** A deterministic ranking heuristic, not a probability or confidence. */
  score: number;
  reasons: string[];
}

export interface ReboundZoneAnalysis {
  ranges: ReboundRangeCandidate[];
  reasons: string[];
}

export interface ReboundZoneOptions {
  asOf?: Date;
  maxRanges?: number;
}

const RIGHT_WINDOW = 2;
const MIN_TOUCHES = 3;
const MIN_TOUCH_SEPARATION_BARS = 3;
const MIN_WIDTH_PCT = 4;
const MAX_WIDTH_PCT = 35;
const MIN_TOLERANCE_PCT = 0.5;
const MAX_TOLERANCE_PCT = 3;
const TOLERANCE_TR_MULTIPLIER = 1.75;
const MAX_RESULT_COUNT = 3;

interface PreparedCandle extends HistoricalCandle {
  index: number;
}

interface Pivot {
  index: number;
  price: number;
  timestamp: Date;
}

interface LevelCluster {
  center: number;
  pivots: Pivot[];
  independentPivots: Pivot[];
}

/**
 * Finds bounded, explainable rebound zones from confirmed historical pivots.
 *
 * The method is pure: it never mutates the input and evaluates only candles at
 * or before `asOf`. All thresholds are intentionally fixed and documented
 * above so that the result is auditable rather than an optimized probability.
 */
export class ReboundZoneService {
  analyze(candles: HistoricalCandle[], options: ReboundZoneOptions = {}): ReboundZoneAnalysis {
    const asOfMs = options.asOf?.getTime();
    if (options.asOf !== undefined && !Number.isFinite(asOfMs)) {
      return { ranges: [], reasons: ["The asOf date is invalid; no rebound zones were evaluated."] };
    }

    if (!Array.isArray(candles) || candles.length === 0) {
      return { ranges: [], reasons: ["No candles were supplied; at least one valid candle is required."] };
    }

    // Cut off first: bars that are not known at asOf must not affect the read,
    // including whether a known sequence is ordered or contains duplicates.
    const known = candles
      .filter((candle) => asOfMs === undefined || isObject(candle) && candle.timestamp instanceof Date && candle.timestamp.getTime() <= asOfMs)
      .map((candle, index) => isObject(candle) ? { ...candle, index } : { value: candle, index }) as Array<PreparedCandle | { value: unknown; index: number }>;

    if (known.length === 0) {
      return { ranges: [], reasons: ["No candles are available at the requested asOf cutoff."] };
    }

    const malformed = known.find((candle, index) => !isValidCandle(candle as HistoricalCandle) || index > 0 && isDuplicateOrNonmonotonic(candle, known[index - 1]!));
    if (malformed) {
      return {
        ranges: [],
        reasons: ["Candle history contains malformed, duplicate, or nonmonotonic known data; no zones were evaluated."]
      };
    }

    const ordered = known as PreparedCandle[];
    const maximum = normalizeMaxRanges(options.maxRanges);
    const tolerancePct = computeTolerancePct(ordered);
    const pivots = findPivots(ordered);
    const supports = clusterPivots(pivots.supports, tolerancePct, ordered, "support");
    const resistances = clusterPivots(pivots.resistances, tolerancePct, ordered, "resistance");
    const eligibleSupports = supports.filter((cluster) => cluster.independentPivots.length >= MIN_TOUCHES);
    const eligibleResistances = resistances.filter((cluster) => cluster.independentPivots.length >= MIN_TOUCHES);

    if (ordered.length < RIGHT_WINDOW * 2 + 1) {
      return { ranges: [], reasons: [`At least ${RIGHT_WINDOW * 2 + 1} candles are required to confirm pivots.`] };
    }
    if (eligibleSupports.length === 0 || eligibleResistances.length === 0) {
      return {
        ranges: [],
        reasons: [
          `No support/resistance pair reached ${MIN_TOUCHES} independent touches separated by ${MIN_TOUCH_SEPARATION_BARS} bars.`
        ]
      };
    }

    const candidates: ReboundRangeCandidate[] = [];
    for (const support of eligibleSupports) {
      for (const resistance of eligibleResistances) {
        const candidate = buildCandidate(ordered, support, resistance, tolerancePct);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    candidates.sort(compareCandidates);
    const ranges = deduplicateCandidates(candidates).slice(0, maximum);
    const reasons = ranges.length > 0
      ? [`Found ${ranges.length} rebound zone${ranges.length === 1 ? "" : "s"} from confirmed, separated pivots.`]
      : ["No candidate stayed intact through the latest known close within the bounded 4–35% width."];

    return { ranges, reasons };
  }
}

/** Convenience entry point for callers that do not need to retain a service instance. */
export function analyzeReboundZones(candles: HistoricalCandle[], options?: ReboundZoneOptions): ReboundZoneAnalysis {
  return new ReboundZoneService().analyze(candles, options);
}

function buildCandidate(
  candles: PreparedCandle[],
  support: LevelCluster,
  resistance: LevelCluster,
  tolerancePct: number
): ReboundRangeCandidate | null {
  if (support.center >= resistance.center) {
    return null;
  }

  const toleranceRatio = tolerancePct / 100;
  const lowPrice = support.center * (1 - toleranceRatio);
  const highPrice = resistance.center * (1 + toleranceRatio);
  const widthPct = ((highPrice - lowPrice) / lowPrice) * 100;
  if (!Number.isFinite(widthPct) || widthPct < MIN_WIDTH_PCT || widthPct > MAX_WIDTH_PCT) {
    return null;
  }

  const firstIndex = Math.min(support.independentPivots[0]!.index, resistance.independentPivots[0]!.index);
  if (!hasFittingLatestClose(candles, lowPrice, highPrice)) {
    return null;
  }

  const latestBreakIndex = findLastBoundaryBreak(candles, firstIndex, lowPrice, highPrice);
  const survivingSupportPivots = latestBreakIndex === -1
    ? support.independentPivots
    : selectIndependentPivots(
        support.independentPivots.filter((pivot) => pivot.index > latestBreakIndex),
        candles,
        support.center,
        tolerancePct,
        "support"
      );
  const survivingResistancePivots = latestBreakIndex === -1
    ? resistance.independentPivots
    : selectIndependentPivots(
        resistance.independentPivots.filter((pivot) => pivot.index > latestBreakIndex),
        candles,
        resistance.center,
        tolerancePct,
        "resistance"
      );
  if (survivingSupportPivots.length < MIN_TOUCHES || survivingResistancePivots.length < MIN_TOUCHES) {
    return null;
  }

  const firstObservedAt = new Date(Math.min(
    survivingSupportPivots[0]!.timestamp.getTime(),
    survivingResistancePivots[0]!.timestamp.getTime()
  ));
  const lastSupportAt = new Date(survivingSupportPivots.at(-1)!.timestamp.getTime());
  const lastResistanceAt = new Date(survivingResistancePivots.at(-1)!.timestamp.getTime());
  const supportTouches = survivingSupportPivots.length;
  const resistanceTouches = survivingResistancePivots.length;
  const score = scoreCandidate(candles, supportTouches, resistanceTouches, widthPct, lastSupportAt, lastResistanceAt);
  return {
    lowPrice: roundPrice(lowPrice),
    highPrice: roundPrice(highPrice),
    supportTouches,
    resistanceTouches,
    lastSupportAt,
    lastResistanceAt,
    firstObservedAt,
    widthPct: roundMetric(widthPct),
    zoneTolerancePct: roundMetric(tolerancePct),
    score: roundMetric(score),
    reasons: [
      `${supportTouches} independent support touches and ${resistanceTouches} independent resistance touches were confirmed at least ${MIN_TOUCH_SEPARATION_BARS} bars apart.`,
      `Zone tolerance is ${roundMetric(tolerancePct)}%, derived from median true range and clamped to ${MIN_TOLERANCE_PCT}–${MAX_TOLERANCE_PCT}%.`,
      latestBreakIndex === -1
        ? `Latest known close is inside the ${roundMetric(widthPct)}% zone; no close break was observed after the first touch.`
        : `A close break was followed by ${supportTouches} fresh support and ${resistanceTouches} fresh resistance touches before the latest close re-entered the zone.`
    ]
  };
}

function findPivots(candles: PreparedCandle[]): { supports: Pivot[]; resistances: Pivot[] } {
  const supports: Pivot[] = [];
  const resistances: Pivot[] = [];
  for (let index = RIGHT_WINDOW; index < candles.length - RIGHT_WINDOW; index += 1) {
    const current = candles[index]!;
    const left = candles.slice(index - RIGHT_WINDOW, index);
    const right = candles.slice(index + 1, index + RIGHT_WINDOW + 1);
    if (isExtreme(current.low, [...left.map((candle) => candle.low), ...right.map((candle) => candle.low)], "low")) {
      supports.push({ index, price: current.low, timestamp: new Date(current.timestamp.getTime()) });
    }
    if (isExtreme(current.high, [...left.map((candle) => candle.high), ...right.map((candle) => candle.high)], "high")) {
      resistances.push({ index, price: current.high, timestamp: new Date(current.timestamp.getTime()) });
    }
  }
  return { supports, resistances };
}

function isExtreme(value: number, neighbors: number[], direction: "low" | "high"): boolean {
  const strict = neighbors.some((neighbor) => direction === "low" ? value < neighbor : value > neighbor);
  return strict && neighbors.every((neighbor) => direction === "low" ? value <= neighbor : value >= neighbor);
}

function clusterPivots(
  pivots: Pivot[],
  tolerancePct: number,
  candles: PreparedCandle[],
  direction: "support" | "resistance"
): LevelCluster[] {
  const clusters: LevelCluster[] = [];
  for (const pivot of pivots) {
    const matching = clusters.find((cluster) => Math.abs(pivot.price - cluster.center) / cluster.center <= tolerancePct / 100);
    if (matching) {
      matching.pivots.push(pivot);
      matching.center = matching.pivots.reduce((sum, item) => sum + item.price, 0) / matching.pivots.length;
    } else {
      clusters.push({ center: pivot.price, pivots: [pivot], independentPivots: [] });
    }
  }
  for (const cluster of clusters) {
    cluster.independentPivots = selectIndependentPivots(cluster.pivots, candles, cluster.center, tolerancePct, direction);
    if (cluster.independentPivots.length > 0) {
      cluster.center = cluster.independentPivots.reduce((sum, item) => sum + item.price, 0) / cluster.independentPivots.length;
    }
  }
  return clusters;
}

function selectIndependentPivots(
  pivots: Pivot[],
  candles: PreparedCandle[],
  center: number,
  tolerancePct: number,
  direction: "support" | "resistance"
): Pivot[] {
  const independent: Pivot[] = [];
  for (const pivot of pivots) {
    const previous = independent.at(-1);
    if (!previous || pivot.index - previous.index >= MIN_TOUCH_SEPARATION_BARS && hasExcursionBetween(candles, previous.index, pivot.index, center, tolerancePct, direction)) {
      independent.push(pivot);
    }
  }
  return independent;
}

function hasExcursionBetween(
  candles: PreparedCandle[],
  previousIndex: number,
  currentIndex: number,
  center: number,
  tolerancePct: number,
  direction: "support" | "resistance"
): boolean {
  const toleranceRatio = tolerancePct / 100;
  return candles.slice(previousIndex + 1, currentIndex).some((candle) => direction === "support"
    ? candle.close > center * (1 + toleranceRatio)
    : candle.close < center * (1 - toleranceRatio));
}

function computeTolerancePct(candles: PreparedCandle[]): number {
  const trueRanges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close;
    return Math.max(
      candle.high - candle.low,
      previousClose === undefined ? 0 : Math.abs(candle.high - previousClose),
      previousClose === undefined ? 0 : Math.abs(candle.low - previousClose)
    );
  });
  const medianTrueRange = median(trueRanges);
  const medianPrice = median(candles.map((candle) => candle.close));
  const raw = medianPrice > 0 ? (medianTrueRange / medianPrice) * 100 * TOLERANCE_TR_MULTIPLIER : MAX_TOLERANCE_PCT;
  return Math.min(MAX_TOLERANCE_PCT, Math.max(MIN_TOLERANCE_PCT, raw));
}

function hasFittingLatestClose(candles: PreparedCandle[], lowPrice: number, highPrice: number): boolean {
  const latest = candles.at(-1)!;
  return latest.close >= lowPrice && latest.close <= highPrice;
}

function findLastBoundaryBreak(candles: PreparedCandle[], firstIndex: number, lowPrice: number, highPrice: number): number {
  let lastBreak = -1;
  for (const candle of candles.slice(firstIndex)) {
    if (candle.close < lowPrice || candle.close > highPrice) {
      lastBreak = candle.index;
    }
  }
  return lastBreak;
}

function scoreCandidate(
  candles: PreparedCandle[],
  supportTouches: number,
  resistanceTouches: number,
  widthPct: number,
  lastSupportAt: Date,
  lastResistanceAt: Date
): number {
  const latestMs = candles.at(-1)!.timestamp.getTime();
  const latestTouchMs = Math.max(lastSupportAt.getTime(), lastResistanceAt.getTime());
  const ageBars = candles.filter((candle) => candle.timestamp.getTime() > latestTouchMs).length;
  const recency = Math.max(0, 20 - Math.min(20, ageBars));
  const touchScore = Math.min(40, (supportTouches + resistanceTouches) * 4);
  const widthScore = Math.max(0, 25 - Math.abs(widthPct - 15));
  const asOfCoverage = latestMs >= latestTouchMs ? 1 : 0;
  return Math.min(100, touchScore + widthScore + recency + asOfCoverage);
}

function compareCandidates(left: ReboundRangeCandidate, right: ReboundRangeCandidate): number {
  return right.score - left.score
    || right.supportTouches + right.resistanceTouches - left.supportTouches - left.resistanceTouches
    || left.lowPrice - right.lowPrice
    || left.highPrice - right.highPrice
    || left.firstObservedAt.getTime() - right.firstObservedAt.getTime();
}

function deduplicateCandidates(candidates: ReboundRangeCandidate[]): ReboundRangeCandidate[] {
  const result: ReboundRangeCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = result.some((existing) => {
      const lowOverlap = Math.max(existing.lowPrice, candidate.lowPrice) <= Math.min(existing.highPrice, candidate.highPrice);
      const highOverlap = Math.min(existing.highPrice, candidate.highPrice) - Math.max(existing.lowPrice, candidate.lowPrice);
      const smallerWidth = Math.min(existing.highPrice - existing.lowPrice, candidate.highPrice - candidate.lowPrice);
      return lowOverlap && highOverlap / smallerWidth >= 0.75;
    });
    if (!duplicate) {
      result.push(candidate);
    }
  }
  return result;
}

function normalizeMaxRanges(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return MAX_RESULT_COUNT;
  }
  return Math.max(1, Math.min(MAX_RESULT_COUNT, Math.floor(value!)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidCandle(candle: HistoricalCandle): boolean {
  if (!(candle.timestamp instanceof Date) || !Number.isFinite(candle.timestamp.getTime())) {
    return false;
  }
  const values = [candle.open, candle.high, candle.low, candle.close];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return false;
  }
  if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) {
    return false;
  }
  return candle.volume === undefined || candle.volume === null || Number.isFinite(candle.volume) && candle.volume >= 0;
}

function isDuplicateOrNonmonotonic(current: unknown, previous: unknown): boolean {
  if (!isObject(current) || !isObject(previous) || !(current.timestamp instanceof Date) || !(previous.timestamp instanceof Date)) {
    return false;
  }
  return current.timestamp.getTime() <= previous.timestamp.getTime();
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
