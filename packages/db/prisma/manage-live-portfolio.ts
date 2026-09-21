import { readFileSync } from "node:fs";
import { stageLivePortfolio, recordLivePaperReview, activateLivePortfolio, topUpLiveFeeEnvelope } from "../src/repositories/live-portfolio-repository";
import { prisma } from "../src/client";

// Operator-only CLI. No command is run by the worker, deployment or paper scheduler.
async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === "stage" && first) {
    const input = JSON.parse(readFileSync(first, "utf8"));
    input.observedAt = new Date(input.observedAt);
    console.log(JSON.stringify({ portfolioId: await stageLivePortfolio(input), status: "paused", activationAllowed: false }));
  } else if (command === "review" && first && second) {
    const review = await recordLivePaperReview(first, second);
    console.log(JSON.stringify({ reviewId: review.id }));
  } else if (command === "activate" && first && second) {
    await activateLivePortfolio(first, second);
    console.log(JSON.stringify({ portfolioId: first, status: "activated" }));
  } else if (command === "fees" && first && second && third) {
    await topUpLiveFeeEnvelope(first, Number(second), third);
    console.log(JSON.stringify({ portfolioId: first, feeFundingRecorded: true, activationChanged: false }));
  } else throw new Error("Usage: live:portfolio stage <input.json> | review <paperId> <reviewReference> | activate <portfolioId> <reviewId> | fees <portfolioId> <SOL> <requestId>");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Operation failed"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
