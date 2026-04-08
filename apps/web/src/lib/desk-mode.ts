import { BotMode } from "@grid-bot/core/enums";

export const DESK_MODE_COOKIE = "grid-bot-desk-mode";
export const DESK_MODE_STORAGE_KEY = "grid-bot:desk-mode";

export function parseDeskMode(value?: string | null) {
  return value === BotMode.Live ? BotMode.Live : BotMode.Paper;
}

export function buildDeskHref(pathname: string, deskMode: BotMode) {
  const params = new URLSearchParams();
  params.set("deskMode", deskMode);
  return `${pathname}?${params.toString()}`;
}
