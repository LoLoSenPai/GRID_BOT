"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowUpRight, CircleOff, FlaskConical, PencilLine, Play, Plus, Square, Trash2 } from "lucide-react";
import { BotMode, type StrategyMode } from "@grid-bot/core/enums";
import { useRouter } from "next/navigation";


import { BotConfigFields } from "@/components/bot-config-fields";
import { BotDetailView, type BotDetailRuntimeData, type BotDetailViewData } from "@/components/bot-detail-view";

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
import { calculateGridLevels, getNextGridTriggers, parsePendingSignal } from "@/lib/bot-runtime";
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
  totalBudgetUsd?: number;
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
  deskMode,
  liveTradingEnabled,
  initialSelectedBotId,
  botBoards,
  marketPreviewBoards = {}
}: {
  bots: ManagedBot[];
  deskMode: BotMode;
  liveTradingEnabled: boolean;
  initialSelectedBotId?: string | null;
  botBoards: Record<string, BotDetailViewData>;
  marketPreviewBoards?: Partial<Record<"SOL" | "BTC", BotDetailViewData>>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(initialSelectedBotId ?? bots[0]?.id ?? null);
  const [panelKind, setPanelKind] = useState<PanelKind>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("setup");
  const [createDraft, setCreateDraft] = useState<BotFormDraft>(() => createDraftFromPreset("SOL_USDC", deskMode));
  const [editDraft, setEditDraft] = useState<BotFormDraft | null>(() => (bots[0] ? cloneDraft(bots[0].config) : null));
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [liveTelemetry, setLiveTelemetry] = useState<Record<string, BotRuntimeTelemetry>>({});
  const hydratedBotIdRef = useRef<string | null>(initialSelectedBotId ?? bots[0]?.id ?? null);

  const runtimeBots = useMemo(() => bots.map((bot) => applyTelemetry(bot, liveTelemetry[bot.id])), [bots, liveTelemetry]);
  const hasBots = runtimeBots.length > 0;

  const selectedBot = useMemo(() => runtimeBots.find((bot) => bot.id === selectedBotId) ?? runtimeBots[0] ?? null, [runtimeBots, selectedBotId]);
  const selectedBoard = selectedBot ? botBoards[selectedBot.id] ?? null : null;
  const boardsBySymbol = useMemo(
    () =>
      Object.values(botBoards).reduce<Partial<Record<"SOL" | "BTC", BotDetailViewData>>>((accumulator, board) => {
        accumulator[board.baseSymbol] ??= board;
        return accumulator;
      }, {}),
    [botBoards]
  );
  const createBaseSymbol = BOT_PAIR_PRESETS[createDraft.presetId].baseSymbol as "SOL" | "BTC";
  const createBoardSource = boardsBySymbol[createBaseSymbol] ?? marketPreviewBoards[createBaseSymbol] ?? null;
  const createPreviewBoard = useMemo(
    () => (createBoardSource ? buildCreatePreviewBoard(createBoardSource, createDraft) : null),
    [createBoardSource, createDraft]
  );
  const activeBoard = panelKind === "create" ? createPreviewBoard : selectedBoard;
  const selectedRuntimeData = useMemo<BotDetailRuntimeData | null>(() => {
    if (!selectedBot) {
      return null;
    }

    return {
      currentPrice: selectedBot.currentPrice,
      lastHeartbeatAt: selectedBot.lastHeartbeatAt,
      status: selectedBot.status,
      lastProcessedAt: selectedBot.runtime.lastProcessedAt,
      lastExecutionAt: selectedBot.runtime.lastExecutionAt
    };
  }, [selectedBot]);
  const activePreviewDraft =
    panelKind === "create" && panelTab === "setup"
      ? createDraft
      : panelKind === "edit" && panelTab === "setup" && editDraft
        ? editDraft
        : null;



  useEffect(() => {
    setCreateDraft((current) => ({ ...current, mode: deskMode }));
  }, [deskMode]);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedBotId) {
      return;
    }

    const nextUrl = `/bots?deskMode=${deskMode}&botId=${selectedBotId}`;
    if (window.location.pathname + window.location.search !== nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [deskMode, selectedBotId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
      return;
    }

    setLiveTelemetry({});
    const source = new EventSource(`/api/bots/runtime?stream=1&mode=${deskMode}`);
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
  }, [deskMode]);



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
    if (!hasBots) {
      setPanelKind("create");
      setPanelTab("setup");
      hydratedBotIdRef.current = null;
    }
  }, [hasBots]);



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
  const createDraftChanges = useMemo(
    () => diffBotDraft(createDraftFromPreset(createDraft.presetId, createDraft.mode), createDraft),
    [createDraft],
  );
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
        const nextDraft = createDraftFromPreset(
          value as BotPairPresetId,
          current.mode,
        );
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
    setCreateDraft((current) => ({ ...current, mode: deskMode }));
    setPanelKind("create");
    setPanelTab("setup");
  }

  function openEditPanel(botId: string, tab: PanelTab = "setup") {
    setSelectedBotId(botId);
    hydratedBotIdRef.current = null;
    setPanelKind("edit");
    setPanelTab(tab);
  }

  function resetCreateDraftToPreset() {
    setCreateDraft((current) =>
      applyBehaviorPreset(
        createDraftFromPreset(current.presetId, current.mode),
        inferBehaviorPresetId(current),
      ),
    );
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
      afterSuccess: (payload) => {
        if (payload?.id) {
          router.replace(`/bots?deskMode=${createDraft.mode}&botId=${payload.id}`);
        }
        setPanelKind(null);
        setCreateDraft(createDraftFromPreset(createDraft.presetId, deskMode));
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

  async function handleCloneLive() {
    if (!selectedBot) {
      return;
    }

    await runMutation({
      key: `clone-live-${selectedBot.id}`,
      url: `/api/bots/${selectedBot.id}/clone-live`,
      method: "POST",
      successMessage: `${selectedBot.name} cloned to live.`,
      afterSuccess: (payload) => {
        const nextUrl = payload?.id
          ? `/bots?deskMode=live&botId=${payload.id}`
          : "/bots?deskMode=live";
        router.replace(nextUrl);
      },
    });
  }

  const isRunning = selectedBot?.status === "running" || selectedBot?.status === "cooldown";

  return (
    <section className="space-y-0">
      {/* ─── Feedback toast ─── */}
      {feedback ? (
        <div
          className={cn(
            "border px-4 py-2.5 text-sm",
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

      {hasBots ? (
        <>
          {/* ═══ SECTION 1 — Chart + Config side panel ═══ */}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]">
            {/* ─── Left: Chart ─── */}
            <div className="min-w-0 border-r border-[var(--line)]">
              {activeBoard ? (
                <BotDetailView
                  bot={activeBoard}
                  embedded
                  previewDraft={activePreviewDraft}
                  runtimeStreamUrl={null}
                  runtimeData={panelKind === "create" ? null : selectedRuntimeData}
                />
              ) : (
                <div className="flex h-[500px] items-center justify-center text-sm text-[var(--muted)]">Select a bot below</div>
              )}
            </div>

            {/* ─── Right: Config panel ─── */}
            <aside className="flex max-h-[calc(100vh-160px)] flex-col overflow-hidden bg-[var(--panel-soft)]/60">
              {/* Panel header */}
              <div className="border-b border-[var(--line)] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <PanelTabButton active={panelKind !== "create"} onClick={() => { if (selectedBot) { setPanelKind("edit"); setPanelTab("setup"); } }} label="Configure" />
                    <PanelTabButton active={panelKind === "create"} onClick={openCreatePanel} label="+New" />
                  </div>
                </div>
                {panelKind !== "create" && selectedBot ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-white">{selectedBot.pairLabel}</span>
                    <StatusBadge status={selectedBot.status} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                      {BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(selectedBot.config)].label}
                    </span>
                  </div>
                ) : panelKind === "create" ? (
                  <div className="mt-2 text-sm text-white">New range bot</div>
                ) : null}
              </div>

              {/* Panel body (scrollable) */}
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {panelKind === "create" ? (
                  <form className="space-y-3" onSubmit={handleCreateSubmit}>
                    <BotConfigFields
                      values={createDraft}
                      botMode={createDraft.mode}
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
                    <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--line)] pt-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={resetCreateDraftToPreset} disabled={isPending} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] transition hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-50">Reset</button>
                        {createDraft.mode === BotMode.Paper ? (
                          <button type="button" onClick={handleCreatePaperTurbo} disabled={isPending} className="inline-flex items-center gap-1.5 rounded-md border border-[color:rgba(248,200,108,0.18)] px-2.5 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--amber)] transition hover:bg-[color:rgba(248,200,108,0.08)] disabled:pointer-events-none disabled:opacity-50">
                            <FlaskConical className="h-3 w-3" />Turbo
                          </button>
                        ) : null}
                      </div>
                      <button type="submit" disabled={createSubmitDisabled} className="inline-flex items-center gap-1.5 rounded-md border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-3 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--green)] transition hover:bg-[color:rgba(68,211,156,0.14)] disabled:pointer-events-none disabled:opacity-50">
                        <Plus className="h-3 w-3" />Create
                      </button>
                    </div>
                  </form>
                ) : selectedBot && editDraft ? (
                  <form className="space-y-3" onSubmit={handleEditSubmit}>
                    <BotConfigFields
                      values={editDraft}
                      botMode={selectedBot.mode}
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
                    {requiresPauseBeforeEdit ? (
                      <div className="text-xs text-[var(--muted)]">Saving pauses the bot first.</div>
                    ) : null}
                    <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--line)] pt-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={resetEditDraft} disabled={isPending || !editDraftChanges.length} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] transition hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-50">Revert</button>
                        {selectedBot.mode === BotMode.Paper ? (
                          <button type="button" onClick={handleEditPaperTurbo} disabled={isPending} className="inline-flex items-center gap-1.5 rounded-md border border-[color:rgba(248,200,108,0.18)] px-2.5 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--amber)] transition hover:bg-[color:rgba(248,200,108,0.08)] disabled:pointer-events-none disabled:opacity-50">
                            <FlaskConical className="h-3 w-3" />Turbo
                          </button>
                        ) : null}
                      </div>
                      <button type="submit" disabled={editSubmitDisabled} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-3 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-white transition hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-50">
                        <PencilLine className="h-3 w-3" />{requiresPauseBeforeEdit ? "Pause + save" : "Save"}
                      </button>
                    </div>

                    {/* Inline actions */}
                    <div className="space-y-2 border-t border-[var(--line)] pt-3">
                      <div className="flex flex-wrap gap-2">
                        <CompactDeskButton
                          label={isRunning ? "Pause" : "Resume"}
                          icon={isRunning ? CircleOff : Play}
                          onClick={() => handleStatusAction(selectedBot.id, isRunning ? "pause" : "resume")}
                          disabled={Boolean(busyKey && busyKey !== `pause-${selectedBot.id}` && busyKey !== `resume-${selectedBot.id}`)}
                          tone={isRunning ? "neutral" : "positive"}
                        />
                        <CompactDeskButton
                          label="Stop"
                          icon={Square}
                          onClick={() => handleStatusAction(selectedBot.id, "stop")}
                          disabled={Boolean(busyKey && busyKey !== `stop-${selectedBot.id}`)}
                          tone="negative"
                        />
                        <CompactDeskButton
                          label="Delete"
                          icon={Trash2}
                          onClick={handleDeleteBot}
                          disabled={selectedBot.status !== "stopped" || isPending || busyKey === `delete-${selectedBot.id}`}
                          tone="negative"
                        />
                      </div>
                      {selectedBot.mode === BotMode.Paper ? (
                        <div className="flex flex-wrap gap-2">
                          <CompactDeskButton label="Sim buy" icon={Play} onClick={() => handlePaperSimulation("buy")} disabled={isPending || busyKey === `paper-sim-buy-${selectedBot.id}`} tone="positive" />
                          <CompactDeskButton label="Sim sell" icon={ArrowUpRight} onClick={() => handlePaperSimulation("sell")} disabled={isPending || busyKey === `paper-sim-sell-${selectedBot.id}`} tone="amber" />
                          <CompactDeskButton label="Reset paper" icon={FlaskConical} onClick={handlePaperReset} disabled={isRunning || isPending || busyKey === `paper-reset-${selectedBot.id}`} tone="amber" />
                          <CompactDeskButton label="Clone live" icon={ArrowUpRight} onClick={handleCloneLive} disabled={isPending || !liveTradingEnabled || busyKey === `clone-live-${selectedBot.id}`} tone="neutral" />
                        </div>
                      ) : null}
                    </div>
                  </form>
                ) : (
                  <div className="flex h-40 items-center justify-center text-sm text-[var(--muted)]">Select a bot below</div>
                )}
              </div>
            </aside>
          </div>

          {/* ═══ SECTION 2 — Bot roster table ═══ */}
          <div className="border-t border-[var(--line)]">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">{deskMode === BotMode.Live ? "Live bots" : "Paper bots"} ({runtimeBots.length})</span>
                <CompactDeskButton label="New bot" icon={Plus} onClick={openCreatePanel} tone="positive" />
                {deskMode === BotMode.Paper ? (
                  <CompactDeskButton label="Reset paper" icon={FlaskConical} onClick={handlePaperResetAll} disabled={!paperBots || isPending || busyKey === "paper-reset-all"} tone="amber" />
                ) : null}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--line)] text-[var(--muted)]">
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal">Bot</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal">Pair</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal">Mode</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal text-right">Budget</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal text-right">Equity</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal text-right">PnL</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal text-right">ROI</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal text-right">Spot</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal text-right">Range</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal text-center">Status</th>
                    <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {runtimeBots.map((bot) => {
                    const isSelected = selectedBotId === bot.id;
                    const pnlValue = bot.metrics.pnl;
                    const roiPct = bot.config.totalBudgetUsd > 0 ? (pnlValue / bot.config.totalBudgetUsd) * 100 : 0;
                    return (
                      <tr
                        key={bot.id}
                        onClick={() => { setSelectedBotId(bot.id); setPanelKind("edit"); setPanelTab("setup"); }}
                        className={cn(
                          "cursor-pointer border-b border-[var(--line)] transition",
                          isSelected
                            ? "bg-[color:rgba(68,211,156,0.06)]"
                            : "hover:bg-white/[0.02]"
                        )}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-white">{bot.name}</div>
                          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                            {BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(bot.config)].label}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-white">{bot.pairLabel}</td>
                        <td className="px-4 py-3">
                          <span className={cn(
                            "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]",
                            bot.mode === BotMode.Paper
                              ? "border-[color:rgba(248,200,108,0.18)] text-[var(--amber)]"
                              : "border-[color:rgba(68,211,156,0.18)] text-[var(--green)]"
                          )}>
                            {bot.mode}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[var(--muted)]">{formatCurrency(bot.config.totalBudgetUsd)}</td>
                        <td className="px-4 py-3 text-right font-mono text-white">{formatCurrency(bot.metrics.equity)}</td>
                        <td className={cn("px-4 py-3 text-right font-mono", pnlValue >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                          {pnlValue >= 0 ? "+" : ""}{formatCurrency(pnlValue)}
                        </td>
                        <td className={cn("px-4 py-3 text-right font-mono text-[11px]", roiPct >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                          {roiPct >= 0 ? "+" : ""}{formatNumber(roiPct, 2)}%
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white">
                          {bot.currentPrice ? formatNumber(bot.currentPrice, bot.currentPrice >= 1000 ? 0 : 2) : "--"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-2">
                            <span className="font-mono text-[10px] text-[var(--muted)]">
                              {formatNumber(bot.config.lowPrice, bot.config.lowPrice >= 1000 ? 0 : 2)}-{formatNumber(bot.config.highPrice, bot.config.highPrice >= 1000 ? 0 : 2)}
                            </span>
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.06]">
                              <div className="h-full rounded-full bg-[linear-gradient(90deg,var(--green),var(--amber))]" style={{ width: `${Math.max(0, Math.min(100, bot.metrics.rangeProgress))}%` }} />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <StatusBadge status={bot.status} />
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openEditPanel(bot.id, "setup"); }}
                            className="rounded-md border border-[var(--line)] px-2 h-6 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] transition hover:bg-white/[0.04] hover:text-white"
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 border-r border-[var(--line)]">
            {createPreviewBoard ? (
              <BotDetailView bot={createPreviewBoard} embedded previewDraft={createDraft} runtimeStreamUrl={null} />
            ) : (
              <div className="flex h-[500px] items-center justify-center text-sm text-[var(--muted)]">Loading market board…</div>
            )}
          </div>

          <aside className="border border-[var(--line)] border-l-0 bg-[var(--panel-soft)]/60">
            <div className="border-b border-[var(--line)] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                  {deskMode === BotMode.Live ? "New live bot" : "New paper bot"}
                </div>
                <button
                  type="button"
                  onClick={resetCreateDraftToPreset}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] transition hover:bg-white/[0.04]"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="max-h-[calc(100vh-220px)] overflow-y-auto px-4 py-3">
              <form className="space-y-3" onSubmit={handleCreateSubmit}>
                <BotConfigFields
                  values={createDraft}
                  botMode={createDraft.mode}
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
                <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--line)] pt-3">
                  <div className="flex flex-wrap gap-2">
                    {createDraft.mode === BotMode.Paper ? (
                      <button
                        type="button"
                        onClick={handleCreatePaperTurbo}
                        disabled={isPending}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[color:rgba(248,200,108,0.18)] px-2.5 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--amber)] transition hover:bg-[color:rgba(248,200,108,0.08)] disabled:pointer-events-none disabled:opacity-50"
                      >
                        <FlaskConical className="h-3 w-3" />
                        Turbo
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="submit"
                    disabled={createSubmitDisabled}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-3 h-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--green)] transition hover:bg-[color:rgba(68,211,156,0.14)] disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    Create
                  </button>
                </div>
              </form>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

function cloneDraft(draft: BotFormDraft): BotFormDraft {
  return { ...draft };
}

function buildCreatePreviewBoard(source: BotDetailViewData, draft: BotFormDraft): BotDetailViewData {
  const pairPreset = BOT_PAIR_PRESETS[draft.presetId];
  const behaviorPreset = BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(draft)];
  const currentPrice = source.currentPrice || source.initialCandles.at(-1)?.close || draft.lowPrice;
  const levels = calculateGridLevels({
    lowPrice: draft.lowPrice,
    highPrice: draft.highPrice,
    levelCount: draft.levelCount,
    gridType: draft.gridType
  });

  return {
    ...source,
    id: `preview-${pairPreset.id}-${draft.mode}`,
    name: pairPreset.defaultName,
    baseSymbol: pairPreset.baseSymbol,
    quoteSymbol: pairPreset.quoteSymbol,
    strategyMode: draft.strategyMode,
    mode: draft.mode,
    status: "paused",
    behavior: {
      id: behaviorPreset.id,
      label: behaviorPreset.label,
      summary: behaviorPreset.summary,
      operatorHint: behaviorPreset.operatorHint,
      cycleRule: behaviorPreset.cycleRule,
      exitRule: behaviorPreset.exitRule,
      tags: [...behaviorPreset.tags]
    },
    currentPrice,
    lastHeartbeatAt: null,
    config: {
      ...source.config,
      lowPrice: draft.lowPrice,
      highPrice: draft.highPrice,
      levelCount: draft.levelCount,
      gridType: draft.gridType,
      minOrderQuoteAmount: draft.minOrderQuoteAmount,
      maxDeployableUsd: draft.maxDeployableUsd,
      reserveQuoteAmount: draft.reserveQuoteAmount,
      cooldownMs: draft.cooldownMs,
      maxOrdersPerHour: draft.maxOrdersPerHour,
      maxDrawdownPct: draft.maxDrawdownPct,
      priceConfirmationWindowMs: draft.priceConfirmationWindowMs,
      recenterMode: draft.recenterMode
    },
    levels,
    position: null,
    metrics: {
      deployedQuoteAmount: 0,
      inventoryValue: 0,
      rangeProgress:
        draft.highPrice > draft.lowPrice
          ? Math.max(0, Math.min(100, ((currentPrice - draft.lowPrice) / (draft.highPrice - draft.lowPrice)) * 100))
          : 0,
      deployableUsage: 0
    },
    orders: [],
    positionLots: [],
    openCycles: [],
    alerts: [],
    systemLogs: []
  };
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
        "inline-flex items-center gap-1.5 rounded-md border px-3 h-8 font-mono text-[10px] uppercase tracking-[0.14em] transition",
        active ? "border-[color:rgba(68,211,156,0.25)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]" : "border-[var(--line)] text-[var(--muted)] hover:bg-white/[0.04] hover:text-white"
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
    <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
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
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 h-7 font-mono text-[10px] uppercase tracking-[0.12em] transition disabled:pointer-events-none disabled:opacity-50",
        toneClass
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {label}
    </button>
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

  return <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]", toneClass)}>{label}</span>;
}
