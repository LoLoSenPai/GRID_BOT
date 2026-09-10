import { BotStatus, EntryMode } from "../domain/enums";
import type {
  BacktestBenchmarks,
  BacktestConfig,
  BacktestMarketSeries,
  BacktestMetrics,
  BacktestReplayPoint,
  BacktestRunResult
} from "../domain/types";
import { BacktestLabService } from "./backtest-lab-service";

const MONEY_TOLERANCE_USD = 1e-6;
const CAPACITY_TOLERANCE_USD = 1e-8;

export interface BacktestPortfolioAllocation {
  id: string;
  config: BacktestConfig;
}

export interface BacktestPortfolioReplayRequest {
  series: BacktestMarketSeries;
  totalBudgetUsd: number;
  /** Quote held outside the independently replayed bot allocations. */
  reserveQuoteAmount?: number;
  allocations: BacktestPortfolioAllocation[];
}

export interface BacktestPortfolioBotReplay {
  id: string;
  config: BacktestConfig;
  replay: BacktestRunResult;
}

export interface BacktestPortfolioPoint {
  /** Position in the common replay timeline. Equal timestamps are intentional. */
  index: number;
  timestamp: Date;
  phase: "train" | "validation";
  price: number;
  totalEquityUsd: number;
  /** Bot cash plus the outer reserve. This includes quote kept in bot reserves. */
  cashUsd: number;
  /** Explicit bot reserves plus the outer reserve. */
  reserveQuoteAmount: number;
  botReserveQuoteAmount: number;
  outerReserveQuoteAmount: number;
  deployedTradingCostUsd: number;
  baseQuantity: number;
  /** Retained base is not present in historical replay points; null means unknown. */
  retainedBaseQuantity: number | null;
  drawdownPct: number;
  inRangeBotIds: string[];
  eligibleOperatingBotIds: string[];
  affordableOperatingBotIds: string[];
  someBotInRange: boolean;
  someEligibleOperatingBotInRange: boolean;
  someEligibleOperatingBotInRangeAndAffordable: boolean;
  strandedTradingCostUsd: number;
  strandedBelowRangeBotIds: string[];
}

export interface BacktestPortfolioMetrics extends Omit<BacktestMetrics, "startingBudgetUsd" | "endingEquityUsd" | "realizedPnlUsd" | "unrealizedPnlUsd" | "totalPnlUsd" | "returnPct" | "maxDrawdownPct" | "closedCycleCount" | "openCycleCount" | "timeInRangePct"> {
  startingBudgetUsd: number;
  endingEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  closedCycleCount: number;
  openCycleCount: number;
  /** Time with at least one bot inside its own active rails. */
  timeInRangePct: number;
  timeAtLeastOneBotInRangePct: number;
  /** Time with an operating, non sell-only bot inside its rails. */
  timeEligibleOperatingBotInRangePct: number;
  /** Time with an eligible operating bot that also has fee-inclusive capacity. */
  timeEligibleOperatingBotInRangeAndAffordablePct: number;
  timeSomeEligibleOperatingBotInRangeAndAffordablePct: number;
  /** Ending quote balances, including the explicit outer reserve in cash. */
  cashUsd: number;
  reserveQuoteAmount: number;
  botReserveQuoteAmount: number;
  outerReserveQuoteAmount: number;
  deployedTradingCostUsd: number;
  heldBaseAmount: number;
  retainedBaseAmount: number | null;
  /** Trading cost in lots below their bot's current lower rail. */
  strandedTradingCostUsd: number;
  maxStrandedTradingCostUsd: number;
  endStrandedTradingCostUsd: number;
  eligibilityNote: string;
}

export interface BacktestPortfolioReplayResult {
  series: BacktestMarketSeries;
  totalBudgetUsd: number;
  reserveQuoteAmount: number;
  allocations: BacktestPortfolioBotReplay[];
  points: BacktestPortfolioPoint[];
  trainMetrics: BacktestPortfolioMetrics;
  validationMetrics: BacktestPortfolioMetrics;
  overallMetrics: BacktestPortfolioMetrics;
  benchmarks: BacktestBenchmarks;
  validationBenchmarks: BacktestBenchmarks;
}

type ReplayService = Pick<BacktestLabService, "replay">;

/**
 * Replays fixed allocations independently and combines their marked states.
 * There is deliberately no shared wallet, liquidation, sweep, or reallocation
 * in this service: every bot remains funded by its own config budget.
 */
export class BacktestPortfolioService {
  constructor(private readonly backtestLabService: ReplayService = new BacktestLabService()) {}

  replay(request: BacktestPortfolioReplayRequest): BacktestPortfolioReplayResult {
    validateRequest(request);

    const outerReserveQuoteAmount = request.reserveQuoteAmount ?? 0;
    const allocations = request.allocations.map(({ id, config }) => {
      const replay = this.backtestLabService.replay({ series: request.series, config });
      return { id, config: replay.config, replay };
    });
    if (Math.abs(sum(allocations.map(({ config }) => config.budgetUsd)) + outerReserveQuoteAmount - request.totalBudgetUsd) > MONEY_TOLERANCE_USD) {
      throw new Error("Normalized portfolio allocation budgets plus outer reserve must equal totalBudgetUsd.");
    }

    const points = buildPortfolioPoints(request, allocations, outerReserveQuoteAmount);
    const trainMetrics = this.buildMetrics("train", points, allocations, request.totalBudgetUsd, outerReserveQuoteAmount);
    const validationMetrics = this.buildMetrics("validation", points, allocations, trainMetrics.endingEquityUsd, outerReserveQuoteAmount);
    const overallMetrics = this.buildMetrics("overall", points, allocations, request.totalBudgetUsd, outerReserveQuoteAmount);
    const benchmarks = aggregateBenchmarks(allocations, "benchmarks", outerReserveQuoteAmount, request.totalBudgetUsd);
    const validationBenchmarks = aggregateBenchmarks(allocations, "validationBenchmarks", outerReserveQuoteAmount, validationMetrics.startingBudgetUsd);

    return {
      series: request.series,
      totalBudgetUsd: request.totalBudgetUsd,
      reserveQuoteAmount: outerReserveQuoteAmount,
      allocations,
      points,
      trainMetrics,
      validationMetrics,
      overallMetrics,
      benchmarks,
      validationBenchmarks
    };
  }

  private buildMetrics(
    phase: "train" | "validation" | "overall",
    points: BacktestPortfolioPoint[],
    allocations: BacktestPortfolioBotReplay[],
    startingBudgetUsd: number,
    outerReserveQuoteAmount: number
  ): BacktestPortfolioMetrics {
    const phasePoints = phase === "overall" ? points : points.filter((point) => point.phase === phase);
    const endingPoint = phasePoints.at(-1) ?? points.at(-1);
    const endingEquityUsd = endingPoint?.totalEquityUsd ?? startingBudgetUsd;
    const realizedPnlUsd = phase === "overall"
      ? sum(allocations.map(({ replay }) => replay.overallMetrics.realizedPnlUsd))
      : sum(allocations.map(({ replay }) => phase === "train" ? replay.trainMetrics.realizedPnlUsd : replay.validationMetrics.realizedPnlUsd));
    const unrealizedPnlUsd = phase === "overall"
      ? sum(allocations.map(({ replay }) => replay.overallMetrics.unrealizedPnlUsd))
      : sum(allocations.map(({ replay }) => phase === "train" ? replay.trainMetrics.unrealizedPnlUsd : replay.validationMetrics.unrealizedPnlUsd));
    const ratio = (predicate: (point: BacktestPortfolioPoint) => boolean) => weightedRatio(phasePoints, points, predicate);
    const maxDrawdownPct = phasePoints.reduce((max, point) => Math.max(max, point.drawdownPct), 0);
    const endingReplayMetrics = allocations.map(({ replay }) => phase === "train" ? replay.trainMetrics : phase === "validation" ? replay.validationMetrics : replay.overallMetrics);
    const phaseReplayMetrics = allocations.map(({ replay }) => phase === "train" ? replay.trainMetrics : phase === "validation" ? replay.validationMetrics : replay.overallMetrics);
    const endStrandedTradingCostUsd = endingPoint?.strandedTradingCostUsd ?? 0;
    const metrics: BacktestPortfolioMetrics = {
      sampleCount: phasePoints.length,
      startingBudgetUsd: roundMoney(startingBudgetUsd),
      endingEquityUsd: roundMoney(endingEquityUsd),
      realizedPnlUsd: roundMoney(realizedPnlUsd),
      unrealizedPnlUsd: roundMoney(unrealizedPnlUsd),
      totalPnlUsd: roundMoney(endingEquityUsd - startingBudgetUsd),
      returnPct: startingBudgetUsd > 0 ? roundMoney(((endingEquityUsd - startingBudgetUsd) / startingBudgetUsd) * 100) : 0,
      maxDrawdownPct: roundMoney(maxDrawdownPct),
      maxOccupancyPct: phasePoints.reduce((max, point) => Math.max(max, point.deployedTradingCostUsd / Math.max(startingBudgetUsd, MONEY_TOLERANCE_USD) * 100), 0),
      timeInRangePct: ratio((point) => point.someBotInRange),
      timeOutOfRangePct: ratio((point) => !point.someBotInRange),
      closedCycleCount: sum(phaseReplayMetrics.map((metric) => metric.closedCycleCount)),
      openCycleCount: sum(endingReplayMetrics.map((metric) => metric.openCycleCount)),
      executedBuyCount: sum(phaseReplayMetrics.map((metric) => metric.executedBuyCount)),
      executedSellCount: sum(phaseReplayMetrics.map((metric) => metric.executedSellCount)),
      blockedOrderCount: sum(phaseReplayMetrics.map((metric) => metric.blockedOrderCount)),
      simulatedOrderCount: sum(phaseReplayMetrics.map((metric) => metric.simulatedOrderCount)),
      recenterCount: sum(phaseReplayMetrics.map((metric) => metric.recenterCount)),
      rangeAdjustmentCount: sum(phaseReplayMetrics.map((metric) => metric.rangeAdjustmentCount)),
      totalFeesUsd: roundMoney(sum(phaseReplayMetrics.map((metric) => metric.totalFeesUsd))),
      averageSlippageBps: weightedAverageSlippage(phaseReplayMetrics),
      timeAtLeastOneBotInRangePct: ratio((point) => point.someBotInRange),
      timeEligibleOperatingBotInRangePct: ratio((point) => point.someEligibleOperatingBotInRange),
      timeEligibleOperatingBotInRangeAndAffordablePct: ratio((point) => point.someEligibleOperatingBotInRangeAndAffordable),
      timeSomeEligibleOperatingBotInRangeAndAffordablePct: ratio((point) => point.someEligibleOperatingBotInRangeAndAffordable),
      cashUsd: roundMoney(endingPoint?.cashUsd ?? startingBudgetUsd),
      reserveQuoteAmount: roundMoney(endingPoint?.reserveQuoteAmount ?? totalReserve(allocations, outerReserveQuoteAmount)),
      botReserveQuoteAmount: roundMoney(endingPoint?.botReserveQuoteAmount ?? sum(allocations.map(({ config }) => config.reserveQuoteAmount ?? 0))),
      outerReserveQuoteAmount: roundMoney(outerReserveQuoteAmount),
      deployedTradingCostUsd: roundMoney(endingPoint?.deployedTradingCostUsd ?? 0),
      heldBaseAmount: roundBase(endingPoint?.baseQuantity ?? 0),
      retainedBaseAmount: endingPoint?.retainedBaseQuantity ?? null,
      strandedTradingCostUsd: roundMoney(endStrandedTradingCostUsd),
      maxStrandedTradingCostUsd: roundMoney(phasePoints.reduce((max, point) => Math.max(max, point.strandedTradingCostUsd), 0)),
      endStrandedTradingCostUsd: roundMoney(endStrandedTradingCostUsd),
      eligibilityNote: "Eligibility is a duration-weighted readiness proxy: Running status, non sell-only entry, below drawdown gate, in range, and fee-inclusive minimum-order capacity. It does not guarantee a new trade."
    };

    return metrics;
  }
}

function validateRequest(request: BacktestPortfolioReplayRequest) {
  if (!Number.isFinite(request.totalBudgetUsd) || request.totalBudgetUsd < 0) {
    throw new Error("Portfolio totalBudgetUsd must be a finite nonnegative number.");
  }
  const outerReserve = request.reserveQuoteAmount ?? 0;
  if (!Number.isFinite(outerReserve) || outerReserve < 0) {
    throw new Error("Portfolio reserveQuoteAmount must be a finite nonnegative number.");
  }
  if (!Array.isArray(request.allocations) || request.allocations.length === 0) {
    throw new Error("Portfolio replay requires at least one allocation.");
  }
  const ids = new Set<string>();
  let allocated = 0;
  for (const allocation of request.allocations) {
    if (!allocation.id || ids.has(allocation.id)) {
      throw new Error("Portfolio allocation ids must be unique and nonempty.");
    }
    ids.add(allocation.id);
    const config = allocation.config;
    if (!Number.isFinite(config.budgetUsd) || config.budgetUsd < 0) {
      throw new Error(`Portfolio allocation ${allocation.id} budgetUsd must be a finite nonnegative number.`);
    }
    const reserve = config.reserveQuoteAmount ?? 0;
    const maxDeployable = config.maxDeployableUsd ?? Math.max(0, config.budgetUsd - reserve);
    if (!Number.isFinite(reserve) || reserve < 0 || reserve > config.budgetUsd + MONEY_TOLERANCE_USD) {
      throw new Error(`Portfolio allocation ${allocation.id} reserveQuoteAmount must be within its budget.`);
    }
    if (!Number.isFinite(maxDeployable) || maxDeployable < 0 || maxDeployable > config.budgetUsd - reserve + MONEY_TOLERANCE_USD) {
      throw new Error(`Portfolio allocation ${allocation.id} maxDeployableUsd must be within its budget after reserve.`);
    }
    allocated += config.budgetUsd;
  }
  if (Math.abs(allocated + outerReserve - request.totalBudgetUsd) > MONEY_TOLERANCE_USD) {
    throw new Error("Portfolio allocation budgets plus outer reserve must equal totalBudgetUsd.");
  }
  if (!request.series.candles || request.series.candles.length < 2) {
    throw new Error("Portfolio replay requires at least two candles.");
  }
}

function buildPortfolioPoints(
  request: BacktestPortfolioReplayRequest,
  allocations: BacktestPortfolioBotReplay[],
  outerReserveQuoteAmount: number
): BacktestPortfolioPoint[] {
  const firstReplay = allocations[0]!.replay;
  const pointCount = firstReplay.replayPoints.length;
  for (const allocation of allocations) {
    if (allocation.replay.replayPoints.length !== pointCount) {
      throw new Error("Portfolio allocations must replay the same observation timeline.");
    }
  }

  const points: BacktestPortfolioPoint[] = [];
  let peakEquityUsd = request.totalBudgetUsd;
  for (let index = 0; index < pointCount; index += 1) {
    const botPoints = allocations.map(({ id, config, replay }) => ({ id, config, point: replay.replayPoints[index]! }));
    for (const bot of botPoints) {
      validateReplayPoint(bot.id, index, bot.point);
    }
    const reference = botPoints[0]!.point;
    for (const bot of botPoints.slice(1)) {
      if (!sameObservation(reference, bot.point)) {
        throw new Error("Portfolio allocations must use the same series and timestamps.");
      }
    }
    const cashUsd = outerReserveQuoteAmount + sum(botPoints.map(({ point }) => point.availableQuoteAmount));
    const deployedTradingCostUsd = sum(botPoints.map(({ point }) => point.deployedQuoteAmount));
    const baseQuantity = sum(botPoints.map(({ point }) => point.availableBaseAmount));
    const retainedBaseValues = botPoints.map(({ point }) => point.retainedBaseAmount);
    const retainedBaseQuantity = retainedBaseValues.every((value): value is number => Number.isFinite(value))
      ? roundBase(sum(retainedBaseValues))
      : null;
    const totalEquityUsd = roundMoney(outerReserveQuoteAmount + sum(botPoints.map(({ point }) => point.totalEquityUsd)));
    peakEquityUsd = Math.max(peakEquityUsd, totalEquityUsd);
    const inRangeBotIds = botPoints.filter(({ point }) => point.price >= point.activeLowPrice && point.price <= point.activeHighPrice).map(({ id }) => id);
    const eligibleOperatingBotIds = botPoints.filter(({ config, point }) => isEligibleOperating(config, point) && inRange(point)).map(({ id }) => id);
    const affordableOperatingBotIds = botPoints.filter(({ config, point }) => isEligibleOperating(config, point) && inRange(point) && canAffordMinimumOrder(config, point)).map(({ id }) => id);
    const stranded = botPoints.filter(({ point }) => point.price < point.activeLowPrice && point.deployedQuoteAmount > 0);
    const strandedTradingCostUsd = sum(stranded.map(({ point }) => point.deployedQuoteAmount));
    const botReserveQuoteAmount = sum(botPoints.map(({ config }) => config.reserveQuoteAmount ?? 0));
    points.push({
      index,
      timestamp: reference.timestamp,
      phase: reference.phase,
      price: reference.price,
      totalEquityUsd,
      cashUsd: roundMoney(cashUsd),
      reserveQuoteAmount: roundMoney(outerReserveQuoteAmount + botReserveQuoteAmount),
      botReserveQuoteAmount: roundMoney(botReserveQuoteAmount),
      outerReserveQuoteAmount: roundMoney(outerReserveQuoteAmount),
      deployedTradingCostUsd: roundMoney(deployedTradingCostUsd),
      baseQuantity: roundBase(baseQuantity),
      retainedBaseQuantity,
      drawdownPct: peakEquityUsd > 0 ? roundMoney(Math.max(0, (peakEquityUsd - totalEquityUsd) / peakEquityUsd * 100)) : 0,
      inRangeBotIds,
      eligibleOperatingBotIds,
      affordableOperatingBotIds,
      someBotInRange: inRangeBotIds.length > 0,
      someEligibleOperatingBotInRange: eligibleOperatingBotIds.length > 0,
      someEligibleOperatingBotInRangeAndAffordable: affordableOperatingBotIds.length > 0,
      strandedTradingCostUsd: roundMoney(strandedTradingCostUsd),
      strandedBelowRangeBotIds: stranded.map(({ id }) => id)
    });
  }
  return points;
}

function sameObservation(left: BacktestReplayPoint, right: BacktestReplayPoint) {
  return left.timestamp.getTime() === right.timestamp.getTime() && left.phase === right.phase && left.price === right.price;
}

function validateReplayPoint(id: string, index: number, point: BacktestReplayPoint) {
  if (!(point.timestamp instanceof Date) || !Number.isFinite(point.timestamp.getTime())) {
    throw new Error(`Portfolio replay allocation ${id} has a non-finite timestamp at observation ${index}.`);
  }
  const values: Array<[string, number]> = [
    ["price", point.price],
    ["activeLowPrice", point.activeLowPrice],
    ["activeHighPrice", point.activeHighPrice],
    ["availableQuoteAmount", point.availableQuoteAmount],
    ["availableBaseAmount", point.availableBaseAmount],
    ["deployedQuoteAmount", point.deployedQuoteAmount],
    ["realizedPnlUsd", point.realizedPnlUsd],
    ["unrealizedPnlUsd", point.unrealizedPnlUsd],
    ["totalEquityUsd", point.totalEquityUsd],
    ["drawdownPct", point.drawdownPct],
    ["occupancyPct", point.occupancyPct]
  ];
  if (point.retainedBaseAmount !== undefined) values.push(["retainedBaseAmount", point.retainedBaseAmount]);
  const invalid = values.find(([, value]) => !Number.isFinite(value));
  if (invalid) {
    throw new Error(`Portfolio replay allocation ${id} has a non-finite ${invalid[0]} at observation ${index}.`);
  }
}

function inRange(point: BacktestReplayPoint) {
  return point.price >= point.activeLowPrice && point.price <= point.activeHighPrice;
}

function isEligibleOperating(config: BacktestConfig, point: BacktestReplayPoint) {
  return config.entryMode !== EntryMode.SellOnly && point.status === BotStatus.Running && point.drawdownPct < config.maxDrawdownPct;
}

function canAffordMinimumOrder(config: BacktestConfig, point: BacktestReplayPoint) {
  const reserve = config.reserveQuoteAmount ?? 0;
  const maxDeployable = config.maxDeployableUsd ?? Math.max(0, config.budgetUsd - reserve);
  const capacity = Math.min(point.availableQuoteAmount - reserve, maxDeployable - point.deployedQuoteAmount);
  const feeFactor = 1 + (config.executionFeeBps ?? 0) / 10_000;
  return capacity + CAPACITY_TOLERANCE_USD >= Math.max(0, config.minOrderQuoteAmount) * feeFactor;
}

function weightedRatio(phasePoints: BacktestPortfolioPoint[], allPoints: BacktestPortfolioPoint[], predicate: (point: BacktestPortfolioPoint) => boolean) {
  const total = durationFor(phasePoints, allPoints);
  if (total <= 0) return 0;
  let weighted = 0;
  for (const point of phasePoints) {
    const duration = durationAfter(point, allPoints);
    if (predicate(point)) weighted += duration;
  }
  return roundMoney(weighted / total * 100);
}

function durationFor(points: BacktestPortfolioPoint[], allPoints: BacktestPortfolioPoint[]) {
  return points.reduce((total, point) => total + durationAfter(point, allPoints), 0);
}

function durationAfter(point: BacktestPortfolioPoint, allPoints: BacktestPortfolioPoint[]) {
  const next = allPoints[point.index + 1];
  if (!next) return 0;
  return Math.max(0, next.timestamp.getTime() - point.timestamp.getTime());
}

function totalReserve(allocations: BacktestPortfolioBotReplay[], outerReserve: number) {
  return outerReserve + sum(allocations.map(({ config }) => config.reserveQuoteAmount ?? 0));
}

function aggregateBenchmarks(
  allocations: BacktestPortfolioBotReplay[],
  field: "benchmarks" | "validationBenchmarks",
  outerReserve: number,
  startingBudgetUsd: number
): BacktestBenchmarks {
  const endingCashUsd = outerReserve + sum(allocations.map(({ replay }) => replay[field]!.cash.endingEquityUsd));
  const endingBuyAndHoldUsd = outerReserve + sum(allocations.map(({ replay }) => replay[field]!.buyAndHold.endingEquityUsd));
  return {
    cash: { endingEquityUsd: roundMoney(endingCashUsd), returnPct: startingBudgetUsd > 0 ? roundMoney((endingCashUsd / startingBudgetUsd - 1) * 100) : 0 },
    buyAndHold: {
      endingEquityUsd: roundMoney(endingBuyAndHoldUsd),
      returnPct: startingBudgetUsd > 0 ? roundMoney((endingBuyAndHoldUsd / startingBudgetUsd - 1) * 100) : 0
    }
  };
}

function sum(values: number[]) {
  return values.reduce((total, value) => {
    if (!Number.isFinite(value)) {
      throw new Error("Portfolio replay contains a non-finite monetary value.");
    }
    return total + value;
  }, 0);
}

function weightedAverageSlippage(metrics: BacktestMetrics[]) {
  const orders = sum(metrics.map((metric) => metric.simulatedOrderCount));
  return orders > 0 ? roundMoney(sum(metrics.map((metric) => metric.averageSlippageBps * metric.simulatedOrderCount)) / orders) : 0;
}

function roundMoney(value: number) {
  return Math.round(value * 1e8) / 1e8;
}

function roundBase(value: number) {
  return Math.round(value * 1e8) / 1e8;
}
