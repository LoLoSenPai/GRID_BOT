export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  HYPE: "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g"
} as const;

export const GECKOTERMINAL_POOLS = {
  SOL_USDC: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
  BTC_USDC: "3sehQcVywWcFJZ1ri3NmJ7MRkrXbViJMRNN5b6kz8Mqn",
  HYPE_USDC: "ANCx141SujgVdbKz9NTEH8F38qWsnyyXsVju64aU3qLB"
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
