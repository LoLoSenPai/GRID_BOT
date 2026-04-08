import { cn } from "@/lib/utils";

const statusStyles: Record<string, string> = {
  running: "text-[var(--green)] border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)]",
  cooldown: "text-[var(--amber)] border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)]",
  paused: "text-white border-[var(--line)] bg-white/[0.04]",
  stopped: "text-white border-[var(--line)] bg-white/[0.04]",
  out_of_range: "text-[var(--amber)] border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)]",
  error: "text-[var(--red)] border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)]"
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]",
        statusStyles[status] ?? "border-[var(--line)] bg-white/[0.04] text-white"
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
