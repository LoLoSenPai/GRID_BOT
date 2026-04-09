"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, ClipboardList, X } from "lucide-react";

import type { BotDetailViewData } from "@/components/bot-detail-view";
import { StatusBadge } from "@/components/status-badge";
import { SurfaceCard } from "@/components/surface-card";
import { formatGoalLabel, formatRailModelLabel, formatTradeDisplay } from "@/lib/trade-display";
import { cn, formatCurrency, formatDateTime, formatNumber } from "@/lib/utils";

type DrawerTab = "executions" | "orders" | "openLots" | "alerts";

function DrawerTabButton({
  active,
  label,
  onClick
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-8 rounded-md border px-3 font-mono text-[10px] uppercase tracking-[0.12em] transition",
        active
          ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]"
          : "border-[var(--line)] text-[var(--muted)] hover:bg-white/[0.04] hover:text-white"
      )}
    >
      {label}
    </button>
  );
}

function getTransactionUrl(txId: string) {
  return `https://solscan.io/tx/${encodeURIComponent(txId)}`;
}

export function BotTradingDrawer({
  bot,
  open,
  onClose
}: {
  bot: BotDetailViewData | null;
  open: boolean;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<DrawerTab>("executions");

  useEffect(() => {
    if (!open) {
      return;
    }

    setActiveTab("executions");
  }, [bot?.id, open]);

  if (!open || !bot) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-[1px]">
      <button type="button" aria-label="Close drawer" className="flex-1 cursor-default" onClick={onClose} />
      <aside className="relative h-full w-full max-w-[480px] overflow-hidden border-l border-[var(--line)] bg-[var(--panel)] shadow-[0_0_40px_rgba(0,0,0,0.4)]">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Trading details</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-white">{bot.name}</h2>
              <StatusBadge status={bot.status} />
            </div>
            <div className="mt-2 text-sm text-[var(--muted)]">
              {bot.baseSymbol}/{bot.quoteSymbol} | {formatGoalLabel(bot.strategyMode)}
            </div>
            <div className="mt-1 text-xs text-[var(--muted)]">{formatRailModelLabel(bot.config.levelCount)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--line)] text-[var(--muted)] transition hover:bg-white/[0.04] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-[var(--line)] px-5 py-3">
          <div className="flex flex-wrap gap-2">
            <DrawerTabButton active={activeTab === "executions"} label="Executions" onClick={() => setActiveTab("executions")} />
            <DrawerTabButton active={activeTab === "orders"} label="Orders" onClick={() => setActiveTab("orders")} />
            <DrawerTabButton active={activeTab === "openLots"} label="Open lots" onClick={() => setActiveTab("openLots")} />
            <DrawerTabButton active={activeTab === "alerts"} label="Alerts & logs" onClick={() => setActiveTab("alerts")} />
          </div>
        </div>

        <div className="h-[calc(100%-140px)] overflow-y-auto px-5 py-4">
          {activeTab === "executions" ? (
            <div className="space-y-3">
              {bot.executions.length ? (
                bot.executions.map((execution) => {
                  const tradeDisplay = formatTradeDisplay({
                    side: execution.side,
                    quoteAmount: execution.quoteAmount,
                    baseAmount: execution.baseAmount,
                    baseSymbol: bot.baseSymbol
                  });

                  return (
                    <SurfaceCard key={execution.id} tone="muted" padding="sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em]",
                              execution.side === "buy"
                                ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]"
                                : "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] text-[var(--red)]"
                            )}
                          >
                            {execution.side}
                          </span>
                          <span className="text-sm font-medium text-white">L{String(execution.levelIndex).padStart(2, "0")}</span>
                        </div>
                        <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">{execution.status}</div>
                      </div>

                      <div className="mt-3 text-sm font-medium text-white">{tradeDisplay.compact}</div>
                      <div className="mt-2 grid gap-2 text-sm text-[var(--muted)] md:grid-cols-2">
                        <div>Target {formatNumber(execution.targetPrice, 2)}</div>
                        <div>{execution.effectivePrice ? `Executed @ ${formatNumber(execution.effectivePrice, 2)}` : "Executed @ --"}</div>
                        <div>{formatDateTime(execution.time)}</div>
                        <div>{execution.reason.replaceAll("_", " ")}</div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
                        <span>{execution.provider}</span>
                        {execution.txId ? (
                          <a className="inline-flex items-center gap-1 text-white hover:text-[var(--green)]" href={getTransactionUrl(execution.txId)} rel="noreferrer" target="_blank">
                            Tx link <ArrowUpRight className="h-3 w-3" />
                          </a>
                        ) : (
                          <span>{execution.executionRef}</span>
                        )}
                      </div>

                      {execution.errorMessage ? <div className="mt-3 text-xs text-[var(--red)]">{execution.errorMessage}</div> : null}
                    </SurfaceCard>
                  );
                })
              ) : (
                <SurfaceCard tone="muted" padding="sm">
                  <div className="text-sm text-[var(--muted)]">No executions recorded for this bot yet.</div>
                </SurfaceCard>
              )}
            </div>
          ) : null}

          {activeTab === "orders" ? (
            <div className="space-y-3">
              {bot.orders.length ? (
                bot.orders.map((order) => {
                  const orderDisplay = formatTradeDisplay({
                    side: order.side,
                    quoteAmount: order.execution?.quoteAmount ?? order.requestedQuoteAmount,
                    baseAmount: order.execution?.baseAmount ?? order.requestedBaseAmount,
                    baseSymbol: bot.baseSymbol
                  });

                  return (
                    <SurfaceCard key={order.id} tone="muted" padding="sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">
                            {order.side === "buy" ? "Buy" : "Sell"} L{String(order.levelIndex).padStart(2, "0")}
                          </span>
                          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">{order.status}</span>
                        </div>
                        <span className="text-sm text-white">{orderDisplay.compact}</span>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-[var(--muted)] md:grid-cols-2">
                        <div>Target {formatNumber(order.targetPrice, 2)}</div>
                        <div>{formatDateTime(order.time)}</div>
                        <div>Reason {order.reason.replaceAll("_", " ")}</div>
                        <div>{order.execution ? `Execution ${order.execution.status}` : "Awaiting execution"}</div>
                      </div>
                      {order.execution ? (
                        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
                          {order.execution.effectivePrice ? <span>@ {formatNumber(order.execution.effectivePrice, 2)}</span> : null}
                          {order.execution.txId ? (
                            <a className="inline-flex items-center gap-1 text-white hover:text-[var(--green)]" href={getTransactionUrl(order.execution.txId)} rel="noreferrer" target="_blank">
                              Tx link <ArrowUpRight className="h-3 w-3" />
                            </a>
                          ) : (
                            <span>{order.execution.executionRef}</span>
                          )}
                        </div>
                      ) : null}
                    </SurfaceCard>
                  );
                })
              ) : (
                <SurfaceCard tone="muted" padding="sm">
                  <div className="text-sm text-[var(--muted)]">No orders recorded for this bot yet.</div>
                </SurfaceCard>
              )}
            </div>
          ) : null}

          {activeTab === "openLots" ? (
            <div className="space-y-3">
              {bot.openCycles.length ? (
                bot.openCycles.map((cycle) => (
                  <SurfaceCard key={cycle.id} tone="muted" padding="sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-sm font-medium text-white">
                        L{String(cycle.buyLevelIndex).padStart(2, "0")} {"->"} {cycle.sellLevelIndex !== null ? `L${String(cycle.sellLevelIndex).padStart(2, "0")}` : "open exit"}
                      </span>
                      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">{cycle.lotId}</span>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm text-[var(--muted)] md:grid-cols-2">
                      <div>Buy rail {formatNumber(cycle.buyPrice, 2)}</div>
                      <div>Sell rail {cycle.sellPrice !== null ? formatNumber(cycle.sellPrice, 2) : "--"}</div>
                      <div>Open base {formatNumber(cycle.remainingBaseAmount, 6)} {bot.baseSymbol}</div>
                      <div>Cost basis {formatCurrency(cycle.costQuote)}</div>
                      <div>{formatDateTime(cycle.openedAt)}</div>
                      <div>{formatCurrency(cycle.remainingBaseAmount * (bot.position?.averageEntryPrice ?? cycle.buyPrice))} notional</div>
                    </div>
                  </SurfaceCard>
                ))
              ) : (
                <SurfaceCard tone="muted" padding="sm">
                  <div className="text-sm text-[var(--muted)]">No open lots. Filled buys will appear here until the paired sell closes the cycle.</div>
                </SurfaceCard>
              )}
            </div>
          ) : null}

          {activeTab === "alerts" ? (
            <div className="space-y-3">
              {bot.alerts.length ? (
                bot.alerts.map((alert) => (
                  <SurfaceCard key={alert.id} tone="muted" padding="sm">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 text-[var(--amber)]" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-white">{alert.title}</div>
                        <div className="mt-1 text-sm text-[var(--muted)]">{alert.message}</div>
                        <div className="mt-2 text-xs text-[var(--muted)]">{formatDateTime(alert.createdAt)}</div>
                      </div>
                    </div>
                  </SurfaceCard>
                ))
              ) : null}

              {bot.systemLogs.length ? (
                bot.systemLogs.map((log) => (
                  <SurfaceCard key={log.id} tone="muted" padding="sm">
                    <div className="flex items-start gap-3">
                      <ClipboardList className="mt-0.5 h-4 w-4 text-[var(--muted)]" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-white">{log.category}</div>
                        <div className="mt-1 text-sm text-[var(--muted)]">{log.message}</div>
                        <div className="mt-2 text-xs text-[var(--muted)]">
                          {log.level} | {formatDateTime(log.createdAt)}
                        </div>
                      </div>
                    </div>
                  </SurfaceCard>
                ))
              ) : null}

              {!bot.alerts.length && !bot.systemLogs.length ? (
                <SurfaceCard tone="muted" padding="sm">
                  <div className="text-sm text-[var(--muted)]">No alerts or useful logs for this bot right now.</div>
                </SurfaceCard>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
