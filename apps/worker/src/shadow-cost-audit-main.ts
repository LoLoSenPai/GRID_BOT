import { createShadowObservationClient, PrismaShadowCostRepository } from "@grid-bot/db";
async function main() {
  const args = process.argv.slice(2).filter(a => a !== "--");
  const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const portfolioId = value("--portfolio-id"), botId = value("--bot-id"), asOf = new Date(value("--as-of") ?? Date.now());
  if (!portfolioId || !botId || !Number.isFinite(+asOf)) throw new Error("Expected --portfolio-id ID --bot-id ID [--as-of ISO].");
  const handle = createShadowObservationClient();
  try {
    const report = await handle.client.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return new PrismaShadowCostRepository(tx as never).readAuditReport(portfolioId, botId, asOf);
    }, { isolationLevel: "RepeatableRead" });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally { await handle.close(); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Cost audit failed"}\n`); process.exitCode = 1; });
