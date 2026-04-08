import { describe, expect, it } from "vitest";
import { BotMode } from "@grid-bot/core/enums";

import { buildDeskHref, parseDeskMode } from "./desk-mode";

describe("parseDeskMode", () => {
  it("defaults to paper unless live is explicit", () => {
    expect(parseDeskMode(undefined)).toBe(BotMode.Paper);
    expect(parseDeskMode(null)).toBe(BotMode.Paper);
    expect(parseDeskMode("paper")).toBe(BotMode.Paper);
    expect(parseDeskMode("live")).toBe(BotMode.Live);
  });
});

describe("buildDeskHref", () => {
  it("builds a desk-mode aware href", () => {
    expect(buildDeskHref("/bots", BotMode.Live)).toBe("/bots?deskMode=live");
    expect(buildDeskHref("/activity", BotMode.Paper)).toBe(
      "/activity?deskMode=paper",
    );
  });
});
