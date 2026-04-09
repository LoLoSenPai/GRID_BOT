"use client";

import { useTransition } from "react";
import { RefreshCcw } from "lucide-react";
import { useRouter } from "next/navigation";

import { cn, formatDateTime } from "@/lib/utils";

export function ManualRefresh({
  lastUpdatedAt,
  className
}: {
  lastUpdatedAt: string;
  className?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3", className)}>
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Manual refresh</div>
        <div className="mt-1 text-sm text-[var(--muted)]">Last updated {formatDateTime(lastUpdatedAt)}</div>
      </div>

      <button
        type="button"
        onClick={() => {
          startTransition(() => {
            router.refresh();
          });
        }}
        disabled={isPending}
        className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white transition hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-50"
      >
        <RefreshCcw className={cn("h-3.5 w-3.5", isPending && "animate-spin")} />
        Refresh
      </button>
    </div>
  );
}
