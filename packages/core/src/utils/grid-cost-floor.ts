/** Conservative round-trip spacing used by Lab selection and the paper portfolio policy. */
export function gridCostFloorPct(slippageBps: number, executionFeeBps: number): number {
  const slip = slippageBps / 10_000, fee = executionFeeBps / 10_000;
  if (![slip, fee].every(v => Number.isFinite(v) && v >= 0 && v < 1)) return Number.POSITIVE_INFINITY;
  return (((1 + slip) * (1 + fee)) / ((1 - slip) * (1 - fee)) - 1) * 100;
}
