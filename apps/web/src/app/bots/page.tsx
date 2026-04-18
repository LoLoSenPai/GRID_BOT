import { cookies } from "next/headers";
import { getEnv } from "@grid-bot/common";

import { AppShell } from "@/components/app-shell";
import { BotManagementConsole } from "@/components/bot-management-console";
import type { BotDetailViewData } from "@/components/bot-detail-view";
import { requireSession } from "@/lib/auth";
import { DESK_MODE_COOKIE, parseDeskMode } from "@/lib/desk-mode";
import { getBotDetail, getBotsOverview } from "@/lib/data";
import { buildMarketPreviewBoard, serializeBotBoard, serializeBotOverview, type PreviewSymbol } from "@/lib/bot-view-data";

const PREVIEW_SYMBOLS = ["SOL", "BTC"] as const;

export default async function BotsPage({
  searchParams
}: {
  searchParams?: Promise<{ botId?: string; deskMode?: string }>;
}) {
  await requireSession();
  const params = (await searchParams) ?? {};
  const cookieStore = await cookies();
  const deskMode = parseDeskMode(params.deskMode ?? cookieStore.get(DESK_MODE_COOKIE)?.value);
  const bots = await getBotsOverview(deskMode);
  const liveTradingEnabled = getEnv().LIVE_TRADING_ENABLED;
  const viewModel = bots.map(serializeBotOverview);
  const initialSelectedBotId = params.botId && viewModel.some((bot) => bot.id === params.botId) ? params.botId : viewModel[0]?.id ?? null;
  const selectedBotDetail = initialSelectedBotId ? await getBotDetail(initialSelectedBotId, deskMode) : null;
  const botBoards: Partial<Record<string, BotDetailViewData>> = selectedBotDetail ? { [selectedBotDetail.id]: serializeBotBoard(selectedBotDetail) } : {};
  const marketPreviewBoards = Object.fromEntries(
    PREVIEW_SYMBOLS.map((symbol) => [
      symbol,
      buildMarketPreviewBoard(symbol, null, deskMode)
    ])
  ) as Partial<Record<PreviewSymbol, BotDetailViewData>>;

  return (
    <AppShell title="Bots" subtitle="Grid terminal" pathname="/bots" deskMode={deskMode}>
      <BotManagementConsole
        bots={viewModel}
        deskMode={deskMode}
        liveTradingEnabled={liveTradingEnabled}
        initialSelectedBotId={initialSelectedBotId}
        botBoards={botBoards}
        marketPreviewBoards={marketPreviewBoards}
      />
    </AppShell>
  );
}
