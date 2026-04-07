export function MiniSparkline({
  values,
  width = 170,
  height = 54,
  stroke = "#7ff5c4",
  fill = "rgba(127,245,196,0.10)"
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
}) {
  if (!values.length) {
    return <div className="h-[54px] w-full border border-dashed border-[var(--line)] bg-[var(--panel-soft)]" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  const points = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width / 2;
    const normalized = (value - min) / range;
    const y = height - normalized * (height - 8) - 4;
    return { x, y };
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${points.at(-1)?.x ?? width} ${height} L ${points[0]?.x ?? 0} ${height} Z`;
  const lastPoint = points.at(-1) ?? { x: width / 2, y: height / 2 };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[54px] w-full overflow-visible">
      <defs>
        <linearGradient id={`spark-${stroke.replace(/[^a-zA-Z0-9]/g, "")}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={fill} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastPoint.x} cy={lastPoint.y} r="3.5" fill={stroke} />
      <circle cx={lastPoint.x} cy={lastPoint.y} r="8" fill={stroke} opacity="0.12" />
    </svg>
  );
}
