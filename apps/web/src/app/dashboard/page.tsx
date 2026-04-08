import { cookies } from "next/headers";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Clock3, Zap } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge } from "@/components/status-badge";
import { SurfaceCard } from "@/components/surface-card";
import { requireSession } from "@/lib/auth";
import { DESK_MODE_COOKIE, parseDeskMode } from "@/lib/desk-mode";
import { getDashboardData } from "@/lib/data";
import { formatCurrency, formatDateTime, formatNumber, formatPercent } from "@/lib/utils";

function StripMetric({ label, value, hint, tone = "default" }: { label: string; value: string; hint: string; tone?: "default" | "green" | "red" | "amber" }) {
  const toneClass =
    tone === "green" ? "text-[var(--green)]" : tone === "red" ? "text-[var(--red)]" : tone === "amber" ? "text-[var(--amber)]" : "text-white";

  return (
    <div className="border-r border-[var(--line)] px-4 py-4 last:border-r-0">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-[var(--muted)]">{hint}</div>
    </div>
  );
}

function ToneBadge({ label, tone = "default" }: { label: string; tone?: "default" | "green" | "amber" | "red" }) {
  const toneClass =
    tone === "green"
      ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]"
      : tone === "amber"
        ? "border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] text-[var(--amber)]"
        : tone === "red"
          ? "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] text-[var(--red)]"
          : "border-white/10 bg-white/[0.04] text-[var(--muted)]";

  return <span className={`inline-flex border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] ${toneClass}`}>{label}</span>;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ deskMode?: string }>;
}) {
  await requireSession();
  const params = (await searchParams) ?? {};
  const cookieStore = await cookies();
  const deskMode = parseDeskMode(params.deskMode ?? cookieStore.get(DESK_MODE_COOKIE)?.value);
  const data = await getDashboardData(deskMode);

  return (
    <AppShell title="Dashboard" subtitle="Overview and routing" pathname="/dashboard" deskMode={deskMode}>
      <AutoRefresh />

      <section className="space-y-4">
        <SurfaceCard padding="none" className="overflow-hidden">
          <div className="grid gap-0 md:grid-cols-4">
            <StripMetric label="Equity" value={formatCurrency(data.totalEquity)} hint={`${data.botCards.length} bots loaded`} />
            <StripMetric label="Pnl" value={formatCurrency(data.totalPnl)} hint="Desk-level combined PnL" tone={data.totalPnl >= 0 ? "green" : "red"} />
            <StripMetric label="Deployed" value={formatCurrency(data.capitalDeployed)} hint="Capital inside active grids" tone="amber" />
            <StripMetric label="Incidents" value={String(data.alerts.length)} hint={`${data.statusCounts.error} bots in error`} tone={data.alerts.length ? "amber" : "green"} />
          </div>
        </SurfaceCard>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_360px]">
          <SurfaceCard padding="none" className="overflow-hidden">
            <div className="border-b border-[var(--line)] px-5 py-4">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Desk roster</div>
              <div className="mt-2 text-sm text-[var(--muted)]">Quick overview only. Open the terminal page to trade, edit, or inspect the live chart.</div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left">
                    {["Bot", "Status", "Spot", "Range", "Pnl", "Used", "Updated", ""].map((label) => (
                      <th key={label} className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.botCards.map((bot) => (
                    <tr key={bot.id} className="border-b border-[var(--line)] transition hover:bg-white/[0.03]">
                      <td className="px-4 py-4">
                        <div className="space-y-1">
                          <div className="font-medium text-white">{bot.name}</div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">
                            {bot.pair} | {bot.strategy.replaceAll("_", " ")} | {bot.mode}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4"><StatusBadge status={bot.status} /></td>
                      <td className="px-4 py-4 text-sm text-white">{bot.price ? formatNumber(bot.price, bot.price >= 1000 ? 0 : 2) : "--"}</td>
                      <td className="px-4 py-4 text-sm text-[var(--muted)]">
                        {formatNumber(bot.range[0], bot.range[0] >= 1000 ? 0 : 2)} {"->"} {formatNumber(bot.range[1], bot.range[1] >= 1000 ? 0 : 2)}
                      </td>
                      <td className={`px-4 py-4 text-sm ${bot.pnl >= 0 ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{formatCurrency(bot.pnl)}</td>
                      <td className="px-4 py-4 text-sm text-[var(--amber)]">{formatPercent(bot.deployableUsage, 1)}</td>
                      <td className="px-4 py-4 text-sm text-[var(--muted)]">{bot.latestTickAt ? formatDateTime(bot.latestTickAt) : "--"}</td>
                      <td className="px-4 py-4">
                      <Link
                          href={`/bots?deskMode=${deskMode}&botId=${bot.id}`}
                          className="inline-flex items-center gap-2 border border-[var(--line)] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-white transition hover:bg-white/[0.04]"
                        >
                          Open terminal
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SurfaceCard>

          <div className="space-y-4">
            <SurfaceCard padding="lg">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-4 w-4 text-[var(--amber)]" />
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Incident queue</div>
              </div>

              <div className="mt-5 space-y-3">
                {data.alerts.slice(0, 5).map((alert) => (
                  <div key={alert.id} className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{alert.title}</div>
                      <ToneBadge label={alert.severity} tone={alert.severity === "critical" ? "red" : alert.severity === "warning" ? "amber" : "default"} />
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">{alert.message}</div>
                    <div className="mt-3 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">
                      {alert.bot?.name ?? "System"} | {formatDateTime(alert.createdAt)}
                    </div>
                  </div>
                ))}

                {!data.alerts.length ? <div className="text-sm text-[var(--muted)]">No active incidents.</div> : null}
              </div>
            </SurfaceCard>

            <SurfaceCard padding="lg">
              <div className="flex items-center gap-3">
                <Zap className="h-4 w-4 text-[var(--green)]" />
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Trade tape</div>
              </div>

              <div className="mt-5 space-y-3">
                {data.executions.slice(0, 6).map((execution) => (
                  <div key={execution.id} className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <Link href={`/bots?deskMode=${deskMode}&botId=${execution.bot.id}`} className="text-sm font-medium text-white transition hover:text-[var(--green)]">
                        {execution.bot.name}
                      </Link>
                      <ToneBadge
                        label={execution.status}
                        tone={execution.status === "failed" ? "red" : execution.status === "simulated" ? "green" : "amber"}
                      />
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      {execution.order.side.toUpperCase()} L{String(execution.order.levelIndex).padStart(2, "0")} | {formatCurrency(Number(execution.order.requestedQuoteAmount))}
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">
                      <Clock3 className="h-3.5 w-3.5" />
                      {formatDateTime(execution.createdAt)}
                    </div>
                  </div>
                ))}

                {!data.executions.length ? <div className="text-sm text-[var(--muted)]">No recent fills.</div> : null}
              </div>
            </SurfaceCard>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
