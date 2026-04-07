import { NextResponse } from "next/server";

import { readSession } from "@/lib/auth";
import { type HistoryResolution } from "@/lib/charting";
import { fetchMarketHistory } from "@/lib/market-history";

const validSymbols = new Set(["SOL", "BTC"]);
const validResolutions = new Set<HistoryResolution>(["5m", "30m", "1h", "4h", "1d", "1w", "1mo"]);

export async function GET(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const resolution = (url.searchParams.get("resolution") ?? "4h") as HistoryResolution;

  if (!validSymbols.has(symbol)) {
    return NextResponse.json({ error: "Unsupported symbol" }, { status: 400 });
  }

  if (!validResolutions.has(resolution)) {
    return NextResponse.json({ error: "Unsupported resolution" }, { status: 400 });
  }

  try {
    const history = await fetchMarketHistory(symbol as "SOL" | "BTC", resolution);
    return NextResponse.json(history);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown history error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
