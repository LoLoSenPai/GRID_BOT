import { cookies } from "next/headers";
import Link from "next/link";
import { AlertTriangle, Clock3, Zap } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { ManualRefresh } from "@/components/manual-refresh";
import { PortfolioPnlChart } from "@/components/portfolio-pnl-chart";
import { DashboardBotRoster } from "@/components/dashboard-bot-roster";
import { SurfaceCard } from "@/components/surface-card";
import { requireSession } from "@/lib/auth";
import { formatLevelLabel } from "@/lib/bot-runtime";
import { DESK_MODE_COOKIE, parseDeskMode } from "@/lib/desk-mode";
import { getDashboardData } from "@/lib/data";
import { formatCurrency, formatDateTime } from "@/lib/utils";

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
  const lastUpdatedAt = new Date().toISOString();

  return (
    <AppShell title="Dashboard" subtitle="Overview and routing" pathname="/dashboard" deskMode={deskMode}>
      <section className="space-y-4">
        <ManualRefresh lastUpdatedAt={lastUpdatedAt} />

        <SurfaceCard padding="none" className="overflow-hidden">
          <div className="grid gap-0 md:grid-cols-4">
            <StripMetric label="Equity" value={formatCurrency(data.totalEquity)} hint={`${data.botCards.length} bots loaded`} />
            <StripMetric label="Pnl" value={formatCurrency(data.totalPnl)} hint="Desk-level combined PnL" tone={data.totalPnl >= 0 ? "green" : "red"} />
            <StripMetric label="Deployed" value={formatCurrency(data.capitalDeployed)} hint="Capital inside active grids" tone="amber" />
            <StripMetric label="Incidents" value={String(data.alerts.length)} hint={`${data.statusCounts.error} bots in error`} tone={data.alerts.length ? "amber" : "green"} />
          </div>
        </SurfaceCard>

        <PortfolioPnlChart points={data.portfolioHistory} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_360px]">
          <SurfaceCard padding="none" className="overflow-hidden">
            <div className="border-b border-[var(--line)] px-5 py-4">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Desk roster</div>
              <div className="mt-2 text-sm text-[var(--muted)]">Quick overview only. Open the terminal page to trade, edit, or inspect the live chart.</div>
            </div>

            <DashboardBotRoster bots={data.botCards} deskMode={deskMode} />
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
                <Zap className="h-4 w-4 text-[var(--accent)]" />
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Trade tape</div>
              </div>

              <div className="mt-5 space-y-3">
                {data.executions.slice(0, 6).map((execution) => (
                  <div key={execution.id} className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <Link href={`/bots?deskMode=${deskMode}&botId=${execution.bot.id}`} className="text-sm font-medium text-white transition hover:text-[var(--accent)]">
                        {execution.bot.name}
                      </Link>
                      <ToneBadge
                        label={execution.status}
                        tone={execution.status === "failed" ? "red" : execution.status === "simulated" ? "green" : "amber"}
                      />
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      {execution.order.side.toUpperCase()} {formatLevelLabel(execution.order.levelIndex)} | {formatCurrency(Number(execution.order.requestedQuoteAmount))}
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
