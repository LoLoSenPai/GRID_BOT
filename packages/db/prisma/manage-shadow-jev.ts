import { PrismaPortfolioRepository } from "../src/repositories/portfolio-repository";
import { prisma } from "../src/client";

async function main() {
  const [command, portfolioId] = process.argv.slice(2);
  if (!portfolioId || (command !== "enable" && command !== "disable")) {
    throw new Error("Usage: shadow:portfolio enable|disable <portfolioId>");
  }

  const portfolio = await new PrismaPortfolioRepository(prisma).setShadowJevEnabled(
    portfolioId,
    command === "enable",
  );
  console.log(JSON.stringify({ portfolioId: portfolio.id, shadowJevEnabled: portfolio.shadowJevEnabled }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Operation failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
