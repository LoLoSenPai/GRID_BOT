"use client";

import { cn, formatCurrency } from "@/lib/utils";

type EquityPoint = {
  time: string | Date;
  equityUsd: number;
};

export function BacktestEquityChart({
  points,
  splitAt,
  className
}: {
  points: EquityPoint[];
  splitAt?: string | Date | null;
  className?: string;
}) {
  const width = 920;
  const height = 220;
  const paddingX = 18;
  const paddingY = 18;

  if (!points.length) {
    return (
      <div className={cn("flex h-[220px] items-center justify-center border border-[var(--line)] bg-[var(--panel-soft)]/70 text-sm text-[var(--muted)]", className)}>
        Run a recommendation to draw the equity curve.
      </div>
    );
  }

  const normalized = points.map((point) => ({
    timeMs: new Date(point.time).getTime(),
    equityUsd: point.equityUsd
  }));
  const minTime = normalized[0]?.timeMs ?? 0;
  const maxTime = normalized.at(-1)?.timeMs ?? minTime + 1;
  const minEquity = Math.min(...normalized.map((point) => point.equityUsd));
  const maxEquity = Math.max(...normalized.map((point) => point.equityUsd));
  const equitySpan = Math.max(maxEquity - minEquity, 0.01);
  const timeSpan = Math.max(maxTime - minTime, 1);

  const coordinates = normalized.map((point) => {
    const x = paddingX + ((point.timeMs - minTime) / timeSpan) * (width - paddingX * 2);
    const y = height - paddingY - ((point.equityUsd - minEquity) / equitySpan) * (height - paddingY * 2);
    return { ...point, x, y };
  });

  const path = coordinates.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${path} L ${coordinates.at(-1)?.x.toFixed(2) ?? width} ${(height - paddingY).toFixed(2)} L ${coordinates[0]?.x.toFixed(2) ?? paddingX} ${(height - paddingY).toFixed(2)} Z`;

  const splitTimeMs = splitAt ? new Date(splitAt).getTime() : null;
  const splitX =
    splitTimeMs && Number.isFinite(splitTimeMs)
      ? paddingX + ((Math.max(minTime, Math.min(maxTime, splitTimeMs)) - minTime) / timeSpan) * (width - paddingX * 2)
      : null;

  return (
    <div className={cn("border border-[var(--line)] bg-[var(--panel-soft)]/70 p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Equity curve</div>
          <div className="mt-1 text-sm text-white">Net quote-equity over the selected replay window.</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Range</div>
          <div className="mt-1 text-sm text-white">
            {formatCurrency(minEquity)} → {formatCurrency(maxEquity)}
          </div>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="h-[220px] w-full">
        <defs>
          <linearGradient id="lab-equity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(121,184,255,0.24)" />
            <stop offset="100%" stopColor="rgba(121,184,255,0.02)" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width={width} height={height} fill="transparent" />
        {[0, 0.5, 1].map((tick) => {
          const y = paddingY + tick * (height - paddingY * 2);
          return <line key={tick} x1={paddingX} y1={y} x2={width - paddingX} y2={y} stroke="rgba(255,255,255,0.05)" strokeDasharray="3 5" />;
        })}

        {splitX !== null ? (
          <line x1={splitX} y1={paddingY} x2={splitX} y2={height - paddingY} stroke="rgba(248,200,108,0.35)" strokeDasharray="6 6" />
        ) : null}

        <path d={areaPath} fill="url(#lab-equity-fill)" />
        <path d={path} fill="none" stroke="rgba(121,184,255,0.95)" strokeWidth="2.5" />
      </svg>

      <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--muted)]">
        <span>Train</span>
        <span>Validation</span>
      </div>
    </div>
  );
}
