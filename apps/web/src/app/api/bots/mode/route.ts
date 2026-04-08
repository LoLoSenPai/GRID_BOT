import { NextResponse } from "next/server";

import { readSession } from "@/lib/auth";

export async function GET() {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    error: "Desk mode is now client-side only. This endpoint is deprecated.",
  }, { status: 410 });
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await request.text().catch(() => "");

  return NextResponse.json(
    { error: "Bot mode switching on existing bots is no longer supported." },
    { status: 410 },
  );
}
