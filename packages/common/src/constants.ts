export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E"
} as const;

export const PYTH_FEED_IDS = {
  SOL_USD: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC_USD: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
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
