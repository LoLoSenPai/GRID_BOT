export type BotZone = {
  portfolioId: string;
  strategyId: string;
  bandId: string;
  status: string;
  availableQuote: number;
  reservedQuote: number;
  deployedCostQuote: number;
  activeExits: number;
};

type Band = {
  id: string; assetStrategyId: string; status: string;
  availableQuoteAmount: unknown; reservedQuoteAmount: unknown; deployedCostQuote: unknown;
  assetStrategy: { portfolioId: string };
  exitCommitments: { id: string }[];
};

export function serializeBotZone(band: Band | null): BotZone | null {
  return band ? {
    portfolioId: band.assetStrategy.portfolioId, strategyId: band.assetStrategyId,
    bandId: band.id, status: band.status,
    availableQuote: Math.max(0, Number(band.availableQuoteAmount) - Number(band.reservedQuoteAmount)),
    reservedQuote: Number(band.reservedQuoteAmount),
    deployedCostQuote: Number(band.deployedCostQuote), activeExits: band.exitCommitments.length,
  } : null;
}

/** View-only grouping: legacy bots remain independent, even for the same pair. */
export function groupBotsByStrategy<T extends { id: string; mode: string; zone: BotZone | null }>(bots: readonly T[]) {
  const groups = new Map<string, { id: string; isStrategy: boolean; bots: T[] }>();
  for (const bot of bots) {
    const id = bot.zone
      ? JSON.stringify([bot.mode, bot.zone.portfolioId, bot.zone.strategyId])
      : JSON.stringify(["legacy", bot.id]);
    const group = groups.get(id) ?? { id, isStrategy: Boolean(bot.zone), bots: [] };
    group.bots.push(bot);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function aggregateZoneMetrics(bots: readonly {
  status: string; budget: number; deployable: number; deployed: number;
  equity: number; pnl: number; inventory: number; zone: BotZone | null;
}[]) {
  const sum = (key: "budget" | "deployable" | "deployed" | "equity" | "pnl" | "inventory") => bots.reduce((total, bot) => total + bot[key], 0);
  const statuses = [...new Set(bots.map((bot) => bot.status))];
  const deployable = sum("deployable");
  return {
    budget: sum("budget"), equity: sum("equity"), pnl: sum("pnl"), inventory: sum("inventory"),
    usage: deployable > 0 ? sum("deployed") / deployable * 100 : 0,
    status: statuses.length === 1 ? statuses[0]! : "mixed",
    statusDetails: statuses.map((status) => `${status}: ${bots.filter((bot) => bot.status === status).length}`).join(" · "),
    availableQuote: bots.every((bot) => bot.zone) ? bots.reduce((total, bot) => total + bot.zone!.availableQuote, 0) : null,
    reservedQuote: bots.every((bot) => bot.zone) ? bots.reduce((total, bot) => total + bot.zone!.reservedQuote, 0) : null,
    deployedCostQuote: bots.every((bot) => bot.zone) ? bots.reduce((total, bot) => total + bot.zone!.deployedCostQuote, 0) : null,
    activeExits: bots.reduce((total, bot) => total + (bot.zone?.activeExits ?? 0), 0),
  };
}
