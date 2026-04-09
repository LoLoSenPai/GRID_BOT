import { NextResponse } from "next/server";
import { BotMode } from "@grid-bot/core/enums";

import { readSession } from "@/lib/auth";
import { createSseResponse, getBotRuntimeListPayload } from "@/server/bot-runtime-payload";

export async function GET(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const modeParam = searchParams.get("mode");
  const mode = modeParam === BotMode.Paper || modeParam === BotMode.Live ? modeParam : undefined;
  if (searchParams.get("stream") === "1") {
    return createSseResponse({
      request,
      getPayload: () => getBotRuntimeListPayload(mode),
      intervalMs: 5000
    });
  }

  return NextResponse.json(
    await getBotRuntimeListPayload(mode),
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
