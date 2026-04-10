import Link from "next/link";
import { BotMode } from "@grid-bot/core/enums";
import { Activity, Bot, Gauge, LogOut } from "lucide-react";

import { cn } from "@/lib/utils";
import { buildDeskHref } from "@/lib/desk-mode";
import { DeskModeToggle } from "@/components/desk-mode-toggle";
import { WalletBalancePanel } from "@/components/wallet-balance-panel";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/bots", label: "Bots", icon: Bot },
  { href: "/activity", label: "Activity", icon: Activity }
];

export function AppShell({
  title,
  subtitle,
  children,
  pathname,
  deskMode,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  pathname: string;
  deskMode: BotMode;
}) {
  return (
    <div className="min-h-screen px-3 py-3 lg:px-4">
      <div className="mx-auto grid max-w-[1680px] grid-cols-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="flex min-h-[calc(100svh-24px)] flex-col border border-[var(--line)] bg-[var(--panel)]/94 backdrop-blur">
          <div className="border-b border-[var(--line)] px-4 py-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Grid bot</div>
            <div className="mt-2 text-lg font-semibold tracking-[-0.03em] text-white">Solo desk</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">Spot</span>
              <span className="border border-[var(--line)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Personal</span>
              <DeskModeToggle initialMode={deskMode} />
            </div>
          </div>
          <nav className="px-3 py-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={buildDeskHref(item.href, deskMode)}
                  className={cn(
                    "mb-1 flex items-center gap-3 border border-transparent px-3 py-3 text-sm text-[var(--muted)] transition hover:border-[var(--line)] hover:bg-white/[0.03] hover:text-white",
                    active && "border-[var(--accent-line)] bg-[var(--accent-soft)] text-white shadow-[inset_2px_0_0_0_var(--accent)]"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto border-t border-[var(--line)] px-4 py-4">
            <WalletBalancePanel deskMode={deskMode} />
            <form action="/api/auth/logout" method="post">
              <button className="flex w-full items-center gap-3 border border-[var(--line)] px-3 py-3 text-sm text-[var(--muted)] transition hover:bg-white/[0.03] hover:text-white">
                <LogOut className="h-4 w-4" />
                Log out
              </button>
            </form>
          </div>
        </aside>

        <main className="border border-[var(--line)] bg-[var(--panel)]/84 backdrop-blur">
          <header className="border-b border-[var(--line)] px-5 py-4 lg:px-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">{title}</div>
                <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-white">{subtitle}</h1>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="border border-[var(--line)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">
                  {pathname.replace("/", "") || "home"}
                </span>
                <span className="border border-[var(--line)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--green)]">
                  online
                </span>
              </div>
            </div>
          </header>
          <div className="px-5 py-5 lg:px-6 lg:py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
