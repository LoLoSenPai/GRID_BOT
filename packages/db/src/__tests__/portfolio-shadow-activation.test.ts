import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { PrismaPortfolioRepository } from "../repositories/portfolio-repository";

describe("portfolio shadow activation", () => {
  it("updates only the requested portfolio and maps the persisted flag", async () => {
    const updatedAt = new Date("2026-09-23T12:00:00.000Z");
    const update = vi.fn().mockResolvedValue({
      id: "portfolio-sol-live",
      mode: "live",
      walletIdentity: "wallet",
      quoteMint: "USDC",
      freeQuoteAmount: 42,
      version: 8,
      autoLive: true,
      shadowJevEnabled: true,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt,
    });
    const client = { portfolio: { update } } as unknown as PrismaClient;

    const portfolio = await new PrismaPortfolioRepository(client).setShadowJevEnabled(
      "portfolio-sol-live",
      true,
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "portfolio-sol-live" },
      data: { shadowJevEnabled: true },
    });
    expect(portfolio).toMatchObject({
      id: "portfolio-sol-live",
      mode: "live",
      shadowJevEnabled: true,
      version: 8,
      updatedAt,
    });
  });

  it("rejects an empty portfolio identifier before querying", async () => {
    const update = vi.fn();
    const client = { portfolio: { update } } as unknown as PrismaClient;

    await expect(new PrismaPortfolioRepository(client).setShadowJevEnabled(" ", true))
      .rejects.toThrow("portfolioId is required");
    expect(update).not.toHaveBeenCalled();
  });
});
