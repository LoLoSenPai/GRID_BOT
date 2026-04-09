"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Wallet2 } from "lucide-react";
import { BotMode } from "@grid-bot/core/enums";
import { cn, formatNumber } from "@/lib/utils";

type WalletData = {
    pubkey: string;
    sol: number;
    usdc: number;
    wbtc: number;
    allocatedUsd: number;
    availableUsd: number;
};

export function WalletBalancePanel({ deskMode }: { deskMode: BotMode }) {
    const [data, setData] = useState<WalletData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const fetchBalances = useCallback(async () => {
        try {
            const response = await fetch("/api/wallet");
            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? "Failed to fetch");
                return;
            }
            const payload = (await response.json()) as WalletData;
            setData(payload);
            setError(null);
        } catch {
            setError("Network error");
        }
    }, []);

    useEffect(() => {
        if (deskMode !== BotMode.Live) {
            return;
        }

        const refreshIfVisible = () => {
            if (document.visibilityState !== "visible") {
                return;
            }

            void fetchBalances();
        };

        refreshIfVisible();
        document.addEventListener("visibilitychange", refreshIfVisible);
        const id = window.setInterval(refreshIfVisible, 60_000);

        return () => {
            document.removeEventListener("visibilitychange", refreshIfVisible);
            window.clearInterval(id);
        };
    }, [deskMode, fetchBalances]);

    if (deskMode !== BotMode.Live) {
        return null;
    }

    const handleCopy = () => {
        if (!data) return;
        void navigator.clipboard.writeText(data.pubkey);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    if (error && !data) {
        return (
            <div className="border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">Wallet</div>
                <div className="mt-2 text-[11px] text-[var(--red)]">{error}</div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">Wallet</div>
                <div className="mt-2 h-3 w-20 animate-pulse rounded bg-white/[0.06]" />
                <div className="mt-2 space-y-1.5">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-3 w-full animate-pulse rounded bg-white/[0.04]" />
                    ))}
                </div>
            </div>
        );
    }

    const truncatedPubkey = `${data.pubkey.slice(0, 4)}...${data.pubkey.slice(-4)}`;

    return (
        <div className="border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                    <Wallet2 className="h-3 w-3 text-[var(--muted)]" />
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">Wallet</span>
                </div>
                <button
                    type="button"
                    onClick={handleCopy}
                    className="flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] text-[var(--muted)] transition hover:bg-white/[0.04] hover:text-white"
                    title={data.pubkey}
                >
                    {truncatedPubkey}
                    {copied ? <Check className="h-2.5 w-2.5 text-[var(--green)]" /> : <Copy className="h-2.5 w-2.5" />}
                </button>
            </div>

            <div className="mt-2.5 space-y-1">
                <BalanceRow label="SOL" value={formatNumber(data.sol, 4)} />
                <BalanceRow label="USDC" value={formatNumber(data.usdc, 2)} accent />
                <BalanceRow label="WBTC" value={formatNumber(data.wbtc, 6)} />
            </div>

            <div className="mt-2.5 border-t border-[var(--line)] pt-2 space-y-1">
                <BalanceRow label="Allocated" value={`$${formatNumber(data.allocatedUsd, 2)}`} muted />
                <BalanceRow
                    label="Available"
                    value={`$${formatNumber(data.availableUsd, 2)}`}
                    accent
                />
            </div>
        </div>
    );
}

function BalanceRow({
    label,
    value,
    accent,
    muted
}: {
    label: string;
    value: string;
    accent?: boolean;
    muted?: boolean;
}) {
    return (
        <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</span>
            <span
                className={cn(
                    "font-mono text-[11px]",
                    accent ? "text-white" : muted ? "text-[var(--muted)]" : "text-white/80"
                )}
            >
                {value}
            </span>
        </div>
    );
}
