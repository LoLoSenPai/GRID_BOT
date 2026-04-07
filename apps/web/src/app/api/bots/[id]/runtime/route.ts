import { NextResponse } from "next/server";

import { readSession } from "@/lib/auth";
import { createSseResponse, getBotRuntimePayload } from "@/server/bot-runtime-payload";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  if (searchParams.get("stream") === "1") {
    return createSseResponse({
      request,
      getPayload: async () => {
        const payload = await getBotRuntimePayload(id);
        if (!payload) {
          throw new Error("Bot not found.");
        }

        return payload;
      },
      intervalMs: 2000
    });
  }

  const payload = await getBotRuntimePayload(id);
  if (!payload) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  return NextResponse.json(
    payload,
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
