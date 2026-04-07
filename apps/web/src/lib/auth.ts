import { createSecretKey, timingSafeEqual } from "node:crypto";

import { getEnv } from "@grid-bot/common";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const COOKIE_NAME = "gridbot_session";

export interface AdminSession {
  username: string;
}

function getSecret() {
  return createSecretKey(Buffer.from(getEnv().SESSION_SECRET, "utf8"));
}

export async function createSession(username: string) {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function readSession(): Promise<AdminSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  try {
    const payload = await jwtVerify(token, getSecret());
    return {
      username: String(payload.payload.username)
    };
  } catch {
    return null;
  }
}

export async function requireSession() {
  const session = await readSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0)
  });
}

export function validateAdminCredentials(username: string, password: string) {
  const env = getEnv();
  const left = Buffer.from(username, "utf8");
  const right = Buffer.from(env.ADMIN_USERNAME, "utf8");
  const passLeft = Buffer.from(password, "utf8");
  const passRight = Buffer.from(env.ADMIN_PASSWORD, "utf8");

  return (
    left.length === right.length &&
    passLeft.length === passRight.length &&
    timingSafeEqual(left, right) &&
    timingSafeEqual(passLeft, passRight)
  );
}
