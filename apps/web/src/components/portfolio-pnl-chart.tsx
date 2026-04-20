"use client";

import { useState } from "react";

import { SurfaceCard } from "@/components/surface-card";
import { formatCurrency, formatDateTime } from "@/lib/utils";

type PortfolioPnlPoint = {
  time: string;
  totalPnlUsd: number;
  totalEquityUsd: number;
  capitalDeployedUsd: number;
  totalBudgetUsd: number;
  botCount: number;
  activeBotCount: number;
};

function buildLinePath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function buildAreaPath(points: Array<{ x: number; y: number }>, height: number, paddingY: number) {
  if (!points.length) {
    return "";
  }

  const baseline = height - paddingY;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) {
    return "";
  }

  return `${buildLinePath(points)} L ${lastPoint.x.toFixed(2)} ${baseline} L ${firstPoint.x.toFixed(2)} ${baseline} Z`;
}

export function PortfolioPnlChart({ points }: { points: PortfolioPnlPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const cleanPoints = points.filter((point) => Number.isFinite(point.totalPnlUsd));
  const latest = cleanPoints[cleanPoints.length - 1] ?? null;
  const width = 920;
  const height = 260;
  const paddingX = 20;
  const paddingY = 28;

  if (!latest || cleanPoints.length < 2) {
    return (
      <SurfaceCard padding="lg">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Global PnL history</div>
        <div className="mt-3 text-sm text-[var(--muted)]">
          Waiting for portfolio snapshots. The worker will write the first long-term point automatically.
        </div>
      </SurfaceCard>
    );
  }

  const firstPoint = cleanPoints[0];
  if (!firstPoint) {
    return null;
  }

  const minPnl = Math.min(...cleanPoints.map((point) => point.totalPnlUsd), 0);
  const maxPnl = Math.max(...cleanPoints.map((point) => point.totalPnlUsd), 0);
  const pnlSpan = Math.max(maxPnl - minPnl, 0.01);
  const chartPoints = cleanPoints.map((point, index) => {
    const x = paddingX + (index / Math.max(cleanPoints.length - 1, 1)) * (width - paddingX * 2);
    const y = height - paddingY - ((point.totalPnlUsd - minPnl) / pnlSpan) * (height - paddingY * 2);
    return { x, y };
  });
  const zeroY = height - paddingY - ((0 - minPnl) / pnlSpan) * (height - paddingY * 2);
  const tone = latest.totalPnlUsd >= 0 ? "text-[var(--green)]" : "text-[var(--red)]";
  const stroke = latest.totalPnlUsd >= 0 ? "var(--green)" : "var(--red)";
  const hoverPoint = hoverIndex === null ? null : chartPoints[hoverIndex] ?? null;
  const hoverData = hoverIndex === null ? null : cleanPoints[hoverIndex] ?? null;
  const tooltipWidth = 210;
  const tooltipHeight = 70;
  const tooltipX = hoverPoint ? Math.min(Math.max(hoverPoint.x + 12, paddingX), width - tooltipWidth - paddingX) : 0;
  const tooltipY = hoverPoint ? Math.max(hoverPoint.y - tooltipHeight - 12, paddingY) : 0;

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const nearestIndex = chartPoints.reduce(
      (nearest, point, index) => (Math.abs(point.x - svgX) < Math.abs(chartPoints[nearest]!.x - svgX) ? index : nearest),
      0,
    );
    setHoverIndex(nearestIndex);
  };

  return (
    <SurfaceCard padding="none" className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Global PnL history</div>
          <div className="mt-2 text-sm text-[var(--muted)]">Combined realized + unrealized PnL across the selected desk mode.</div>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-semibold ${tone}`}>{formatCurrency(latest.totalPnlUsd)}</div>
          <div className="mt-1 text-xs text-[var(--muted)]">
            Equity {formatCurrency(latest.totalEquityUsd)} | Deployed {formatCurrency(latest.capitalDeployedUsd)}
          </div>
        </div>
      </div>

      <div className="px-5 py-5">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[260px] w-full"
          role="img"
          aria-label="Global PnL curve"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="portfolio-pnl-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <line x1={paddingX} x2={width - paddingX} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.18)" strokeDasharray="5 7" />
          <path d={buildAreaPath(chartPoints, height, paddingY)} fill="url(#portfolio-pnl-fill)" />
          <path d={buildLinePath(chartPoints)} fill="none" stroke={stroke} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
          {hoverPoint && hoverData ? (
            <g pointerEvents="none">
              <line x1={hoverPoint.x} x2={hoverPoint.x} y1={paddingY} y2={height - paddingY} stroke="rgba(133,190,255,0.35)" strokeDasharray="4 6" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="5" fill={stroke} stroke="var(--panel)" strokeWidth="2" />
              <g transform={`translate(${tooltipX} ${tooltipY})`}>
                <rect width={tooltipWidth} height={tooltipHeight} rx="0" fill="rgba(5,12,20,0.94)" stroke="rgba(133,190,255,0.25)" />
                <text x="12" y="20" fill="var(--muted)" fontSize="11" fontFamily="monospace" letterSpacing="1.4">
                  {formatDateTime(hoverData.time).toUpperCase()}
                </text>
                <text x="12" y="43" fill={stroke} fontSize="18" fontWeight="700">
                  {formatCurrency(hoverData.totalPnlUsd)}
                </text>
                <text x="12" y="61" fill="var(--muted)" fontSize="11">
                  Equity {formatCurrency(hoverData.totalEquityUsd)}
                </text>
              </g>
            </g>
          ) : null}
        </svg>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
          <span>{formatDateTime(firstPoint.time)}</span>
          <span>
            {latest.activeBotCount}/{latest.botCount} active | Budget {formatCurrency(latest.totalBudgetUsd)}
          </span>
          <span>{formatDateTime(latest.time)}</span>
        </div>
      </div>
    </SurfaceCard>
  );
}
