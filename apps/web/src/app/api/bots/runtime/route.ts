import { NextResponse } from "next/server";

import { readSession } from "@/lib/auth";
import { createSseResponse, getBotRuntimeListPayload } from "@/server/bot-runtime-payload";

export async function GET(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  if (searchParams.get("stream") === "1") {
    return createSseResponse({
      request,
      getPayload: getBotRuntimeListPayload,
      intervalMs: 2000
    });
  }

  return NextResponse.json(
    await getBotRuntimeListPayload(),
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
