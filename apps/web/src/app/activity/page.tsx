import { cookies } from "next/headers";
import { Activity, AlertTriangle, Cpu, ShieldAlert, TerminalSquare } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { ManualRefresh } from "@/components/manual-refresh";
import { SurfaceCard } from "@/components/surface-card";
import { requireSession } from "@/lib/auth";
import { DESK_MODE_COOKIE, parseDeskMode } from "@/lib/desk-mode";
import { getActivityFeed } from "@/lib/data";
import { formatDateTime, formatNumber } from "@/lib/utils";

function SummaryMetric({
  label,
  value,
  hint,
  tone = "default"
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "red" | "amber";
}) {
  const toneClass = tone === "red" ? "text-[var(--red)]" : tone === "amber" ? "text-[var(--amber)]" : "text-white";

  return (
    <div className="space-y-2">
      <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-[var(--muted)]">{label}</div>
      <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-sm text-[var(--muted)]">{hint}</div>
    </div>
  );
}

function ToneBadge({ label, tone }: { label: string; tone: "default" | "green" | "amber" | "red" }) {
  const toneClass =
    tone === "green"
      ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]"
      : tone === "amber"
        ? "border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] text-[var(--amber)]"
        : tone === "red"
          ? "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] text-[var(--red)]"
          : "border-white/10 bg-white/[0.06] text-[var(--muted)]";

  return <span className={`inline-flex border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.18em] ${toneClass}`}>{label}</span>;
}

const kindIcons = {
  alert: AlertTriangle,
  execution: Activity,
  log: TerminalSquare
} as const;

export default async function ActivityPage({
  searchParams,
}: {
  searchParams?: Promise<{ deskMode?: string }>;
}) {
  await requireSession();
  const params = (await searchParams) ?? {};
  const cookieStore = await cookies();
  const deskMode = parseDeskMode(params.deskMode ?? cookieStore.get(DESK_MODE_COOKIE)?.value);
  const activity = await getActivityFeed(deskMode);
  const lastUpdatedAt = new Date().toISOString();

  const failedExecutions = activity.executions.filter((execution) => execution.status === "failed").slice(0, 6);
  const watchAlerts = activity.alerts.slice(0, 6);
  const latestEvent = activity.timeline[0] ?? null;

  return (
    <AppShell title="Activity" subtitle="System, alerting and execution trail" pathname="/activity" deskMode={deskMode}>
      <section className="space-y-4">
        <ManualRefresh lastUpdatedAt={lastUpdatedAt} />

        <SurfaceCard padding="none" className="overflow-hidden">
          <div className="grid gap-0 md:grid-cols-4">
            <div className="border-r border-[var(--line)] px-4 py-4 last:border-r-0">
              <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Events</div>
              <div className="mt-2 text-2xl font-semibold text-white">{formatNumber(activity.timeline.length, 0)}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">Merged tape rows loaded</div>
            </div>
            <div className="border-r border-[var(--line)] px-4 py-4 last:border-r-0">
              <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Alerts</div>
              <div className="mt-2 text-2xl font-semibold text-[var(--amber)]">{formatNumber(activity.summary.alertCount, 0)}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">{activity.summary.criticalAlerts} critical</div>
            </div>
            <div className="border-r border-[var(--line)] px-4 py-4 last:border-r-0">
              <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Exec fails</div>
              <div className="mt-2 text-2xl font-semibold text-[var(--red)]">{formatNumber(activity.summary.executionFailures, 0)}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">Routing or provider failures</div>
            </div>
            <div className="px-4 py-4">
              <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Error logs</div>
              <div className="mt-2 text-2xl font-semibold text-white">{formatNumber(activity.summary.errorLogs, 0)}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">System-side noise still open</div>
            </div>
          </div>
        </SurfaceCard>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_360px]">
          <SurfaceCard padding="none" className="overflow-hidden">
            <div className="border-b border-[var(--line)] px-5 py-4">
              <div className="flex items-center gap-3">
                <ShieldAlert className="h-4 w-4 text-[var(--green)]" />
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Ops tape</div>
              </div>
              <div className="mt-2 text-sm text-[var(--muted)]">Chronological feed for logs, alerts, and execution outcomes.</div>
            </div>

            <div className="space-y-0" style={{ contentVisibility: "auto" }}>
              {activity.timeline.map((entry, index) => {
                const Icon = kindIcons[entry.kind];
                const tone = entry.tone === "green" ? "green" : entry.tone === "amber" ? "amber" : entry.tone === "red" ? "red" : "default";

                return (
                  <div
                    key={entry.id}
                    className={`grid gap-4 py-5 md:grid-cols-[auto_minmax(0,1fr)_140px] md:items-start ${index === 0 ? "" : "border-t border-white/8"}`}
                  >
                    <div className="inline-flex h-11 w-11 items-center justify-center border border-[var(--line)] bg-white/[0.03]">
                      <Icon className="h-4 w-4 text-white" />
                    </div>

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <ToneBadge label={entry.kind} tone={tone} />
                        <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{entry.botName}</span>
                      </div>
                      <div className="text-base font-medium text-white">{entry.heading}</div>
                      <div className="text-sm text-[var(--muted)]">{entry.detail}</div>
                    </div>

                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)] md:text-right">
                      {formatDateTime(entry.timestamp)}
                    </div>
                  </div>
                );
              })}

              {!activity.timeline.length ? <div className="py-6 text-sm text-[var(--muted)]">The event stream is empty.</div> : null}
            </div>
          </SurfaceCard>

          <div className="space-y-4">
            <SurfaceCard padding="lg">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-4 w-4 text-[var(--amber)]" />
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Incident queue</div>
              </div>

              <div className="mt-5 space-y-3">
                {watchAlerts.map((alert) => (
                  <div key={alert.id} className="border-l-2 border-y border-r border-l-[var(--amber)] border-y-[var(--line)] border-r-[var(--line)] bg-[var(--panel-soft)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{alert.title}</div>
                      <ToneBadge label={alert.severity} tone={alert.severity === "critical" ? "red" : alert.severity === "warning" ? "amber" : "default"} />
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">{alert.message}</div>
                    <div className="mt-3 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                      {alert.bot?.name ?? "System"} | {formatDateTime(alert.createdAt)}
                    </div>
                  </div>
                ))}

                {!watchAlerts.length ? <div className="text-sm text-[var(--muted)]">No alerts in the current window.</div> : null}
              </div>
            </SurfaceCard>

            <SurfaceCard padding="lg">
              <div className="flex items-center gap-3">
                <Cpu className="h-4 w-4 text-[var(--red)]" />
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Failed routes</div>
              </div>

              <div className="mt-5 space-y-3">
                {failedExecutions.map((execution) => (
                  <div key={execution.id} className="border-l-2 border-y border-r border-l-[var(--red)] border-y-[var(--line)] border-r-[var(--line)] bg-[var(--panel-soft)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{execution.bot.name}</div>
                      <ToneBadge label={execution.status} tone="red" />
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">{execution.provider}</div>
                    <div className="mt-1 break-all text-sm text-white">{execution.txId ?? execution.executionRef}</div>
                    <div className="mt-3 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{formatDateTime(execution.createdAt)}</div>
                  </div>
                ))}

                {!failedExecutions.length ? <div className="text-sm text-[var(--muted)]">No execution failures recorded in the current sample.</div> : null}
              </div>
            </SurfaceCard>

            <SurfaceCard padding="lg">
              <div className="flex items-center gap-3">
                <Activity className="h-4 w-4 text-[var(--blue)]" />
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Latest handoff</div>
              </div>

              <div className="mt-5 border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                {latestEvent ? (
                  <>
                    <div className="flex items-center gap-2">
                      <ToneBadge
                        label={latestEvent.kind}
                        tone={latestEvent.tone === "green" ? "green" : latestEvent.tone === "amber" ? "amber" : latestEvent.tone === "red" ? "red" : "default"}
                      />
                      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{latestEvent.botName}</div>
                    </div>
                    <div className="mt-3 text-sm font-medium text-white">{latestEvent.heading}</div>
                    <div className="mt-1 text-sm text-[var(--muted)]">{latestEvent.detail}</div>
                    <div className="mt-3 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{formatDateTime(latestEvent.timestamp)}</div>
                  </>
                ) : (
                  <div className="text-sm text-[var(--muted)]">No activity yet.</div>
                )}
              </div>
            </SurfaceCard>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
