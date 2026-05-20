import type { BotStateSnapshot, PositionLot } from "../domain/types";

const MIN_RECONCILE_TOLERANCE_USD = 0.05;
const MIN_RECONCILE_TOLERANCE_BASE = 0.000001;
const RECONCILE_TOLERANCE_RATIO = 0.001;

function isOpenLot(lot: PositionLot) {
  return (
    lot.remainingBaseAmount > MIN_RECONCILE_TOLERANCE_BASE &&
    lot.costQuote > MIN_RECONCILE_TOLERANCE_USD &&
    !lot.closedAt
  );
}

function getTolerance(deployedQuoteAmount: number) {
  return Math.max(MIN_RECONCILE_TOLERANCE_USD, Math.abs(deployedQuoteAmount) * RECONCILE_TOLERANCE_RATIO);
}

function getBaseTolerance(baseAmount: number) {
  return Math.max(MIN_RECONCILE_TOLERANCE_BASE, Math.abs(baseAmount) * RECONCILE_TOLERANCE_RATIO);
}

function getLotCostBasis(lot: PositionLot) {
  return lot.remainingBaseAmount > 0 ? lot.costQuote / lot.remainingBaseAmount : lot.entryPrice;
}

function round(value: number, decimals = 10) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeSelectedLotsToRuntimeState(
  lots: PositionLot[],
  runtime?: Pick<BotStateSnapshot, "deployedQuoteAmount" | "availableBaseAmount"> | null
) {
  if (!runtime || lots.length === 0) {
    return lots;
  }

  const deployedQuoteAmount = runtime.deployedQuoteAmount;
  const availableBaseAmount = runtime.availableBaseAmount;
  const totalBaseAmount = lots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
  const totalCostQuote = lots.reduce((sum, lot) => sum + lot.costQuote, 0);
  const baseScale =
    availableBaseAmount > 0 &&
    totalBaseAmount > 0 &&
    Math.abs(totalBaseAmount - availableBaseAmount) > getBaseTolerance(availableBaseAmount)
      ? availableBaseAmount / totalBaseAmount
      : 1;
  const quoteScale =
    deployedQuoteAmount > 0 &&
    totalCostQuote > 0 &&
    Math.abs(totalCostQuote - deployedQuoteAmount) > getTolerance(deployedQuoteAmount)
      ? deployedQuoteAmount / totalCostQuote
      : 1;

  if (baseScale === 1 && quoteScale === 1) {
    return lots;
  }

  return lots.map((lot) => {
    const remainingBaseAmount = round(lot.remainingBaseAmount * baseScale);
    const costQuote = round(lot.costQuote * quoteScale);
    return {
      ...lot,
      originalBaseAmount: Math.max(remainingBaseAmount, round(lot.originalBaseAmount * baseScale)),
      remainingBaseAmount,
      costQuote,
      entryPrice: remainingBaseAmount > 0 && costQuote > 0 ? round(costQuote / remainingBaseAmount, 8) : lot.entryPrice
    };
  });
}

export function reconcileOpenPositionLots(
  lots: PositionLot[],
  runtime?: Pick<BotStateSnapshot, "deployedQuoteAmount" | "availableBaseAmount"> | null
) {
  const activeLots = lots.filter(isOpenLot);
  const deployedQuoteAmount = runtime?.deployedQuoteAmount ?? null;
  const availableBaseAmount = runtime?.availableBaseAmount ?? null;

  if (deployedQuoteAmount === null || deployedQuoteAmount <= MIN_RECONCILE_TOLERANCE_USD) {
    return deployedQuoteAmount === null ? activeLots : [];
  }

  if (availableBaseAmount !== null && availableBaseAmount <= MIN_RECONCILE_TOLERANCE_BASE) {
    return [];
  }

  const tolerance = getTolerance(deployedQuoteAmount);
  const totalCostQuote = activeLots.reduce((sum, lot) => sum + lot.costQuote, 0);
  const totalBaseAmount = activeLots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
  const baseMatches =
    availableBaseAmount === null ||
    availableBaseAmount <= 0 ||
    Math.abs(totalBaseAmount - availableBaseAmount) <= getBaseTolerance(availableBaseAmount);

  if (totalCostQuote <= deployedQuoteAmount + tolerance && baseMatches) {
    return normalizeSelectedLotsToRuntimeState(activeLots, runtime);
  }

  const targetAverageEntry =
    runtime?.availableBaseAmount && runtime.availableBaseAmount > 0
      ? deployedQuoteAmount / runtime.availableBaseAmount
      : null;
  const candidates = [...activeLots].sort((left, right) => {
    if (targetAverageEntry !== null) {
      const leftDistance = Math.abs(getLotCostBasis(left) - targetAverageEntry);
      const rightDistance = Math.abs(getLotCostBasis(right) - targetAverageEntry);
      if (Math.abs(leftDistance - rightDistance) > 0.00000001) {
        return leftDistance - rightDistance;
      }
    }

    return right.openedAt.getTime() - left.openedAt.getTime();
  });
  const selected: PositionLot[] = [];
  let selectedCostQuote = 0;

  for (const lot of candidates) {
    if (selectedCostQuote + lot.costQuote <= deployedQuoteAmount + tolerance) {
      selected.push(lot);
      selectedCostQuote += lot.costQuote;
    }
  }

  return normalizeSelectedLotsToRuntimeState(
    selected.sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime()),
    runtime
  );
}
