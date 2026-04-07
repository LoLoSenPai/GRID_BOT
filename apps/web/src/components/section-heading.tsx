import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function SectionHeading({
  eyebrow,
  title,
  description,
  icon: Icon,
  actions,
  className
}: {
  eyebrow: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4 md:flex-row md:items-start md:justify-between", className)}>
      <div className="flex items-start gap-3">
        {Icon ? (
          <div className="inline-flex h-10 w-10 items-center justify-center border border-[var(--line)] bg-white/[0.03]">
            <Icon className="h-4 w-4 text-[var(--green)]" />
          </div>
        ) : null}
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">{eyebrow}</div>
          <h2 className="mt-2 text-[26px] font-semibold tracking-[-0.02em]">{title}</h2>
          {description ? <div className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">{description}</div> : null}
        </div>
      </div>

      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
