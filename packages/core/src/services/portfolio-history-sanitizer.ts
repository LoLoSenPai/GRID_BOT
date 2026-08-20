export type PortfolioHistoryValuePoint = {
  totalPnlUsd: number;
};

export function findIsolatedPortfolioSpikeIndexes<T extends PortfolioHistoryValuePoint>(points: T[]) {
  const spikeIndexes = new Set<number>();

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (!previous || !current || !next) {
      continue;
    }

    const previousValue = previous.totalPnlUsd;
    const currentValue = current.totalPnlUsd;
    const nextValue = next.totalPnlUsd;
    if (![previousValue, currentValue, nextValue].every(Number.isFinite)) {
      continue;
    }

    const neighborGap = Math.abs(nextValue - previousValue);
    const neighborMagnitude = Math.max(Math.abs(previousValue), Math.abs(nextValue), 25);
    const spikeThreshold = Math.max(250, neighborMagnitude * 2.5, neighborGap * 8);
    const neighborsReconnect = neighborGap <= Math.max(100, neighborMagnitude * 0.75);

    if (
      neighborsReconnect &&
      Math.abs(currentValue - previousValue) > spikeThreshold &&
      Math.abs(currentValue - nextValue) > spikeThreshold
    ) {
      spikeIndexes.add(index);
    }
  }

  return spikeIndexes;
}

export function removeIsolatedPortfolioSpikes<T extends PortfolioHistoryValuePoint>(points: T[]) {
  const spikeIndexes = findIsolatedPortfolioSpikeIndexes(points);
  return spikeIndexes.size === 0 ? points : points.filter((_, index) => !spikeIndexes.has(index));
}
