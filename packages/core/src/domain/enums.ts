export enum BotStatus {
  Running = "running",
  Paused = "paused",
  Stopped = "stopped",
  OutOfRange = "out_of_range",
  Cooldown = "cooldown",
  Error = "error"
}

export enum BotMode {
  Paper = "paper",
  Live = "live"
}

export enum StrategyMode {
  AccumulateBase = "accumulate_base",
  AccumulateUsdc = "accumulate_usdc",
  Balanced = "balanced"
}

export enum GridType {
  Arithmetic = "arithmetic",
  Geometric = "geometric"
}

export enum RecenterMode {
  Manual = "manual_recenter",
  Auto = "auto_recenter"
}

export enum MinOrderMode {
  Auto = "auto",
  Manual = "manual"
}

export enum ExecutionProvider {
  Jupiter = "jupiter",
  Paper = "paper",
  Dflow = "dflow"
}

export enum ExecutionStatus {
  Pending = "pending",
  Submitted = "submitted",
  Filled = "filled",
  Failed = "failed",
  Simulated = "simulated"
}

export enum AlertType {
  BotPaused = "bot_paused",
  BotOutOfRange = "bot_out_of_range",
  ExecutionFailed = "execution_failed",
  ConsecutiveFailures = "consecutive_failures",
  RecenterPerformed = "recenter_performed",
  BudgetMaxReached = "budget_max_reached",
  DrawdownThreshold = "drawdown_threshold",
  InfrastructureDegraded = "infrastructure_degraded"
}

export enum TradeSide {
  Buy = "buy",
  Sell = "sell"
}

export enum OrderStatus {
  Created = "created",
  Blocked = "blocked",
  Submitted = "submitted",
  Filled = "filled",
  Failed = "failed",
  Cancelled = "cancelled",
  Simulated = "simulated"
}

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error"
}
