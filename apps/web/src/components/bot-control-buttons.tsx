"use client";

import { Pause, Play, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cn } from "@/lib/utils";

const actions = [
  { label: "Pause", action: "pause", icon: Pause, tone: "neutral" },
  { label: "Resume", action: "resume", icon: Play, tone: "positive" },
  { label: "Stop", action: "stop", icon: Square, tone: "negative" }
] as const;

const toneStyles: Record<(typeof actions)[number]["tone"], string> = {
  neutral: "border-[var(--line)] text-[var(--muted)] hover:bg-white/[0.03] hover:text-white",
  positive:
    "border-[var(--accent-line)] text-[var(--accent)] hover:bg-[var(--accent-soft)]",
  negative:
    "border-[color:rgba(255,107,122,0.18)] text-[var(--red)] hover:bg-[color:rgba(255,107,122,0.08)]"
};

export function BotControlButtons({ botId }: { botId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: (typeof actions)[number]["action"]) {
    startTransition(async () => {
      setError(null);

      const response = await fetch(`/api/bots/${botId}/${action}`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;

      if (!response.ok) {
        setError(payload?.error ?? "The bot action failed.");
        return;
      }

      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.action}
              onClick={() => run(item.action)}
              disabled={isPending}
              className={cn(
                "inline-flex items-center gap-2 border px-3.5 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.22em] transition disabled:cursor-wait disabled:opacity-60",
                toneStyles[item.tone]
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {error ? <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--red)]">{error}</div> : null}
    </div>
  );
}
