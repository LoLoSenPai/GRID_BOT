import { useEffect, useState } from "react";
import { type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export const formControlClass =
  "mt-2 w-full border border-[var(--line)] bg-[var(--bg)] px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-[var(--muted)] focus:border-[var(--line-strong)]";

export const actionButtonBase =
  "inline-flex items-center justify-center gap-2 border px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] transition disabled:cursor-wait disabled:opacity-50";

export function SummaryMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-[var(--muted)]">{label}</div>
      <div className="text-3xl font-semibold text-white">{value}</div>
      <div className="text-sm text-[var(--muted)]">{hint}</div>
    </div>
  );
}

export function InlinePill({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: string;
  tone?: "default" | "green" | "amber" | "red";
}) {
  const toneClass =
    tone === "green"
      ? "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]"
      : tone === "amber"
        ? "border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] text-[var(--amber)]"
        : tone === "red"
          ? "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] text-[var(--red)]"
          : "border-[var(--line)] bg-white/[0.04] text-white";

  return (
    <div className={cn("border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em]", toneClass)}>
      {label} {value}
    </div>
  );
}

export function MetricReadout({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: string;
  tone?: "default" | "green" | "amber" | "red";
}) {
  const toneClass =
    tone === "green"
      ? "text-[var(--green)]"
      : tone === "amber"
        ? "text-[var(--amber)]"
        : tone === "red"
          ? "text-[var(--red)]"
          : "text-white";

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--muted)]">{label}</span>
      <span className={cn("font-medium", toneClass)}>{value}</span>
    </div>
  );
}

export function ActionButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  tone
}: {
  label: string;
  icon: LucideIcon;
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
          : "border-[var(--line)] text-[var(--muted)] hover:bg-white/[0.03] hover:text-white";

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cn(actionButtonBase, toneClass)}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{label}</div>
      {children}
      {hint ? <div className="mt-2 text-xs leading-5 text-[var(--muted)]">{hint}</div> : null}
    </label>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} className={formControlClass} />
    </Field>
  );
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
}) {
  const [draftValue, setDraftValue] = useState(() => formatNumericDraft(value));

  useEffect(() => {
    setDraftValue(formatNumericDraft(value));
  }, [value]);

  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        inputMode={step === 1 ? "numeric" : "decimal"}
        value={draftValue}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;

          if (!isPotentialNumber(nextValue)) {
            return;
          }

          setDraftValue(nextValue);

          const parsed = parseNumericDraft(nextValue);
          if (parsed !== null) {
            onChange(parsed);
          }
        }}
        onBlur={() => {
          const parsed = parseNumericDraft(draftValue);

          if (parsed === null) {
            setDraftValue(formatNumericDraft(value));
            return;
          }

          const normalized = clampNumber(parsed, min, max);
          if (normalized !== parsed) {
            onChange(normalized);
          }
          setDraftValue(formatNumericDraft(normalized));
        }}
        className={formControlClass}
        aria-label={label}
      />
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  value,
  onChange,
  options
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}) {
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)} className={formControlClass}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function formatNumericDraft(value: number) {
  return Number.isFinite(value) ? String(value) : "";
}

function parseNumericDraft(value: string) {
  if (!value.trim() || value === "-" || value === "." || value === "-.") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPotentialNumber(value: string) {
  return /^-?\d*(\.\d*)?$/.test(value);
}

function clampNumber(value: number, min?: number, max?: number) {
  let nextValue = value;

  if (typeof min === "number") {
    nextValue = Math.max(min, nextValue);
  }

  if (typeof max === "number") {
    nextValue = Math.min(max, nextValue);
  }

  return nextValue;
}
