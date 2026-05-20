import type { BotStateSnapshot, PositionLot } from "../domain/types";

const MIN_RECONCILE_TOLERANCE_USD = 0.05;
const MIN_RECONCILE_TOLERANCE_BASE = 0.000001;
const RECONCILE_TOLERANCE_RATIO = 0.001;

function isOpenLot(lot: PositionLot) {
  return lot.remainingBaseAmount > 0 && lot.costQuote > 0 && !lot.closedAt;
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

function normalizeSelectedLotsToRuntimeBase(
  lots: PositionLot[],
  runtime?: Pick<BotStateSnapshot, "availableBaseAmount"> | null
) {
  const availableBaseAmount = runtime?.availableBaseAmount ?? null;
  if (availableBaseAmount === null || availableBaseAmount <= 0 || lots.length === 0) {
    return lots;
  }

  const totalBaseAmount = lots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
  const tolerance = getBaseTolerance(availableBaseAmount);
  if (totalBaseAmount <= 0 || Math.abs(totalBaseAmount - availableBaseAmount) <= tolerance) {
    return lots;
  }

  const scale = availableBaseAmount / totalBaseAmount;
  return lots.map((lot) => {
    const remainingBaseAmount = round(lot.remainingBaseAmount * scale);
    return {
      ...lot,
      originalBaseAmount: Math.max(remainingBaseAmount, round(lot.originalBaseAmount * scale)),
      remainingBaseAmount,
      entryPrice: remainingBaseAmount > 0 ? round(lot.costQuote / remainingBaseAmount, 8) : lot.entryPrice
    };
  });
}

export function reconcileOpenPositionLots(
  lots: PositionLot[],
  runtime?: Pick<BotStateSnapshot, "deployedQuoteAmount" | "availableBaseAmount"> | null
) {
  const activeLots = lots.filter(isOpenLot);
  const deployedQuoteAmount = runtime?.deployedQuoteAmount ?? null;

  if (deployedQuoteAmount === null || deployedQuoteAmount <= 0) {
    return deployedQuoteAmount === null ? activeLots : [];
  }

  const tolerance = getTolerance(deployedQuoteAmount);
  const totalCostQuote = activeLots.reduce((sum, lot) => sum + lot.costQuote, 0);
  const availableBaseAmount = runtime?.availableBaseAmount ?? null;
  const totalBaseAmount = activeLots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
  const baseMatches =
    availableBaseAmount === null ||
    availableBaseAmount <= 0 ||
    Math.abs(totalBaseAmount - availableBaseAmount) <= getBaseTolerance(availableBaseAmount);

  if (totalCostQuote <= deployedQuoteAmount + tolerance && baseMatches) {
    return activeLots;
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

  return normalizeSelectedLotsToRuntimeBase(
    selected.sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime()),
    runtime
  );
}
