import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { cn, formatCurrency, formatNumber } from "@/lib/utils";

export function MetricStrip({
  label,
  value,
  tone = "neutral",
  suffix
}: {
  label: string;
  value: number;
  tone?: "positive" | "negative" | "neutral";
  suffix?: string;
}) {
  return (
    <div className="border-b border-white/8 py-4 last:border-b-0">
      <div className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">{label}</div>
      <div className="mt-2 flex items-center gap-2 text-2xl font-semibold">
        <span>{suffix === "%" ? `${formatNumber(value, 2)}%` : formatCurrency(value)}</span>
        {tone !== "neutral" ? (
          tone === "positive" ? (
            <ArrowUpRight className="h-5 w-5 text-[var(--green)]" />
          ) : (
            <ArrowDownRight className="h-5 w-5 text-[var(--red)]" />
          )
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1 text-sm",
          tone === "positive" && "text-[var(--green)]",
          tone === "negative" && "text-[var(--red)]",
          tone === "neutral" && "text-[var(--muted)]"
        )}
      >
        {suffix === "%" ? `${formatNumber(value, 2)}%` : formatNumber(value, 4)}
      </div>
    </div>
  );
}
