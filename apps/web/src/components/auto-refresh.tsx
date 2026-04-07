"use client";

import { useEffect, useEffectEvent } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ intervalMs = 5000, enabled = true }: { intervalMs?: number; enabled?: boolean }) {
  const router = useRouter();
  const refreshRoute = useEffectEvent(() => {
    if (document.visibilityState !== "visible") {
      return;
    }

    router.refresh();
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const id = window.setInterval(() => {
      refreshRoute();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, refreshRoute]);

  return null;
}
