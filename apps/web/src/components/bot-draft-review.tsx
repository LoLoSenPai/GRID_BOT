import { AlertTriangle, GitCompareArrows, ShieldCheck, Wallet2 } from "lucide-react";

import { InlinePill } from "@/components/bot-console-primitives";
import { SurfaceCard } from "@/components/surface-card";
import type { BotDraftAnalysis, BotDraftDiffItem } from "@/lib/bot-management";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

export function BotDraftReview({
  analysis,
  changes,
  behaviorLabel,
  behaviorSummary,
  mode
}: {
  analysis: BotDraftAnalysis;
  changes: BotDraftDiffItem[];
  behaviorLabel: string;
  behaviorSummary: string;
  mode: "create" | "edit";
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Executable capital"
          value={formatCurrency(analysis.summary.executableCapitalUsd)}
          hint={`${formatPercent(analysis.summary.reserveRatioPct, 1)} reserve kept aside`}
          icon={Wallet2}
        />
        <SummaryTile
          label="Deployable headroom"
          value={formatCurrency(analysis.summary.deployableHeadroomUsd)}
          hint="Capital still outside the active rails"
          tone={analysis.summary.deployableHeadroomUsd >= 0 ? "default" : "negative"}
          icon={Wallet2}
        />
        <SummaryTile
          label="Range width"
          value={formatPercent(analysis.summary.rangeWidthPct, 1)}
          hint="Distance from low to high bound"
          icon={ShieldCheck}
        />
        <SummaryTile
          label="Budget / level"
          value={formatCurrency(analysis.summary.levelBudgetUsd)}
          hint={`Exec provider ${analysis.summary.provider}`}
          tone={analysis.summary.levelBudgetUsd > 0 ? "default" : "negative"}
          icon={ShieldCheck}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <SurfaceCard tone="muted" padding="sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Ready state</div>
              <div className="mt-2 text-sm text-white">{analysis.canSubmit ? (mode === "create" ? "Ready to create." : "Ready to save.") : "Blocking issue in draft."}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <InlinePill label="errors" value={String(analysis.blockingIssues.length)} tone={analysis.blockingIssues.length ? "red" : "green"} />
              <InlinePill label="warnings" value={String(analysis.warnings.length)} tone={analysis.warnings.length ? "amber" : "default"} />
            </div>
          </div>

          <div className="mt-4 border border-[var(--line)] bg-[var(--bg)] px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Style</div>
            <div className="mt-2 text-base font-semibold text-white">{behaviorLabel}</div>
            <div className="mt-1 text-sm text-[var(--muted)]">{behaviorSummary}</div>
          </div>

          <div className="mt-3 space-y-3">
            {analysis.issues.length ? (
              analysis.issues.slice(0, 4).map((issue, index) => (
                <div
                  key={`${issue.field ?? "issue"}-${index}`}
                  className={
                    issue.tone === "error"
                      ? "border border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] px-4 py-3 text-sm text-[var(--red)]"
                      : "border border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] px-4 py-3 text-sm text-[var(--amber)]"
                  }
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-1">
                      {issue.field ? (
                        <div className="font-mono text-[11px] uppercase tracking-[0.18em] opacity-80">{issue.field}</div>
                      ) : null}
                      <div>{issue.message}</div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-4 py-3 text-sm text-[var(--green)]">
                No blocking issue detected.
              </div>
            )}
          </div>
        </SurfaceCard>

        <SurfaceCard tone="muted" padding="sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Diff</div>
              <div className="mt-2 text-sm text-white">{mode === "create" ? "Preset overrides" : "Changes vs saved config"}</div>
            </div>
            <InlinePill label="changes" value={String(changes.length)} tone={changes.length ? "amber" : "default"} />
          </div>

          <div className="mt-4 space-y-3">
            {changes.length ? (
              changes.slice(0, 5).map((change) => (
                <div key={change.field} className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 text-sm">
                  <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                    <GitCompareArrows className="h-3.5 w-3.5 text-[var(--green)]" />
                    {change.label}
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">before</div>
                      <div className="mt-1 text-[var(--muted)]">{change.previous}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">after</div>
                      <div className="mt-1 text-white">{change.next}</div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 text-sm text-[var(--muted)]">
                {mode === "create" ? "Still identical to the preset." : "No difference from the saved config."}
              </div>
            )}
            {changes.length > 5 ? <div className="text-xs text-[var(--muted)]">+ {formatNumber(changes.length - 5, 0)} more changes hidden.</div> : null}
          </div>
        </SurfaceCard>
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default"
}: {
  label: string;
  value: string;
  hint: string;
  icon: typeof Wallet2;
  tone?: "default" | "negative";
}) {
  return (
    <div className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">{label}</div>
        <Icon className="h-4 w-4 text-[var(--green)]" />
      </div>
      <div className={tone === "negative" ? "mt-3 text-2xl font-semibold text-[var(--red)]" : "mt-3 text-2xl font-semibold text-white"}>{value}</div>
      <div className="mt-2 text-sm text-[var(--muted)]">{hint}</div>
    </div>
  );
}
