import { FlaskConical, PlayCircle, RotateCcw, ShieldAlert } from "lucide-react";

import { InlinePill, MetricReadout } from "@/components/bot-console-primitives";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils";

export function BotPaperSessionPanel({
  bot
}: {
  bot: {
    mode: string;
    status: string;
    metrics: {
      equity: number;
      pnl: number;
      deployedQuoteAmount: number;
    };
    runtime: {
      availableQuoteAmount: number;
      availableBaseAmount: number;
      consecutiveFailures: number;
      lastExecutionAt: string | null;
      nextBuyLevel: number | null;
      nextSellLevel: number | null;
      pendingSignal: {
        side: "buy" | "sell";
        levelIndex: number;
        firstObservedAt: string;
        lastObservedPrice: number;
        remainingMs: number;
        ready: boolean;
      } | null;
    };
    paperSession: {
      enabled: boolean;
      startedAt: string;
      lastResetAt: string | null;
      ordersCount: number;
      executionsCount: number;
      latestExecutionAt: string | null;
      latestExecutionStatus: string | null;
      latestExecutionInputAmount: number | null;
      latestExecutionOutputAmount: number | null;
      latestExecutionPrice: number | null;
      latestOrderSide: string | null;
      latestOrderStatus: string | null;
      latestOrderAt: string | null;
      latestSignalAt: string | null;
    };
    pairLabel?: string;
    baseSymbol?: string;
    quoteSymbol?: string;
  };
}) {
  if (!bot.paperSession.enabled) {
    return (
      <div className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
      <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Paper session</div>
          <InlinePill label="mode" value="live" tone="red" />
        </div>
        <div className="mt-3 text-sm text-[var(--muted)]">Paper controls are disabled while the bot is live.</div>
      </div>
    );
  }

  const lastActivityAt = bot.paperSession.latestExecutionAt ?? bot.runtime.lastExecutionAt ?? null;
  const resetReady = bot.status !== "running" && bot.status !== "cooldown";
  const pendingSignal = bot.runtime.pendingSignal;
  const latestTradeSummary = describeLatestTrade(bot);

  return (
    <div className="space-y-4 border border-[var(--line)] bg-[var(--panel-soft)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Paper session</div>
          <div className="mt-2 text-sm text-white">Current simulator state.</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <InlinePill label="orders" value={String(bot.paperSession.ordersCount)} tone="default" />
          <InlinePill label="execs" value={String(bot.paperSession.executionsCount)} tone="green" />
          <InlinePill label="reset" value={resetReady ? "ready" : "blocked"} tone={resetReady ? "green" : "amber"} />
        </div>
      </div>

      <div className="grid gap-4 border border-[var(--line)] bg-[var(--bg)] p-4 md:grid-cols-3">
        <PaperRail
          label="Next buy"
          value={bot.runtime.nextBuyLevel !== null ? formatPrice(bot.runtime.nextBuyLevel) : "--"}
          hint={bot.runtime.nextBuyLevel !== null ? "Below spot" : "No armed buy level"}
          tone="green"
        />
        <PaperRail
          label="Next sell"
          value={bot.runtime.nextSellLevel !== null ? formatPrice(bot.runtime.nextSellLevel) : "--"}
          hint={bot.runtime.nextSellLevel !== null ? "Above spot" : "No armed sell level"}
          tone="amber"
        />
        <PaperRail
          label="Signal"
          value={
            pendingSignal
              ? `${pendingSignal.side.toUpperCase()} L${String(pendingSignal.levelIndex).padStart(2, "0")} · ${
                  pendingSignal.ready ? "ready" : `${Math.ceil(pendingSignal.remainingMs / 1000)}s`
                }`
              : "Idle"
          }
          hint={pendingSignal ? `Observed ${formatDateTime(pendingSignal.firstObservedAt)}` : "Waiting for a cross"}
          tone={pendingSignal ? (pendingSignal.side === "buy" ? "green" : "amber") : "default"}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SessionMetric
          icon={PlayCircle}
          label="Session start"
          value={formatDateTime(bot.paperSession.startedAt)}
          hint={bot.paperSession.lastResetAt ? "Reset changed the session boundary." : "Still running from creation."}
        />
        <SessionMetric
          icon={RotateCcw}
          label="Last reset"
          value={bot.paperSession.lastResetAt ? formatDateTime(bot.paperSession.lastResetAt) : "Never reset"}
          hint={resetReady ? "Reset allowed." : "Pause or stop first."}
        />
      </div>

      <div className="space-y-3 border-t border-[var(--line)] pt-4 text-sm">
        <MetricReadout label="Paper equity" value={formatCurrency(bot.metrics.equity)} />
        <MetricReadout
          label="Paper PnL"
          value={formatCurrency(bot.metrics.pnl)}
          tone={bot.metrics.pnl >= 0 ? "green" : "red"}
        />
        <MetricReadout label="Available quote" value={formatCurrency(bot.runtime.availableQuoteAmount)} />
        <MetricReadout label="Available base" value={formatNumber(bot.runtime.availableBaseAmount, 6)} />
        <MetricReadout label="Deployed quote" value={formatCurrency(bot.metrics.deployedQuoteAmount)} tone="amber" />
        <MetricReadout
          label="Last paper activity"
          value={lastActivityAt ? `${formatDateTime(lastActivityAt)}${bot.paperSession.latestExecutionStatus ? ` | ${bot.paperSession.latestExecutionStatus}` : ""}` : "No execution yet"}
        />
        <MetricReadout label="Last sim trade" value={latestTradeSummary} tone={bot.paperSession.latestExecutionStatus ? "green" : "default"} />
        <MetricReadout
          label="Failure streak"
          value={String(bot.runtime.consecutiveFailures)}
          tone={bot.runtime.consecutiveFailures > 0 ? "amber" : "default"}
        />
      </div>

      {!resetReady ? (
        <div className="border border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] px-4 py-3 text-sm text-[var(--amber)]">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>Reset blocked while the bot is still armed.</div>
          </div>
        </div>
      ) : (
        <div className="border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-4 py-3 text-sm text-[var(--green)]">
          <div className="flex items-start gap-3">
            <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
            <div>Safe to reset. Paper orders and PnL will restart from zero.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function PaperRail({
  label,
  value,
  hint,
  tone = "default"
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "green" | "amber";
}) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{label}</div>
      <div className={tone === "green" ? "text-lg font-semibold text-[var(--green)]" : tone === "amber" ? "text-lg font-semibold text-[var(--amber)]" : "text-lg font-semibold text-white"}>{value}</div>
      <div className="text-xs text-[var(--muted)]">{hint}</div>
    </div>
  );
}

function SessionMetric({
  icon: Icon,
  label,
  value,
  hint
}: {
  icon: typeof PlayCircle;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="border border-[var(--line)] bg-[var(--bg)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{label}</div>
        <Icon className="h-4 w-4 text-[var(--accent)]" />
      </div>
      <div className="mt-3 text-lg font-semibold text-white">{value}</div>
      <div className="mt-2 text-sm text-[var(--muted)]">{hint}</div>
    </div>
  );
}

function describeLatestTrade(bot: {
  pairLabel?: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  paperSession: {
    latestExecutionStatus: string | null;
    latestExecutionInputAmount: number | null;
    latestExecutionOutputAmount: number | null;
    latestExecutionPrice: number | null;
    latestOrderSide: string | null;
  };
}) {
  if (!bot.paperSession.latestExecutionStatus || bot.paperSession.latestExecutionInputAmount === null || bot.paperSession.latestExecutionOutputAmount === null) {
    return "No paper trade yet";
  }

  const baseSymbol = bot.baseSymbol ?? bot.pairLabel?.split("/")[0] ?? "base";
  const quoteSymbol = bot.quoteSymbol ?? bot.pairLabel?.split("/")[1] ?? "quote";
  const side = bot.paperSession.latestOrderSide?.toUpperCase() ?? "TRADE";
  const inputAmount = formatTradeAmount(bot.paperSession.latestExecutionInputAmount);
  const outputAmount = formatTradeAmount(bot.paperSession.latestExecutionOutputAmount);
  const price = bot.paperSession.latestExecutionPrice ? ` @ ${formatPrice(bot.paperSession.latestExecutionPrice)}` : "";

  return side === "BUY" ? `${side} ${inputAmount} ${quoteSymbol} -> ${outputAmount} ${baseSymbol}${price}` : `${side} ${inputAmount} ${baseSymbol} -> ${outputAmount} ${quoteSymbol}${price}`;
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1000 ? 0 : value >= 100 ? 2 : 4
  }).format(value);
}

function formatTradeAmount(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 6
  }).format(value);
}
