"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowUpRight, CircleOff, FlaskConical, PencilLine, Play, Plus, Settings2, Square, Trash2, X } from "lucide-react";
import { BotMode, type StrategyMode } from "@grid-bot/core/enums";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";

import { BotConfigFields } from "@/components/bot-config-fields";
import { BotDetailView, type BotDetailViewData } from "@/components/bot-detail-view";
import { ActionButton } from "@/components/bot-console-primitives";
import { BotPaperSessionPanel } from "@/components/bot-paper-session-panel";
import { StatusBadge } from "@/components/status-badge";
import { SurfaceCard } from "@/components/surface-card";
import {
  applyPaperTurbo,
  applyBehaviorPreset,
  BOT_BEHAVIOR_PRESETS,
  BOT_PAIR_PRESETS,
  analyzeBotDraft,
  createDraftFromPreset,
  diffBotDraft,
  inferBehaviorPresetId,
  type BotDraftAnalysis,
  type BotDraftDiffItem,
  type BotFormDraft,
  type BotBehaviorPresetId,
  type BotPairPresetId
} from "@/lib/bot-management";
import { getNextGridTriggers, parsePendingSignal } from "@/lib/bot-runtime";
import { cn, formatCurrency, formatDateTime, formatNumber, formatPercent } from "@/lib/utils";

type ManagedBot = {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  pairLabel: string;
  presetId: BotPairPresetId | null;
  strategyMode: StrategyMode;
  mode: BotMode;
  status: string;
  executionProvider: string;
  currentPrice: number | null;
  lastHeartbeatAt: string | null;
  sparkline: number[];
  config: BotFormDraft;
  metrics: {
    deployedQuoteAmount: number;
    equity: number;
    pnl: number;
    rangeProgress: number;
    deployableUsage: number;
  };
  runtime: {
    availableQuoteAmount: number;
    availableBaseAmount: number;
    deployedQuoteAmount: number;
    averageEntryPrice: number | null;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    totalEquityUsd: number;
    consecutiveFailures: number;
    lastProcessedAt: string | null;
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
};

type BotRuntimeTelemetry = {
  id: string;
  status: string;
  currentPrice: number | null;
  lastHeartbeatAt: string | null;
  runtime: {
    availableQuoteAmount: number;
    availableBaseAmount: number;
    deployedQuoteAmount: number;
    averageEntryPrice: number | null;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    totalEquityUsd: number;
    consecutiveFailures: number;
    lastProcessedAt: string | null;
    lastExecutionAt: string | null;
    pendingSignal: unknown;
  } | null;
  paperSession: {
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
  };
};

type FeedbackState =
  | {
      tone: "success" | "error" | "info";
      message: string;
    }
  | null;

type PanelKind = "create" | "edit" | null;
type PanelTab = "setup" | "paper" | "actions";

export function BotManagementConsole({
  bots,
  liveTradingEnabled,
  initialSelectedBotId,
  botBoards
}: {
  bots: ManagedBot[];
  liveTradingEnabled: boolean;
  initialSelectedBotId?: string | null;
  botBoards: Record<string, BotDetailViewData>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(initialSelectedBotId ?? bots[0]?.id ?? null);
  const [panelKind, setPanelKind] = useState<PanelKind>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("setup");
  const [createDraft, setCreateDraft] = useState<BotFormDraft>(() => createDraftFromPreset("SOL_USDC"));
  const [editDraft, setEditDraft] = useState<BotFormDraft | null>(() => (bots[0] ? cloneDraft(bots[0].config) : null));
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [liveTelemetry, setLiveTelemetry] = useState<Record<string, BotRuntimeTelemetry>>({});
  const hydratedBotIdRef = useRef<string | null>(initialSelectedBotId ?? bots[0]?.id ?? null);

  const runtimeBots = useMemo(() => bots.map((bot) => applyTelemetry(bot, liveTelemetry[bot.id])), [bots, liveTelemetry]);

  const selectedBot = useMemo(() => runtimeBots.find((bot) => bot.id === selectedBotId) ?? runtimeBots[0] ?? null, [runtimeBots, selectedBotId]);
  const selectedBoard = selectedBot ? botBoards[selectedBot.id] ?? null : null;
  const boardPreviewDraft =
    panelKind === "edit" && panelTab === "setup" && selectedBot && editDraft
      ? editDraft
      : panelKind === "create" &&
          panelTab === "setup" &&
          selectedBot &&
          BOT_PAIR_PRESETS[createDraft.presetId].baseSymbol === selectedBot.pairLabel.split("/")[0]
        ? createDraft
        : null;

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedBotId) {
      return;
    }

    const nextUrl = `/bots?botId=${selectedBotId}`;
    if (window.location.pathname + window.location.search !== nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [selectedBotId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
      return;
    }

    const source = new EventSource("/api/bots/runtime?stream=1");
    const handleRuntime = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { bots?: BotRuntimeTelemetry[] };
        if (!payload.bots) {
          return;
        }

        setLiveTelemetry(
          payload.bots.reduce<Record<string, BotRuntimeTelemetry>>((accumulator, bot) => {
            accumulator[bot.id] = bot;
            return accumulator;
          }, {})
        );
      } catch {
        return;
      }
    };

    source.addEventListener("runtime", handleRuntime as EventListener);
    return () => {
      source.removeEventListener("runtime", handleRuntime as EventListener);
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedBot && bots.length) {
      setSelectedBotId(bots[0]?.id ?? null);
      return;
    }

    if (selectedBot) {
      if (hydratedBotIdRef.current === selectedBot.id) {
        return;
      }

      setEditDraft(cloneDraft(selectedBot.config));
      hydratedBotIdRef.current = selectedBot.id;
    } else {
      setEditDraft(null);
      hydratedBotIdRef.current = null;
    }
  }, [bots, selectedBot]);

  useEffect(() => {
    if (!panelKind) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [panelKind]);

  useEffect(() => {
    if (!feedback || feedback.tone === "error") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setFeedback((current) => (current === feedback ? null : current));
    }, 4200);

    return () => window.clearTimeout(timeoutId);
  }, [feedback]);

  useEffect(() => {
    if (!panelKind) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPanelKind(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [panelKind]);

  const paperBots = runtimeBots.filter((bot) => bot.mode === BotMode.Paper).length;
  const createDraftAnalysis = useMemo(() => analyzeBotDraft(createDraft, liveTradingEnabled), [createDraft, liveTradingEnabled]);
  const createDraftChanges = useMemo(() => diffBotDraft(createDraftFromPreset(createDraft.presetId), createDraft), [createDraft]);
  const editDraftAnalysis = useMemo(() => (editDraft ? analyzeBotDraft(editDraft, liveTradingEnabled) : null), [editDraft, liveTradingEnabled]);
  const editDraftChanges = useMemo(() => (selectedBot && editDraft ? diffBotDraft(selectedBot.config, editDraft) : []), [selectedBot, editDraft]);
  const requiresPauseBeforeEdit = Boolean(selectedBot && (selectedBot.status === "running" || selectedBot.status === "cooldown"));
  const createSubmitDisabled = isPending || busyKey === "create" || !createDraftAnalysis.canSubmit;
  const editSubmitDisabled =
    !selectedBot || !editDraft || !editDraftAnalysis?.canSubmit || !editDraftChanges.length || isPending || busyKey === `update-${selectedBot?.id}`;

  async function runMutation(input: {
    key: string;
    url: string;
    method?: "POST" | "PATCH" | "DELETE";
    body?: unknown;
    successMessage: string;
    afterSuccess?: (payload: { id?: string } | null) => void;
  }) {
    setBusyKey(input.key);
    setFeedback(null);

    try {
      const response = await fetch(input.url, {
        method: input.method ?? "POST",
        headers: input.body ? { "Content-Type": "application/json" } : undefined,
        body: input.body ? JSON.stringify(input.body) : undefined
      });

      const payload = (await response.json().catch(() => null)) as { error?: string; id?: string } | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "The request failed.");
      }

      setFeedback({ tone: "success", message: input.successMessage });

      if (payload?.id) {
        setSelectedBotId(payload.id);
      }

      input.afterSuccess?.(payload);

      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "The request failed."
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function requestJson(input: {
    url: string;
    method?: "POST" | "PATCH" | "DELETE";
    body?: unknown;
  }) {
    const response = await fetch(input.url, {
      method: input.method ?? "POST",
      headers: input.body ? { "Content-Type": "application/json" } : undefined,
      body: input.body ? JSON.stringify(input.body) : undefined
    });

    const payload = (await response.json().catch(() => null)) as { error?: string; id?: string } | null;
    if (!response.ok) {
      throw new Error(payload?.error ?? "The request failed.");
    }

    return payload;
  }

  function updateCreateDraft<K extends keyof BotFormDraft>(key: K, value: BotFormDraft[K]) {
    if (key === "presetId") {
      setCreateDraft((current) => {
        const nextDraft = createDraftFromPreset(value as BotPairPresetId);
        return applyBehaviorPreset(nextDraft, inferBehaviorPresetId(current));
      });
      return;
    }

    setCreateDraft((current) => ({ ...current, [key]: value }));
  }

  function updateEditDraft<K extends keyof BotFormDraft>(key: K, value: BotFormDraft[K]) {
    setEditDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function applyCreateBehaviorPreset(presetId: BotBehaviorPresetId) {
    setCreateDraft((current) => applyBehaviorPreset(current, presetId));
    setFeedback({
      tone: "info",
      message: `${BOT_BEHAVIOR_PRESETS[presetId].label} applied.`
    });
  }

  function applyEditBehaviorPreset(presetId: BotBehaviorPresetId) {
    setEditDraft((current) => (current ? applyBehaviorPreset(current, presetId) : current));
    setFeedback({
      tone: "info",
      message: `${BOT_BEHAVIOR_PRESETS[presetId].label} applied.`
    });
  }

  function openCreatePanel() {
    setPanelKind("create");
    setPanelTab("setup");
  }

  function openEditPanel(botId: string, tab: PanelTab = "setup") {
    setSelectedBotId(botId);
    hydratedBotIdRef.current = null;
    setPanelKind("edit");
    setPanelTab(tab);
  }

  function closePanel() {
    setPanelKind(null);
  }

  function resetCreateDraftToPreset() {
    setCreateDraft((current) => applyBehaviorPreset(createDraftFromPreset(current.presetId), inferBehaviorPresetId(current)));
  }

  function handleCreatePaperTurbo() {
    setCreateDraft((current) => applyPaperTurbo(current));
    setFeedback({
      tone: "info",
      message: `${BOT_PAIR_PRESETS[createDraft.presetId].label} paper turbo applied.`
    });
  }

  function resetEditDraft() {
    if (!selectedBot) {
      return;
    }

    setEditDraft(cloneDraft(selectedBot.config));
  }

  function handleEditPaperTurbo() {
    if (!selectedBot || !editDraft) {
      return;
    }

    setEditDraft(applyPaperTurbo(editDraft, selectedBot.currentPrice));
    setFeedback({
      tone: "info",
      message: `${selectedBot.name} paper turbo applied.`
    });
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runMutation({
      key: "create",
      url: "/api/bots",
      method: "POST",
      body: createDraft,
      successMessage: `${BOT_PAIR_PRESETS[createDraft.presetId].label} bot created in ${createDraft.mode} mode.`,
      afterSuccess: () => {
        setPanelKind(null);
        setCreateDraft(createDraftFromPreset(createDraft.presetId));
      }
    });
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBot || !editDraft) {
      return;
    }
    const key = `update-${selectedBot.id}`;
    setBusyKey(key);
    setFeedback(null);

    try {
      if (requiresPauseBeforeEdit) {
        await requestJson({
          url: `/api/bots/${selectedBot.id}/pause`,
          method: "POST"
        });
      }

      await requestJson({
        url: `/api/bots/${selectedBot.id}`,
        method: "PATCH",
        body: editDraft
      });

      setFeedback({
        tone: "success",
        message: requiresPauseBeforeEdit ? `${selectedBot.name} paused and updated.` : `${selectedBot.name} updated.`
      });
      setEditDraft(cloneDraft(editDraft));

      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "The request failed."
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function handleStatusAction(botId: string, action: "pause" | "resume" | "stop") {
    const bot = runtimeBots.find((item) => item.id === botId);
    if (!bot) {
      return;
    }

    await runMutation({
      key: `${action}-${bot.id}`,
      url: `/api/bots/${bot.id}/${action}`,
      successMessage: `${bot.name} ${action === "resume" ? "resumed" : action === "pause" ? "paused" : "stopped"}.`
    });
  }

  async function handlePaperReset() {
    if (!selectedBot) {
      return;
    }

    if (!window.confirm(`Reset paper session for ${selectedBot.name}?`)) {
      return;
    }

    await runMutation({
      key: `paper-reset-${selectedBot.id}`,
      url: `/api/bots/${selectedBot.id}/paper-reset`,
      successMessage: `${selectedBot.name} paper state reset.`
    });
  }

  async function handlePaperResetAll() {
    if (!paperBots) {
      return;
    }

    if (!window.confirm("Reset all paper bots, clear their orders/executions, and pause them?")) {
      return;
    }

    await runMutation({
      key: "paper-reset-all",
      url: "/api/bots/paper-reset-all",
      successMessage: "All paper bots reset and paused."
    });
  }

  async function handlePaperSimulation(side: "buy" | "sell") {
    if (!selectedBot) {
      return;
    }

    await runMutation({
      key: `paper-sim-${side}-${selectedBot.id}`,
      url: `/api/bots/${selectedBot.id}/paper-simulate`,
      method: "POST",
      body: { side },
      successMessage: `${selectedBot.name} paper ${side} cross simulated.`
    });
  }

  async function handleDeleteBot() {
    if (!selectedBot) {
      return;
    }

    if (!window.confirm(`Delete ${selectedBot.name}? This cannot be undone.`)) {
      return;
    }

    const nextBot = runtimeBots.find((bot) => bot.id !== selectedBot.id) ?? null;

    await runMutation({
      key: `delete-${selectedBot.id}`,
      url: `/api/bots/${selectedBot.id}`,
      method: "DELETE",
      successMessage: `${selectedBot.name} deleted.`,
      afterSuccess: () => {
        setSelectedBotId(nextBot?.id ?? null);
        setPanelKind(null);
      }
    });
  }

  async function handleModeToggle() {
    if (!selectedBot) {
      return;
    }

    const newMode = selectedBot.mode === BotMode.Paper ? BotMode.Live : BotMode.Paper;

    if (newMode === BotMode.Live && !liveTradingEnabled) {
      setFeedback({ tone: "error", message: "Live trading gate is disabled." });
      return;
    }

    const key = `mode-${selectedBot.id}`;
    setBusyKey(key);
    setFeedback(null);

    try {
      if (selectedBot.status === "running" || selectedBot.status === "cooldown") {
        await requestJson({ url: `/api/bots/${selectedBot.id}/pause`, method: "POST" });
      }

      await requestJson({
        url: `/api/bots/${selectedBot.id}`,
        method: "PATCH",
        body: { ...selectedBot.config, mode: newMode }
      });

      setFeedback({
        tone: "success",
        message: `${selectedBot.name} → ${newMode} mode.${selectedBot.status === "running" || selectedBot.status === "cooldown" ? " Bot paused." : ""}`
      });

      startTransition(() => router.refresh());
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Mode switch failed."
      });
    } finally {
      setBusyKey(null);
    }
  }

  const isRunning = selectedBot?.status === "running" || selectedBot?.status === "cooldown";

  return (
    <section className="space-y-0">
      {feedback ? (
        <div
          className={cn(
            "border px-4 py-3 text-sm",
            feedback.tone === "success"
              ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]"
              : feedback.tone === "error"
                ? "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] text-[var(--red)]"
                : "border-[var(--line)] bg-white/[0.03] text-white"
          )}
        >
          {feedback.message}
        </div>
      ) : null}

      {runtimeBots.length ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2 overflow-x-auto">
              {runtimeBots.map((bot) => {
                const isSelected = selectedBotId === bot.id;
                return (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => setSelectedBotId(bot.id)}
                    className={cn(
                      "min-w-[150px] border px-3 py-2.5 text-left transition",
                      isSelected
                        ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)]"
                        : "border-[var(--line)] bg-[var(--panel-soft)]/80 hover:bg-white/[0.04]"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium text-white">{bot.pairLabel}</div>
                        <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                          {BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(bot.config)].label}
                        </div>
                      </div>
                      <StatusBadge status={bot.status} />
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2">
              <CompactDeskButton label="New bot" icon={Plus} onClick={openCreatePanel} tone="positive" />
              <CompactDeskButton
                label="Reset paper"
                icon={FlaskConical}
                onClick={handlePaperResetAll}
                disabled={!paperBots || isPending || busyKey === "paper-reset-all"}
                tone="amber"
              />
            </div>
          </div>

          {selectedBoard ? (
            <BotDetailView
              bot={selectedBoard}
              embedded
              previewDraft={boardPreviewDraft}
              embeddedActions={
                selectedBot ? (
                  <>
                    <CompactDeskButton label="Configure" icon={Settings2} onClick={() => openEditPanel(selectedBot.id, "setup")} tone="neutral" />
                    <CompactDeskButton
                      label={selectedBot.status === "running" || selectedBot.status === "cooldown" ? "Pause" : "Resume"}
                      icon={selectedBot.status === "running" || selectedBot.status === "cooldown" ? CircleOff : Play}
                      onClick={() => handleStatusAction(selectedBot.id, selectedBot.status === "running" || selectedBot.status === "cooldown" ? "pause" : "resume")}
                      disabled={Boolean(busyKey && busyKey !== `pause-${selectedBot.id}` && busyKey !== `resume-${selectedBot.id}`)}
                      tone={selectedBot.status === "running" || selectedBot.status === "cooldown" ? "neutral" : "positive"}
                    />
                    <CompactDeskButton
                      label="Stop"
                      icon={Square}
                      onClick={() => handleStatusAction(selectedBot.id, "stop")}
                      disabled={Boolean(busyKey && busyKey !== `stop-${selectedBot.id}`)}
                      tone="negative"
                    />
                  </>
                ) : null
              }
            />
          ) : null}
        </div>
      ) : (
        <SurfaceCard padding="lg">
          <div className="flex flex-col items-start gap-4">
            <div className="space-y-2">
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">No bots</div>
              <div className="text-xl font-semibold text-white">Create the first grid</div>
              <div className="text-sm text-[var(--muted)]">Start with SOL or BTC in paper mode, test the range, then decide if the strategy should accumulate token or USDC.</div>
            </div>
            <button
              type="button"
              onClick={openCreatePanel}
              className="inline-flex items-center gap-2 border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--green)] transition hover:bg-[color:rgba(68,211,156,0.14)]"
            >
              <Plus className="h-3.5 w-3.5" />
              Create bot
            </button>
          </div>
        </SurfaceCard>
      )}

      {panelKind && portalReady ? createPortal(
        <div className="pointer-events-none fixed inset-y-0 right-0 z-50 w-full sm:max-w-[460px] sm:p-3">
          <div
            className="pointer-events-auto absolute inset-y-0 right-0 w-full overflow-hidden border-l border-[var(--line)] bg-[var(--panel)] shadow-2xl sm:inset-0 sm:border"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex h-full flex-col">
              <div className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--panel)] px-4 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">{panelKind === "create" ? "Create bot" : "Configure bot"}</div>
                    <h3 className="text-[22px] font-semibold tracking-[-0.03em] text-white">
                      {panelKind === "create" ? "New range bot" : selectedBot ? selectedBot.name : "Edit bot"}
                    </h3>
                    <div className="text-xs text-[var(--muted)]">
                      {panelKind === "create"
                        ? "Preset, budget, range, rails."
                        : selectedBot
                          ? `${selectedBot.pairLabel} | ${BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(selectedBot.config)].label}`
                          : "Select a bot."}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={closePanel}
                    className="inline-flex items-center gap-2 border border-[var(--line)] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)] transition hover:bg-white/[0.04] hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                    Close / Esc
                  </button>
                </div>

                {panelKind === "edit" && selectedBot ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <PanelTabButton active={panelTab === "setup"} onClick={() => setPanelTab("setup")} label="Setup" />
                    <PanelTabButton active={panelTab === "paper"} onClick={() => setPanelTab("paper")} label="Paper" />
                    <PanelTabButton active={panelTab === "actions"} onClick={() => setPanelTab("actions")} label="Actions" />
                    <StatusBadge status={selectedBot.status} />
                  </div>
                ) : null}
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4 pb-24">
                {panelKind === "create" ? (
                  <form className="space-y-4" onSubmit={handleCreateSubmit}>
                    <div className="space-y-3">
                      <BotConfigFields
                        values={createDraft}
                        liveTradingEnabled={liveTradingEnabled}
                        onChange={updateCreateDraft}
                        onApplyBehaviorPreset={applyCreateBehaviorPreset}
                        mode="create"
                        pairLabel={BOT_PAIR_PRESETS[createDraft.presetId].label}
                      />
                      <CompactDraftStatus
                        analysis={createDraftAnalysis}
                        changes={createDraftChanges}
                        behaviorLabel={BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(createDraft)].label}
                      />
                    </div>

                    <div className="sticky bottom-0 -mx-4 mt-6 flex flex-wrap justify-between gap-3 border-t border-[var(--line)] bg-[var(--panel)] px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={resetCreateDraftToPreset}
                          disabled={isPending}
                          className="inline-flex items-center gap-2 border border-[var(--line)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)] transition hover:bg-white/[0.04] hover:text-white disabled:opacity-50"
                        >
                          Reset preset
                        </button>
                        <button
                          type="button"
                          onClick={handleCreatePaperTurbo}
                          disabled={isPending}
                          className="inline-flex items-center gap-2 border border-[color:rgba(248,200,108,0.18)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--amber)] transition hover:bg-[color:rgba(248,200,108,0.08)] disabled:opacity-50"
                        >
                          <FlaskConical className="h-3.5 w-3.5" />
                          Paper turbo
                        </button>
                      </div>

                      <button
                        type="submit"
                        disabled={createSubmitDisabled}
                        className="inline-flex items-center gap-2 border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--green)] transition hover:bg-[color:rgba(68,211,156,0.14)] disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Create bot
                      </button>
                    </div>
                  </form>
                ) : selectedBot && editDraft ? (
                  <>
                    {panelTab === "setup" ? (
                      <form className="space-y-4" onSubmit={handleEditSubmit}>
                        <div className="space-y-3">
                          <BotConfigFields
                            values={editDraft}
                            liveTradingEnabled={liveTradingEnabled}
                            onChange={updateEditDraft}
                            onApplyBehaviorPreset={applyEditBehaviorPreset}
                            mode="edit"
                            pairLabel={selectedBot.pairLabel}
                          />
                          {editDraftAnalysis ? (
                            <CompactDraftStatus
                              analysis={editDraftAnalysis}
                              changes={editDraftChanges}
                              behaviorLabel={BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(editDraft)].label}
                            />
                          ) : null}
                        </div>

                        {requiresPauseBeforeEdit ? (
                          <SurfaceCard tone="muted" padding="sm">
                            <div className="text-xs text-[var(--muted)]">Saving pauses the bot first, then applies the new config.</div>
                          </SurfaceCard>
                        ) : null}

                        <div className="sticky bottom-0 -mx-4 mt-6 flex flex-wrap justify-between gap-3 border-t border-[var(--line)] bg-[var(--panel)] px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={resetEditDraft}
                              disabled={isPending || !editDraftChanges.length}
                              className="inline-flex items-center gap-2 border border-[var(--line)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)] transition hover:bg-white/[0.04] hover:text-white disabled:opacity-50"
                            >
                              Revert
                            </button>
                            <button
                              type="button"
                              onClick={handleEditPaperTurbo}
                              disabled={isPending}
                              className="inline-flex items-center gap-2 border border-[color:rgba(248,200,108,0.18)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--amber)] transition hover:bg-[color:rgba(248,200,108,0.08)] disabled:opacity-50"
                            >
                              <FlaskConical className="h-3.5 w-3.5" />
                              Paper turbo
                            </button>
                          </div>

                          <button
                            type="submit"
                            disabled={editSubmitDisabled}
                            className="inline-flex items-center gap-2 border border-[var(--line)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white transition hover:bg-white/[0.04] disabled:opacity-50"
                          >
                            <PencilLine className="h-3.5 w-3.5" />
                            {requiresPauseBeforeEdit ? "Pause + save" : "Save changes"}
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {panelTab === "paper" ? (
                      <div className="space-y-5">
                        <BotPaperSessionPanel bot={selectedBot} />
                        {selectedBot.mode === BotMode.Paper ? (
                          <div className="space-y-4">
                            <SurfaceCard tone="muted" padding="md">
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="space-y-2">
                                  <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Trigger tester</div>
                                  <div className="text-sm text-[var(--muted)]">Force a clean paper buy or sell cross to validate the full flow without waiting for market movement.</div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <ActionButton
                                    label="Sim buy cross"
                                    icon={Play}
                                    onClick={() => handlePaperSimulation("buy")}
                                    disabled={isPending || busyKey === `paper-sim-buy-${selectedBot.id}`}
                                    tone="positive"
                                  />
                                  <ActionButton
                                    label="Sim sell cross"
                                    icon={ArrowUpRight}
                                    onClick={() => handlePaperSimulation("sell")}
                                    disabled={isPending || busyKey === `paper-sim-sell-${selectedBot.id}`}
                                    tone="amber"
                                  />
                                  <ActionButton
                                    label="Reset paper"
                                    icon={FlaskConical}
                                    onClick={handlePaperReset}
                                    disabled={
                                      selectedBot.status === "running" ||
                                      selectedBot.status === "cooldown" ||
                                      isPending ||
                                      busyKey === `paper-reset-${selectedBot.id}`
                                    }
                                    tone="amber"
                                  />
                                </div>
                              </div>
                            </SurfaceCard>
                          </div>
                        ) : (
                          <SurfaceCard tone="muted" padding="sm">
                            <div className="text-sm text-[var(--muted)]">This bot is live. Switch it back to paper in Setup if you want to simulate again.</div>
                          </SurfaceCard>
                        )}
                      </div>
                    ) : null}

                    {panelTab === "actions" ? (
                      <div className="space-y-5">
                        <div className="grid gap-4 md:grid-cols-2">
                          <MiniInfo label="Status" value={selectedBot.status.replaceAll("_", " ")} />
                          <MiniInfo label="Provider" value={selectedBot.executionProvider} />
                          <MiniInfo label="Mode" value={selectedBot.mode} />
                          <MiniInfo label="Live gate" value={liveTradingEnabled ? "Enabled" : "Disabled"} />
                        </div>

                        <SurfaceCard tone="muted" padding="md">
                          <div className="flex flex-wrap gap-2">
                            <ActionButton
                              label="Pause"
                              icon={CircleOff}
                              onClick={() => handleStatusAction(selectedBot.id, "pause")}
                              disabled={selectedBot.status === "paused" || selectedBot.status === "stopped" || isPending || busyKey === `pause-${selectedBot.id}`}
                              tone="neutral"
                            />
                            <ActionButton
                              label="Resume"
                              icon={Play}
                              onClick={() => handleStatusAction(selectedBot.id, "resume")}
                              disabled={
                                selectedBot.status === "running" ||
                                selectedBot.status === "cooldown" ||
                                (selectedBot.mode === BotMode.Live && !liveTradingEnabled) ||
                                isPending ||
                                busyKey === `resume-${selectedBot.id}`
                              }
                              tone="positive"
                            />
                            <ActionButton
                              label="Stop"
                              icon={Square}
                              onClick={() => handleStatusAction(selectedBot.id, "stop")}
                              disabled={selectedBot.status === "stopped" || isPending || busyKey === `stop-${selectedBot.id}`}
                              tone="negative"
                            />
                          </div>
                        </SurfaceCard>

                        <SurfaceCard tone="muted" padding="md">
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Danger zone</div>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <ActionButton
                              label="Delete bot"
                              icon={Trash2}
                              onClick={handleDeleteBot}
                              disabled={selectedBot.status !== "stopped" || isPending || busyKey === `delete-${selectedBot.id}`}
                              tone="negative"
                            />
                          </div>
                          <div className="mt-3 text-sm text-[var(--muted)]">Deletion is only available when the bot is stopped.</div>
                        </SurfaceCard>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="text-sm text-[var(--muted)]">No bot selected.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      , document.body) : null}
    </section>
  );
}

function cloneDraft(draft: BotFormDraft): BotFormDraft {
  return { ...draft };
}

function applyTelemetry(bot: ManagedBot, telemetry?: BotRuntimeTelemetry): ManagedBot {
  if (!telemetry) {
    return bot;
  }

  const currentPrice = telemetry.currentPrice ?? bot.currentPrice;
  const pendingSignal = parsePendingSignal(telemetry.runtime?.pendingSignal, bot.config.priceConfirmationWindowMs);
  const nextTriggers = getNextGridTriggers(bot.config, currentPrice);

  return {
    ...bot,
    status: telemetry.status,
    currentPrice,
    lastHeartbeatAt: telemetry.lastHeartbeatAt ?? bot.lastHeartbeatAt,
    metrics: {
      ...bot.metrics,
      deployedQuoteAmount: telemetry.runtime?.deployedQuoteAmount ?? bot.metrics.deployedQuoteAmount,
      rangeProgress:
        currentPrice !== null && bot.config.highPrice > bot.config.lowPrice
          ? ((currentPrice - bot.config.lowPrice) / (bot.config.highPrice - bot.config.lowPrice)) * 100
          : bot.metrics.rangeProgress,
      equity: telemetry.runtime?.totalEquityUsd ?? bot.metrics.equity,
      pnl: telemetry.runtime ? telemetry.runtime.realizedPnlUsd + telemetry.runtime.unrealizedPnlUsd : bot.metrics.pnl
    },
    runtime: {
      ...bot.runtime,
      availableQuoteAmount: telemetry.runtime?.availableQuoteAmount ?? bot.runtime.availableQuoteAmount,
      availableBaseAmount: telemetry.runtime?.availableBaseAmount ?? bot.runtime.availableBaseAmount,
      deployedQuoteAmount: telemetry.runtime?.deployedQuoteAmount ?? bot.runtime.deployedQuoteAmount,
      averageEntryPrice: telemetry.runtime?.averageEntryPrice ?? bot.runtime.averageEntryPrice,
      realizedPnlUsd: telemetry.runtime?.realizedPnlUsd ?? bot.runtime.realizedPnlUsd,
      unrealizedPnlUsd: telemetry.runtime?.unrealizedPnlUsd ?? bot.runtime.unrealizedPnlUsd,
      totalEquityUsd: telemetry.runtime?.totalEquityUsd ?? bot.runtime.totalEquityUsd,
      consecutiveFailures: telemetry.runtime?.consecutiveFailures ?? bot.runtime.consecutiveFailures,
      lastProcessedAt: telemetry.runtime?.lastProcessedAt ?? bot.runtime.lastProcessedAt,
      lastExecutionAt: telemetry.runtime?.lastExecutionAt ?? bot.runtime.lastExecutionAt,
      nextBuyLevel: nextTriggers.nextBuyLevel,
      nextSellLevel: nextTriggers.nextSellLevel,
      pendingSignal: pendingSignal
        ? {
            side: pendingSignal.side,
            levelIndex: pendingSignal.levelIndex,
            firstObservedAt: pendingSignal.firstObservedAt,
            lastObservedPrice: pendingSignal.lastObservedPrice,
            remainingMs: pendingSignal.remainingMs,
            ready: pendingSignal.ready
          }
        : null
    },
    paperSession: {
      ...bot.paperSession,
      ordersCount: telemetry.paperSession.ordersCount,
      executionsCount: telemetry.paperSession.executionsCount,
      latestExecutionAt: telemetry.paperSession.latestExecutionAt,
      latestExecutionStatus: telemetry.paperSession.latestExecutionStatus,
      latestExecutionInputAmount: telemetry.paperSession.latestExecutionInputAmount,
      latestExecutionOutputAmount: telemetry.paperSession.latestExecutionOutputAmount,
      latestExecutionPrice: telemetry.paperSession.latestExecutionPrice ?? bot.paperSession.latestExecutionPrice,
      latestOrderSide: telemetry.paperSession.latestOrderSide,
      latestOrderStatus: telemetry.paperSession.latestOrderStatus,
      latestOrderAt: telemetry.paperSession.latestOrderAt
    }
  };
}

function PanelTabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition",
        active ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]" : "border-[var(--line)] text-[var(--muted)] hover:bg-white/[0.04] hover:text-white"
      )}
    >
      {label}
    </button>
  );
}

function CompactDraftStatus({
  analysis,
  changes,
  behaviorLabel
}: {
  analysis: BotDraftAnalysis;
  changes: BotDraftDiffItem[];
  behaviorLabel: string;
}) {
  const topIssues = analysis.issues.slice(0, 2);

  return (
    <div className="border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip label={analysis.canSubmit ? "ready" : "fix"} tone={analysis.canSubmit ? "positive" : "negative"} />
        <StatusChip label={behaviorLabel} tone="default" />
        <StatusChip label={`${changes.length} changes`} tone={changes.length ? "amber" : "default"} />
        <StatusChip label={`${formatCurrency(analysis.summary.levelBudgetUsd)} / rail`} tone="default" />
        <StatusChip label={`${formatPercent(analysis.summary.rangeWidthPct, 1)} width`} tone="default" />
      </div>

      {topIssues.length ? (
        <div className="mt-3 space-y-1.5">
          {topIssues.map((issue, index) => (
            <div key={`${issue.field ?? "issue"}-${index}`} className={cn("text-xs", issue.tone === "error" ? "text-[var(--red)]" : "text-[var(--amber)]")}>
              {issue.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CompactDeskButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  tone
}: {
  label: string;
  icon: typeof Plus;
  onClick: () => void;
  disabled?: boolean;
  tone: "neutral" | "positive" | "negative" | "amber";
}) {
  const toneClass =
    tone === "positive"
      ? "border-[color:rgba(68,211,156,0.18)] text-[var(--green)] hover:bg-[color:rgba(68,211,156,0.08)]"
      : tone === "negative"
        ? "border-[color:rgba(255,107,122,0.18)] text-[var(--red)] hover:bg-[color:rgba(255,107,122,0.08)]"
        : tone === "amber"
          ? "border-[color:rgba(248,200,108,0.18)] text-[var(--amber)] hover:bg-[color:rgba(248,200,108,0.08)]"
          : "border-[var(--line)] text-[var(--muted)] hover:bg-white/[0.04] hover:text-white";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition disabled:cursor-wait disabled:opacity-50",
        toneClass
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

function MiniInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
      <div className="mt-1.5 text-xs text-white">{value}</div>
    </div>
  );
}

function StatusChip({
  label,
  tone
}: {
  label: string;
  tone: "default" | "positive" | "negative" | "amber";
}) {
  const toneClass =
    tone === "positive"
      ? "border-[color:rgba(68,211,156,0.18)] text-[var(--green)]"
      : tone === "negative"
        ? "border-[color:rgba(255,107,122,0.18)] text-[var(--red)]"
        : tone === "amber"
          ? "border-[color:rgba(248,200,108,0.18)] text-[var(--amber)]"
          : "border-[var(--line)] text-[var(--muted)]";

  return <span className={cn("border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em]", toneClass)}>{label}</span>;
}
