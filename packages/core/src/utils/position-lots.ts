import type { BotStateSnapshot, PositionLot } from "../domain/types";

const MIN_RECONCILE_TOLERANCE_USD = 0.05;
const RECONCILE_TOLERANCE_RATIO = 0.001;

function isOpenLot(lot: PositionLot) {
  return lot.remainingBaseAmount > 0 && lot.costQuote > 0 && !lot.closedAt;
}

function getTolerance(deployedQuoteAmount: number) {
  return Math.max(MIN_RECONCILE_TOLERANCE_USD, Math.abs(deployedQuoteAmount) * RECONCILE_TOLERANCE_RATIO);
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

  const selected: PositionLot[] = [];
  let selectedCostQuote = 0;
  const newestFirst = [...activeLots].sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime());

  for (const lot of newestFirst) {
    if (selectedCostQuote + lot.costQuote <= deployedQuoteAmount + tolerance) {
      selected.push(lot);
      selectedCostQuote += lot.costQuote;
    }
  }

  return selected.sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime());
}
