import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";

import { clearSessionCookie } from "@/lib/auth";

export async function POST(request: Request) {
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", getEnv().APP_URL), { status: 302 });
}
