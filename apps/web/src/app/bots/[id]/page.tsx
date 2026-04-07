import { redirect } from "next/navigation";

import { requireSession } from "@/lib/auth";

export default async function BotDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  redirect(`/bots?botId=${id}`);
}
