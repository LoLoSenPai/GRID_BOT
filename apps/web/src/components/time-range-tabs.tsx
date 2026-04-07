"use client";

import { cn } from "@/lib/utils";

export type TimeRangeOption = {
  label: string;
  value: string;
};

export function TimeRangeTabs({
  options,
  value,
  onChange,
  pending = false
}: {
  options: TimeRangeOption[];
  value: string;
  onChange: (next: string) => void;
  pending?: boolean;
}) {
  return (
    <div className="inline-flex border border-[var(--line)] bg-[var(--panel-soft)]/90 p-1">
      {options.map((option) => {
        const active = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.2em] transition",
              active ? "bg-white/[0.08] text-white" : "text-[var(--muted)] hover:text-white",
              pending && "opacity-75"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
