import { NextResponse } from "next/server";

import { createSession, setSessionCookie, validateAdminCredentials } from "@/lib/auth";

export async function POST(request: Request) {
  const formData = await request.formData();
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!validateAdminCredentials(username, password)) {
    return NextResponse.redirect(new URL("/login", request.url), { status: 302 });
  }

  const token = await createSession(username);
  await setSessionCookie(token);
  return NextResponse.redirect(new URL("/dashboard", request.url), { status: 302 });
}
