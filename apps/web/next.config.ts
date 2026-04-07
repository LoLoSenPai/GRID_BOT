import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@grid-bot/common", "@grid-bot/core", "@grid-bot/db"],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"]
};

export default nextConfig;
