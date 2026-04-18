import type { StrategyDescriptor, StrategyFamily } from "../domain/types";

const STRATEGY_REGISTRY: StrategyDescriptor[] = [
  {
    family: "range_grid",
    label: "Range grid",
    readiness: "live_ready",
    liveEnabled: true,
    intendedRegimes: ["RANGE"],
    summary: "Current executable grid strategy for range-bound markets.",
    operatorUse: "Use when regime is RANGE and validation stays in range with controlled occupancy.",
    limitations: [
      "Fragile during directional breakouts.",
      "Recenter/adaptive behavior must remain explicit until paper tests are convincing."
    ]
  },
  {
    family: "trend_following",
    label: "Trend following",
    readiness: "planned",
    liveEnabled: false,
    intendedRegimes: ["TREND_UP", "TREND_DOWN"],
    summary: "Future directional strategy family; not executable in live trading yet.",
    operatorUse: "Use as a warning that dense range farming may be the wrong tool.",
    limitations: [
      "No live execution model exists yet.",
      "No trend backtest runner exists yet."
    ]
  },
  {
    family: "capital_defense",
    label: "Capital defense",
    readiness: "advisory_only",
    liveEnabled: false,
    intendedRegimes: ["CHAOTIC_HIGH_VOL", "TREND_DOWN"],
    summary: "Defensive posture that favors pausing new exposure and allowing recovery exits.",
    operatorUse: "Use when high volatility, high occupancy, or poor validation makes new buys fragile.",
    limitations: [
      "This is a posture, not a separate execution engine.",
      "It does not auto-liquidate or mutate a live bot."
    ]
  }
];

export class StrategyRegistryService {
  list(): StrategyDescriptor[] {
    return STRATEGY_REGISTRY.map((descriptor) => ({ ...descriptor, intendedRegimes: [...descriptor.intendedRegimes], limitations: [...descriptor.limitations] }));
  }

  get(family: StrategyFamily): StrategyDescriptor {
    const descriptor = STRATEGY_REGISTRY.find((candidate) => candidate.family === family);
    if (!descriptor) {
      throw new Error(`Unknown strategy family: ${family}`);
    }

    return { ...descriptor, intendedRegimes: [...descriptor.intendedRegimes], limitations: [...descriptor.limitations] };
  }
}
