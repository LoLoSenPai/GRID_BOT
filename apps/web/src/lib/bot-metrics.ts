export function calculateBudgetRoiPct(totalPnlUsd: number, totalBudgetUsd: number) {
  if (!Number.isFinite(totalPnlUsd) || !Number.isFinite(totalBudgetUsd) || totalBudgetUsd <= 0) {
    return 0;
  }

  return (totalPnlUsd / totalBudgetUsd) * 100;
}
