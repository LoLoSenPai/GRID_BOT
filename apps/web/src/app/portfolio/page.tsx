import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PortfolioConsole } from "@/components/portfolio-console";
import { requireSession } from "@/lib/auth";
import { DESK_MODE_COOKIE, parseDeskMode } from "@/lib/desk-mode";

export default async function PortfolioPage({ searchParams }: { searchParams?: Promise<{ deskMode?: string }> }) {
  await requireSession();
  const params = (await searchParams) ?? {};
  const cookieStore = await cookies();
  const deskMode = parseDeskMode(params.deskMode ?? cookieStore.get(DESK_MODE_COOKIE)?.value);
  return <AppShell title="Portfolio" subtitle="Paper allocation" pathname="/portfolio" deskMode={deskMode}><PortfolioConsole /></AppShell>;
}
