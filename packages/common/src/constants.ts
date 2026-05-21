export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  HYPE: "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g"
} as const;

export const PYTH_FEED_IDS = {
  SOL_USD: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC_USD: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  HYPE_USD: "4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b"
} as const;

export const DEFAULTS = {
  levelLockMs: 60_000,
  cooldownMs: 300_000,
  priceConfirmationWindowMs: 10_000,
  maxOrdersPerHour: 12,
  maxConsecutiveFailures: 3,
  autoRecenterMinIntervalMs: 21_600_000,
  autoRecenterMaxPerDay: 2
} as const;
