import { cookies } from "next/headers";
import { getEnv } from "@grid-bot/common";

import { AppShell } from "@/components/app-shell";
import { BacktestLabConsole } from "@/components/backtest-lab-console";
import { requireSession } from "@/lib/auth";
import { serializeBotOverview } from "@/lib/bot-view-data";
import { DESK_MODE_COOKIE, parseDeskMode } from "@/lib/desk-mode";
import { getBotsOverview } from "@/lib/data";

export default async function LabPage({
  searchParams
}: {
  searchParams?: Promise<{ botId?: string; deskMode?: string }>;
}) {
  await requireSession();
  const params = (await searchParams) ?? {};
  const cookieStore = await cookies();
  const deskMode = parseDeskMode(params.deskMode ?? cookieStore.get(DESK_MODE_COOKIE)?.value);
  const labEnabled = process.env.BACKTEST_LAB_ENABLED === "true";
  const liveTradingEnabled = getEnv().LIVE_TRADING_ENABLED;
  const bots = await getBotsOverview(deskMode);
  const viewModel = bots.map(serializeBotOverview);
  const initialSelectedBotId = params.botId && viewModel.some((bot) => bot.id === params.botId) ? params.botId : viewModel[0]?.id ?? null;

  return (
    <AppShell title="Lab" subtitle="Strategy lab" pathname="/lab" deskMode={deskMode}>
      {labEnabled ? (
        <BacktestLabConsole
          deskMode={deskMode}
          liveTradingEnabled={liveTradingEnabled}
          bots={viewModel.map((bot) => ({
            id: bot.id,
            name: bot.name,
            pairLabel: bot.pairLabel,
            config: bot.config
          }))}
          selectedBotId={initialSelectedBotId}
        />
      ) : (
        <div className="border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-5 text-sm text-[var(--muted)]">
          Backtest Lab is disabled on this VPS profile. Set <span className="font-mono text-white">BACKTEST_LAB_ENABLED=true</span> to use it.
        </div>
      )}
    </AppShell>
  );
}
