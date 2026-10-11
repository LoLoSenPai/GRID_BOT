import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { aggregateZoneMetrics, groupBotsByStrategy } from "@/lib/bot-zone-groups";
import type { getDashboardData } from "@/lib/data";
import { formatCurrency, formatDateTime, formatNumber, formatPercent } from "@/lib/utils";

type Card = Awaited<ReturnType<typeof getDashboardData>>["botCards"][number];

export function DashboardBotRoster({ bots, deskMode }: { bots: Card[]; deskMode: string }) {
  return <div className="divide-y divide-[var(--line)]">
    {groupBotsByStrategy(bots).map((group) => {
      const first = group.bots[0]!;
      const totals = aggregateZoneMetrics(group.bots.map((bot) => ({
        status: bot.status, budget: bot.totalBudgetUsd, deployable: bot.budgetUsd,
        deployed: bot.budgetUsed, equity: bot.equity, pnl: bot.pnl, inventory: bot.baseInventory, zone: bot.zone,
      })));
      const rows = <div className="space-y-3 p-4">
        {group.bots.map((bot) => <div key={bot.id} className="flex flex-wrap items-center justify-between gap-3 border border-[var(--line)] p-3">
          <div>
            <div className="text-sm text-white">{bot.name} <StatusBadge status={bot.status} /></div>
            <div className="mt-1 text-xs text-[var(--muted)]">Zone {formatNumber(bot.range[0], bot.range[0] >= 1000 ? 0 : 2)} → {formatNumber(bot.range[1], bot.range[1] >= 1000 ? 0 : 2)} · Budget {formatCurrency(bot.totalBudgetUsd)} · Equity {formatCurrency(bot.equity)} · PnL {formatCurrency(bot.pnl)} · Used {formatPercent(bot.deployableUsage, 1)}</div>
            <div className="mt-1 text-xs text-[var(--muted)]">Spot {bot.price !== null ? formatNumber(bot.price, bot.price >= 1000 ? 0 : 2) : "--"} · Updated {bot.latestTickAt ? formatDateTime(bot.latestTickAt) : "--"} · Inventaire {formatNumber(bot.baseInventory, 8)} {bot.pair.split("/")[0]}</div>
            {bot.zone ? <div className="mt-1 text-xs text-[var(--muted)]">{bot.zone.status} · Libre {formatCurrency(bot.zone.availableQuote)} · Réservé {formatCurrency(bot.zone.reservedQuote)} · Coût engagé {formatCurrency(bot.zone.deployedCostQuote)} · {bot.zone.activeExits} sorties engagées</div> : null}
          </div>
          <Link className="border border-[var(--line)] px-3 py-2 text-xs text-white" href={`/bots?deskMode=${deskMode}&botId=${encodeURIComponent(bot.id)}`}>Open terminal</Link>
        </div>)}
      </div>;
      if (!group.isStrategy) return <div key={group.id}>{rows}</div>;
      return <details key={group.id} className="group">
        <summary className="cursor-pointer p-4">
          <span className="font-medium text-white">{first.pair} · {first.strategy.replaceAll("_", " ")} · {group.bots.length} {group.bots.length === 1 ? "zone" : "zones"}</span>
          <span className="ml-3" title={totals.statusDetails}><StatusBadge status={totals.status} /></span>
          <div className="mt-2 text-xs text-[var(--muted)]">Budget {formatCurrency(totals.budget)} · Equity {formatCurrency(totals.equity)} · PnL {formatCurrency(totals.pnl)} · Used {formatPercent(totals.usage, 1)} · Inventaire {formatNumber(totals.inventory, 8)} {first.pair.split("/")[0]}</div>
          <div className="mt-1 text-xs text-[var(--muted)]">Libre {formatCurrency(totals.availableQuote!)} · Réservé {formatCurrency(totals.reservedQuote!)} · Coût engagé {formatCurrency(totals.deployedCostQuote!)} · {totals.activeExits} sorties engagées · {totals.statusDetails}</div>
          <div className="mt-1 text-xs text-[var(--muted)]">Voir les plages et ouvrir une zone · Les sorties des anciens lots restent attachées à leur zone.</div>
        </summary>
        {rows}
      </details>;
    })}
  </div>;
}
