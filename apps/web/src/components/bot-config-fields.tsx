import { ChevronDown } from "lucide-react";
import { BotMode, type GridType, type RecenterMode } from "@grid-bot/core/enums";

import {
  BOT_BEHAVIOR_PRESETS,
  BOT_BEHAVIOR_PRESET_IDS,
  BOT_PAIR_PRESETS,
  BOT_PAIR_PRESET_IDS,
  GRID_TYPE_OPTIONS,
  RECENTER_MODE_OPTIONS,
  getBudgetPerCycleUsd,
  getSuggestedMinOrderQuoteAmount,
  getTradeCycleCount,
  inferBehaviorPresetId,
  type BotFormDraft,
  type BotBehaviorPresetId,
  type BotPairPresetId
} from "@/lib/bot-management";
import { Field, NumberField, SelectField, TextField, formControlClass } from "@/components/bot-console-primitives";
import { cn, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

export type ConfigSectionId = "core" | "grid" | "capital" | "execution" | "advanced";

export function BotConfigFields({
  values,
  botMode,
  liveTradingEnabled,
  onChange,
  onApplyBehaviorPreset,
  mode,
  pairLabel,
  availableUsd,
  openSection,
  onToggleSection
}: {
  values: BotFormDraft;
  botMode: BotMode;
  liveTradingEnabled: boolean;
  onChange: <K extends keyof BotFormDraft>(key: K, value: BotFormDraft[K]) => void;
  onApplyBehaviorPreset: (presetId: BotBehaviorPresetId) => void;
  mode: "create" | "edit";
  pairLabel: string;
  availableUsd?: number | null;
  openSection: ConfigSectionId | null;
  onToggleSection: (section: ConfigSectionId) => void;
}) {
  const activeBehaviorPreset = inferBehaviorPresetId(values);
  const activePreset = BOT_BEHAVIOR_PRESETS[activeBehaviorPreset];
  const tradeCycleCount = getTradeCycleCount(values.levelCount);
  const railSpan = tradeCycleCount > 0 ? (values.highPrice - values.lowPrice) / tradeCycleCount : 0;
  const midPrice = values.lowPrice > 0 && values.highPrice > 0 ? (values.lowPrice + values.highPrice) / 2 : 0;
  const geometricStepPct =
    values.gridType === "geometric" && values.lowPrice > 0 && values.highPrice > values.lowPrice && values.levelCount > 1
      ? (Math.pow(values.highPrice / values.lowPrice, 1 / (values.levelCount - 1)) - 1) * 100
      : null;
  const railGainPct = values.gridType === "geometric" ? geometricStepPct ?? 0 : midPrice > 0 ? (railSpan / midPrice) * 100 : 0;
  const budgetPerCycle = getBudgetPerCycleUsd(values.maxDeployableUsd, values.levelCount);
  const suggestedMinOrder = getSuggestedMinOrderQuoteAmount(values);
  const goalSummary = getGoalSummary(activeBehaviorPreset, pairLabel);
  const spacingLabel = values.gridType === "arithmetic" ? "Even dollars" : "Even percentages";

  return (
    <div className="space-y-3">
      <ConfigSection id="core" title="Core" open={openSection === "core"} onToggle={onToggleSection}>
        <div className="grid gap-3 sm:grid-cols-2">
          {mode === "create" ? (
            <Field label="Pair">
              <select value={values.presetId} onChange={(event) => onChange("presetId", event.currentTarget.value as BotPairPresetId)} className={compactFormControlClass}>
                {BOT_PAIR_PRESET_IDS.map((presetId) => (
                  <option key={presetId} value={presetId}>
                    {BOT_PAIR_PRESETS[presetId].label}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Pair">
              <div className="flex h-8 items-center rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[13px] text-white">{pairLabel}</div>
            </Field>
          )}

          <TextField label="Name" value={values.name} onChange={(value) => onChange("name", value)} />
        </div>

        <div className="mt-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Style</div>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
            {BOT_BEHAVIOR_PRESET_IDS.map((presetId) => {
              const preset = BOT_BEHAVIOR_PRESETS[presetId];
              const active = activeBehaviorPreset === presetId;
              const summary = getGoalSummary(presetId, pairLabel);

              return (
                <button
                  key={presetId}
                  type="button"
                  onClick={() => onApplyBehaviorPreset(presetId)}
                  className={cn(
                    "rounded-md border px-2.5 py-2 text-left transition",
                    active
                      ? "border-[var(--accent-line)] bg-[var(--accent-soft)]"
                      : "border-[var(--line)] bg-[var(--bg)] hover:bg-white/[0.04]"
                  )}
                >
                  <div className={cn("text-[13px] font-medium", active ? "text-white" : "text-white/80")}>{preset.label}</div>
                  <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">{summary}</div>
                </button>
              );
            })}
          </div>

          <div className="mt-2 space-y-1 text-[11px] leading-4 text-[var(--muted)]">
            <div>{goalSummary}</div>
            <div>{activePreset.exitRule}</div>
          </div>
        </div>
      </ConfigSection>

      <ConfigSection id="grid" title="Grid" open={openSection === "grid"} onToggle={onToggleSection}>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Range low" value={values.lowPrice} onChange={(value) => onChange("lowPrice", value)} min={0.000001} step="any" />
          <NumberField label="Range high" value={values.highPrice} onChange={(value) => onChange("highPrice", value)} min={0.000001} step="any" />
          <NumberField
            label="Rails"
            hint={tradeCycleCount > 0 ? `${values.levelCount} rails = ${tradeCycleCount} adjacent trade cycles.` : "Add at least 2 rails."}
            value={values.levelCount}
            onChange={(value) => onChange("levelCount", value)}
            min={2}
            max={120}
            step={1}
          />
          <SelectField
            label="Spacing"
            value={values.gridType}
            onChange={(value) => onChange("gridType", value as GridType)}
            options={GRID_TYPE_OPTIONS.map((value) => ({
              value,
              label: value === "arithmetic" ? "Even dollars (arithmetic)" : "Even percentages (geometric)"
            }))}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <CompactMetric label="Trade cycles" value={formatNumber(tradeCycleCount, 0)} hint="One buy opens one cycle" />
          <CompactMetric label="Step" value={formatNumber(railSpan, values.highPrice >= 1000 ? 0 : 2)} hint={spacingLabel} />
          <CompactMetric label="Gain / cycle" value={formatPercent(railGainPct, 2)} hint="Approx" />
        </div>

        <div className="mt-3 rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
          Lowest rail can only buy. Highest rail can only sell. Middle rails can close one cycle and open the next.
        </div>
      </ConfigSection>

      <ConfigSection id="capital" title="Capital" open={openSection === "capital"} onToggle={onToggleSection}>
        {availableUsd != null && botMode === BotMode.Live ? (
          <div className={cn(
            "mb-3 flex items-center justify-between rounded-md border px-2.5 py-1.5 font-mono text-[10px]",
            values.totalBudgetUsd > availableUsd
              ? "border-[color:rgba(239,68,68,0.25)] bg-[color:rgba(239,68,68,0.06)] text-[var(--red)]"
              : "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
          )}>
            <span className="uppercase tracking-[0.14em]">Available USDC</span>
            <span>{formatCurrency(availableUsd)}</span>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-1">
          <NumberField
            label="Bot budget"
            hint="How much USDC from the wallet you allocate to this bot."
            value={values.totalBudgetUsd}
            onChange={(value) => onChange("totalBudgetUsd", value)}
            min={1}
            step={10}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <CompactMetric label="Active budget" value={formatCurrency(values.totalBudgetUsd)} hint="The whole bot budget is active by default" />
          <CompactMetric label="Per cycle" value={formatCurrency(budgetPerCycle)} hint={tradeCycleCount > 0 ? `${tradeCycleCount} adjacent cycles` : "Needs 2 rails"} />
          <CompactMetric label="Auto min order" value={formatCurrency(suggestedMinOrder)} hint="Override manually in Advanced if needed" />
        </div>
      </ConfigSection>

      <ConfigSection id="execution" title="Execution" open={openSection === "execution"} onToggle={onToggleSection}>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Confirmation delay" hint="How long a touch must persist before it becomes a signal." value={values.priceConfirmationWindowMs} onChange={(value) => onChange("priceConfirmationWindowMs", value)} min={0} step={1000} />
          <NumberField label="Rail cooldown" hint="How long a used rail stays blocked before it can arm again." value={values.levelLockMs} onChange={(value) => onChange("levelLockMs", value)} min={0} step={1000} />
          <NumberField label="Orders / hour" hint="Safety cap against churn." value={values.maxOrdersPerHour} onChange={(value) => onChange("maxOrdersPerHour", value)} min={1} max={500} step={1} />
          <NumberField label="Cooldown" hint="Minimum gap after a completed trade." value={values.cooldownMs} onChange={(value) => onChange("cooldownMs", value)} min={0} step={1000} />
          <NumberField label="Slippage limit (bps)" hint="Execution tolerance if the quote moves." value={values.maxSlippageBps} onChange={(value) => onChange("maxSlippageBps", value)} min={1} max={500} step={1} />
          <NumberField label="Max drawdown %" hint="Emergency pause threshold." value={values.maxDrawdownPct} onChange={(value) => onChange("maxDrawdownPct", value)} min={0} max={100} step="any" />
        </div>
      </ConfigSection>

      <ConfigSection id="advanced" title="Advanced" open={openSection === "advanced"} onToggle={onToggleSection}>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Min order size"
            hint={`Auto target ~${formatCurrency(suggestedMinOrder)} from budget and cycles. You can override it.`}
            value={values.minOrderQuoteAmount}
            onChange={(value) => onChange("minOrderQuoteAmount", value)}
            min={1}
            step={5}
          />
          <NumberField label="Max failures" value={values.maxConsecutiveFailures} onChange={(value) => onChange("maxConsecutiveFailures", value)} min={1} max={20} step={1} />
          <SelectField
            label="Recenter"
            value={values.recenterMode}
            onChange={(value) => onChange("recenterMode", value as RecenterMode)}
            options={RECENTER_MODE_OPTIONS.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
          />
          <Field label="Out of range">
            <select
              value={values.outOfRangePause ? "true" : "false"}
              onChange={(event) => onChange("outOfRangePause", event.currentTarget.value === "true")}
              className={compactFormControlClass}
            >
              <option value="true">pause bot</option>
              <option value="false">keep degraded</option>
            </select>
          </Field>
          {values.recenterMode === "auto_recenter" ? (
            <>
              <NumberField label="Recenter gap" value={values.autoRecenterMinIntervalMs} onChange={(value) => onChange("autoRecenterMinIntervalMs", value)} min={0} step={1000} />
              <NumberField label="Recenter / day" value={values.autoRecenterMaxPerDay} onChange={(value) => onChange("autoRecenterMaxPerDay", value)} min={0} max={24} step={1} />
            </>
          ) : null}
        </div>
      </ConfigSection>
    </div>
  );
}

function ConfigSection({
  id,
  title,
  children,
  open,
  onToggle
}: {
  id: ConfigSectionId;
  title: string;
  children: React.ReactNode;
  open: boolean;
  onToggle: (section: ConfigSectionId) => void;
}) {
  return (
    <section className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)]">
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left"
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{title}</div>
        <ChevronDown className={cn("h-3.5 w-3.5 text-[var(--muted)] transition", open ? "rotate-180" : "")} />
      </button>
      {open ? <div className="border-t border-[var(--line)] px-3 py-3">{children}</div> : null}
    </section>
  );
}

function CompactMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-[13px] font-medium text-white">{value}</div>
      <div className="mt-0.5 text-[10px] text-[var(--muted)]">{hint}</div>
    </div>
  );
}

const compactFormControlClass = formControlClass;

function getGoalSummary(presetId: BotBehaviorPresetId, pairLabel: string) {
  if (presetId === "token_stacker") {
    return `Keep more ${pairLabel.split("/")[0]} after each profitable cycle.`;
  }

  if (presetId === "range_farmer") {
    return "Recycle each profitable lot fully back into USDC.";
  }

  return `Recycle part of each profitable move while keeping some ${pairLabel.split("/")[0]}.`;
}
