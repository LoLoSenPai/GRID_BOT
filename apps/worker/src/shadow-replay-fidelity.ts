import type { ShadowJevV3EvaluationRequest } from '@grid-bot/core';
export function capturedExecutionConstraints(input: ShadowJevV3EvaluationRequest) {
  const snapshot = (input.observation.context as Record<string, any>).shadowReplayV3;
  const result: Record<string, any> = {};
  for (const strategy of snapshot?.strategies ?? []) for (const band of strategy.bands ?? []) {
    const config = band.bot?.config;
    if (!config) continue;
    const receipts = input.inventoryEvidence?.find(e => e.botId === band.bot.id)?.rows ?? [];
    const t0 = +new Date(input.observation.observedAt);
    const dates = receipts.filter((r: any) => r.status === "filled" && r.completedAt && +new Date(r.completedAt) <= t0)
      .map((r: any) => new Date(r.completedAt)).sort((a: Date, b: Date) => +a - +b);
    result[band.id] = { cooldownMs: Number(config.cooldownMs), maxOrdersPerHour: Number(config.maxOrdersPerHour),
      levelLockMs: Number(config.levelLockMs), maxDeployableUsd: Number(config.maxDeployableUsd),
      maxDrawdownPct: Number(config.maxDrawdownPct),
      initialLastExecutionAt: dates.at(-1), initialOrdersInTrailingHour: dates.filter((d: Date) => +d > t0 - 3_600_000) };
    const highWatermark = Number(band.bot.stateSnapshots?.[0]?.metadata?.equityHighWatermarkUsd);
    if (Number.isFinite(highWatermark) && highWatermark > 0) result[band.id].initialEquityHighWatermarkUsd = highWatermark;
  }
  return result;
}

