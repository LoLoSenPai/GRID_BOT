"use client";

import { useEffect, useRef, useState } from "react";

import { cn, formatNumber } from "@/lib/utils";

export function SpotPricePulse({
  value,
  className,
  fallback = "--"
}: {
  value: number | null | undefined;
  className?: string;
  fallback?: string;
}) {
  const previousValueRef = useRef<number | null>(null);
  const [tone, setTone] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      previousValueRef.current = null;
      setTone(null);
      return;
    }

    const previousValue = previousValueRef.current;
    previousValueRef.current = value;

    if (previousValue === null || Object.is(previousValue, value)) {
      return;
    }

    setTone(value > previousValue ? "up" : "down");
    const timeoutId = window.setTimeout(() => setTone(null), 650);
    return () => window.clearTimeout(timeoutId);
  }, [value]);

  const style = tone ? { color: tone === "up" ? "var(--green)" : "var(--red)" } : undefined;

  return (
    <span className={cn("transition-colors duration-150", className)} style={style}>
      {typeof value === "number" && Number.isFinite(value) ? formatNumber(value, value >= 1000 ? 0 : 2) : fallback}
    </span>
  );
}
