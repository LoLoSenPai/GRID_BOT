import { cn } from "@/lib/utils";

const paddingStyles = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6"
} as const;

const toneStyles = {
  default: "border-[var(--line)] bg-[linear-gradient(180deg,rgba(255,255,255,0.028),rgba(255,255,255,0.012))]",
  muted: "border-[var(--line)] bg-[var(--panel-soft)]/90",
  elevated: "border-[var(--line-strong)] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018))]"
} as const;

export function SurfaceCard({
  children,
  className,
  padding = "md",
  tone = "default"
}: {
  children: React.ReactNode;
  className?: string;
  padding?: keyof typeof paddingStyles;
  tone?: keyof typeof toneStyles;
}) {
  return <div className={cn("border backdrop-blur", toneStyles[tone], paddingStyles[padding], className)}>{children}</div>;
}
