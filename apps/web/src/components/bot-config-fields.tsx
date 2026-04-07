import { ChevronDown } from "lucide-react";
import { BotMode, type GridType, type RecenterMode, type StrategyMode } from "@grid-bot/core/enums";

import {
  BOT_BEHAVIOR_PRESETS,
  BOT_BEHAVIOR_PRESET_IDS,
  BOT_PAIR_PRESETS,
  BOT_PAIR_PRESET_IDS,
  BOT_MODE_OPTIONS,
  GRID_TYPE_OPTIONS,
  RECENTER_MODE_OPTIONS,
  STRATEGY_MODE_OPTIONS,
  inferBehaviorPresetId,
  type BotFormDraft,
  type BotBehaviorPresetId,
  type BotPairPresetId
} from "@/lib/bot-management";
import { Field, NumberField, SelectField, TextField, formControlClass } from "@/components/bot-console-primitives";
import { cn, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

export function BotConfigFields({
  values,
  liveTradingEnabled,
  onChange,
  onApplyBehaviorPreset,
  mode,
  pairLabel
}: {
  values: BotFormDraft;
  liveTradingEnabled: boolean;
  onChange: <K extends keyof BotFormDraft>(key: K, value: BotFormDraft[K]) => void;
  onApplyBehaviorPreset: (presetId: BotBehaviorPresetId) => void;
  mode: "create" | "edit";
  pairLabel: string;
}) {
  const activeBehaviorPreset = inferBehaviorPresetId(values);
  const activePreset = BOT_BEHAVIOR_PRESETS[activeBehaviorPreset];
  const railSpan = values.levelCount > 1 ? (values.highPrice - values.lowPrice) / (values.levelCount - 1) : 0;
  const midPrice = values.lowPrice > 0 && values.highPrice > 0 ? (values.lowPrice + values.highPrice) / 2 : 0;
  const geometricStepPct =
    values.gridType === "geometric" && values.lowPrice > 0 && values.highPrice > values.lowPrice && values.levelCount > 1
      ? (Math.pow(values.highPrice / values.lowPrice, 1 / (values.levelCount - 1)) - 1) * 100
      : null;
  const railGainPct = values.gridType === "geometric" ? geometricStepPct ?? 0 : midPrice > 0 ? (railSpan / midPrice) * 100 : 0;
  const budgetPerRail = values.levelCount > 0 ? values.maxDeployableUsd / values.levelCount : 0;

  return (
    <div className="space-y-3">
      <ConfigSection title="Core" defaultOpen>
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
              <div className="mt-2 border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-sm text-white">{pairLabel}</div>
            </Field>
          )}

          <TextField label="Name" value={values.name} onChange={(value) => onChange("name", value)} />

          <Field label="Mode" hint={!liveTradingEnabled ? "Live locked" : undefined}>
            <select value={values.mode} onChange={(event) => onChange("mode", event.currentTarget.value as BotMode)} className={compactFormControlClass}>
              {BOT_MODE_OPTIONS.map((value) => (
                <option key={value} value={value} disabled={value === BotMode.Live && !liveTradingEnabled}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">Preset</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {BOT_BEHAVIOR_PRESET_IDS.map((presetId) => {
              const preset = BOT_BEHAVIOR_PRESETS[presetId];
              const active = activeBehaviorPreset === presetId;

              return (
                <button
                  key={presetId}
                  type="button"
                  onClick={() => onApplyBehaviorPreset(presetId)}
                  className={cn(
                    "border px-3 py-2.5 text-left transition",
                    active
                      ? "border-[color:rgba(68,211,156,0.2)] bg-[color:rgba(68,211,156,0.08)]"
                      : "border-[var(--line)] bg-[var(--bg)] hover:bg-white/[0.04]"
                  )}
                >
                  <div className={cn("text-sm font-medium", active ? "text-white" : "text-white/88")}>{preset.label}</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{preset.tags[0]}</div>
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--muted)]">
            <CompactTag label={activePreset.cycleRule} />
            <CompactTag label={activePreset.exitRule} />
          </div>
        </div>
      </ConfigSection>

      <ConfigSection title="Grid" defaultOpen>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Low" value={values.lowPrice} onChange={(value) => onChange("lowPrice", value)} min={0.000001} step="any" />
          <NumberField label="High" value={values.highPrice} onChange={(value) => onChange("highPrice", value)} min={0.000001} step="any" />
          <NumberField label="Levels" value={values.levelCount} onChange={(value) => onChange("levelCount", value)} min={2} max={120} step={1} />
          <SelectField
            label="Type"
            value={values.gridType}
            onChange={(value) => onChange("gridType", value as GridType)}
            options={GRID_TYPE_OPTIONS.map((value) => ({ value, label: value }))}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <CompactMetric label="Step" value={formatNumber(railSpan, values.highPrice >= 1000 ? 0 : 2)} hint={values.gridType} />
          <CompactMetric label="Gain / rail" value={formatPercent(railGainPct, 2)} hint="Approx" />
          <CompactMetric label="Goal" value={values.strategyMode.replaceAll("_", " ")} hint={activePreset.label} />
        </div>
      </ConfigSection>

      <ConfigSection title="Capital" defaultOpen>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Budget" value={values.totalBudgetUsd} onChange={(value) => onChange("totalBudgetUsd", value)} min={1} step={10} />
          <NumberField label="Deployable" value={values.maxDeployableUsd} onChange={(value) => onChange("maxDeployableUsd", value)} min={1} step={10} />
          <NumberField label="Reserve" value={values.reserveQuoteAmount} onChange={(value) => onChange("reserveQuoteAmount", value)} min={0} step={10} />
          <NumberField label="Min order" value={values.minOrderQuoteAmount} onChange={(value) => onChange("minOrderQuoteAmount", value)} min={1} step={5} />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <CompactMetric label="Per rail" value={formatCurrency(budgetPerRail)} hint="Deployable only" />
          <CompactMetric label="Range width" value={formatPercent(midPrice > 0 ? ((values.highPrice - values.lowPrice) / midPrice) * 100 : 0, 1)} hint="Low to high" />
          <CompactMetric label="Provider" value={values.mode === BotMode.Paper ? "paper" : "jupiter"} hint="Execution" />
        </div>
      </ConfigSection>

      <ConfigSection title="Execution">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Goal"
            value={values.strategyMode}
            onChange={(value) => onChange("strategyMode", value as StrategyMode)}
            options={STRATEGY_MODE_OPTIONS.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
          />
          <NumberField label="Cooldown" value={values.cooldownMs} onChange={(value) => onChange("cooldownMs", value)} min={0} step={1000} />
          <NumberField label="Orders / h" value={values.maxOrdersPerHour} onChange={(value) => onChange("maxOrdersPerHour", value)} min={1} max={500} step={1} />
          <NumberField label="Confirm" value={values.priceConfirmationWindowMs} onChange={(value) => onChange("priceConfirmationWindowMs", value)} min={0} step={1000} />
          <NumberField label="Slippage" value={values.maxSlippageBps} onChange={(value) => onChange("maxSlippageBps", value)} min={1} max={500} step={1} />
          <NumberField label="Drawdown %" value={values.maxDrawdownPct} onChange={(value) => onChange("maxDrawdownPct", value)} min={0} max={100} step="any" />
          <NumberField label="Level lock" value={values.levelLockMs} onChange={(value) => onChange("levelLockMs", value)} min={0} step={1000} />
          <SelectField
            label="Recenter"
            value={values.recenterMode}
            onChange={(value) => onChange("recenterMode", value as RecenterMode)}
            options={RECENTER_MODE_OPTIONS.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Advanced">
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Max failures" value={values.maxConsecutiveFailures} onChange={(value) => onChange("maxConsecutiveFailures", value)} min={1} max={20} step={1} />
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
  title,
  children,
  defaultOpen = false
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group border border-[var(--line)] bg-[var(--panel-soft)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-3 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">{title}</div>
        <ChevronDown className="h-4 w-4 text-[var(--muted)] transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-[var(--line)] px-3 py-3">{children}</div>
    </details>
  );
}

function CompactTag({ label }: { label: string }) {
  return <span className="border border-[var(--line)] px-2 py-1">{label}</span>;
}

function CompactMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border border-[var(--line)] bg-[var(--bg)] px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
      <div className="mt-1.5 text-sm font-medium text-white">{value}</div>
      <div className="mt-1 text-[11px] text-[var(--muted)]">{hint}</div>
    </div>
  );
}

const compactFormControlClass = cn(formControlClass, "px-3 py-2");
