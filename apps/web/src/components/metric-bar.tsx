import { cn } from "@/lib/utils";

const toneStyles = {
  green: "bg-[linear-gradient(90deg,#44d39c,#7ff5c4)]",
  amber: "bg-[linear-gradient(90deg,#f0af45,#f8c86c)]",
  red: "bg-[linear-gradient(90deg,#ff6b7a,#ff9ba5)]",
  blue: "bg-[linear-gradient(90deg,#6fa8ff,#8bd4ff)]"
} as const;

export function MetricBar({
  label,
  value,
  caption,
  tone = "green"
}: {
  label: string;
  value: number;
  caption: string;
  tone?: keyof typeof toneStyles;
}) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
        <span>{label}</span>
        <span>{caption}</span>
      </div>
      <div className="h-2 bg-white/8">
        <div className={cn("h-2", toneStyles[tone])} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
