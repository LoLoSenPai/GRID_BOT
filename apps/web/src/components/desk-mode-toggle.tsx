"use client";

import { useEffect, useMemo } from "react";
import { BotMode } from "@grid-bot/core/enums";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  DESK_MODE_COOKIE,
  DESK_MODE_STORAGE_KEY,
  parseDeskMode,
} from "@/lib/desk-mode";
import { cn } from "@/lib/utils";

export function DeskModeToggle({ initialMode }: { initialMode: BotMode }) {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const mode = parseDeskMode(searchParams.get("deskMode") ?? initialMode);
    const isPaper = mode === BotMode.Paper;

    const hrefForMode = useMemo(() => {
        return (nextMode: BotMode) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("deskMode", nextMode);
            if (pathname === "/bots" && !params.get("botId")) {
                params.delete("botId");
            }

            const query = params.toString();
            return query ? `${pathname}?${query}` : pathname;
        };
    }, [pathname, searchParams]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        window.localStorage.setItem(DESK_MODE_STORAGE_KEY, mode);
        document.cookie = `${DESK_MODE_COOKIE}=${mode}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    }, [mode]);

    useEffect(() => {
        if (typeof window === "undefined" || searchParams.get("deskMode")) {
            return;
        }

        const storedMode = parseDeskMode(
            window.localStorage.getItem(DESK_MODE_STORAGE_KEY) ?? initialMode,
        );

        if (storedMode === mode) {
            return;
        }

        router.replace(hrefForMode(storedMode), { scroll: false });
    }, [hrefForMode, initialMode, mode, router, searchParams]);

    const handleToggle = (nextMode: BotMode) => {
        if (nextMode === mode) return;
        router.replace(hrefForMode(nextMode), { scroll: false });
    };

    return (
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--line)]">
            <button
                type="button"
                disabled={isPaper}
                onClick={() => handleToggle(BotMode.Paper)}
                className={cn(
                    "h-7 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] transition",
                    isPaper
                        ? "bg-[color:rgba(248,200,108,0.12)] text-[var(--amber)]"
                        : "text-[var(--muted)] hover:bg-white/[0.04]",
                )}
            >
                Paper
            </button>
            <button
                type="button"
                disabled={!isPaper}
                onClick={() => handleToggle(BotMode.Live)}
                className={cn(
                    "h-7 border-l border-[var(--line)] px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] transition",
                    !isPaper
                        ? "bg-[color:rgba(68,211,156,0.12)] text-[var(--green)]"
                        : "text-[var(--muted)] hover:bg-white/[0.04]",
                )}
            >
                Live
            </button>
        </div>
    );
}
