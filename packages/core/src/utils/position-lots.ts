import type { BotStateSnapshot, PositionLot } from "../domain/types";

const MIN_RECONCILE_TOLERANCE_USD = 0.05;
const RECONCILE_TOLERANCE_RATIO = 0.001;

function isOpenLot(lot: PositionLot) {
  return lot.remainingBaseAmount > 0 && lot.costQuote > 0 && !lot.closedAt;
}

function getTolerance(deployedQuoteAmount: number) {
  return Math.max(MIN_RECONCILE_TOLERANCE_USD, Math.abs(deployedQuoteAmount) * RECONCILE_TOLERANCE_RATIO);
}

function getLotCostBasis(lot: PositionLot) {
  return lot.remainingBaseAmount > 0 ? lot.costQuote / lot.remainingBaseAmount : lot.entryPrice;
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

  if (totalCostQuote <= deployedQuoteAmount + tolerance) {
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

  return selected.sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime());
}
