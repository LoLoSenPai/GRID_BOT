import { NextResponse } from "next/server";

import { readSession } from "@/lib/auth";
import { parseDeskMode } from "@/lib/desk-mode";
import { getBotDetail } from "@/lib/data";
import { serializeBotBoard } from "@/lib/bot-view-data";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const url = new URL(request.url);
  const modeParam = url.searchParams.get("mode");
  const mode = modeParam === "paper" || modeParam === "live" ? parseDeskMode(modeParam) : undefined;
  const bot = await getBotDetail(id, mode);
  if (!bot) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  return NextResponse.json({ bot: serializeBotBoard(bot) });
}
