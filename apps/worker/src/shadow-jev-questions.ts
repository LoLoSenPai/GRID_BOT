import type { PortfolioPolicyInput } from "@grid-bot/core";

export const questionSetVersion = "shadow-jev-v1" as const;
export const modelRequested = "jev-1.13.0" as const;

export const marketRegimes = [
  "range",
  "drift_up",
  "drift_down",
  "unstable_transition",
  "insufficient_evidence",
] as const;

export type ShadowJevMarketRegime = (typeof marketRegimes)[number];

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

type ShadowJevPolicyCandle = Omit<PortfolioPolicyInput["candles"][number], "openedAt" | "closedAt"> & {
  openedAt: Date | string;
  closedAt: Date | string;
};

type ShadowJevPolicyBand = Omit<PortfolioPolicyInput["band"], "lastRevisionAt"> & {
  lastRevisionAt?: Date | string | null;
};

type ShadowJevPolicyIndicators = Omit<NonNullable<PortfolioPolicyInput["indicators"]>, "observedAt"> & {
  observedAt?: Date | string;
};

export type ShadowJevPolicyInput = Omit<PortfolioPolicyInput, "now" | "band" | "candles" | "indicators"> & {
  now: Date | string;
  band: ShadowJevPolicyBand;
  candles: ShadowJevPolicyCandle[];
  indicators?: ShadowJevPolicyIndicators;
};

export interface ShadowJevInput {
  observedAt: Date | string;
  policyInput: ShadowJevPolicyInput;
  strategy?: {
    objective?: string | null;
  };
}

export interface ShadowJevState {
  observed_at: string;
  asset_symbol: string;
  strategy_objective?: string;
  current_price: number;
  band: {
    low_price: number;
    high_price: number;
    level_count: number;
    spacing: number;
    status: "active" | "parked";
    last_revision_at?: string;
  };
  candle_interval_ms: number;
  recent_closed_candles: Array<{
    opened_at: string;
    closed_at: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }>;
  indicators?: {
    observed_at?: string;
    atr_pct?: number;
    realized_vol_pct?: number;
    amplitude_pct?: number;
    fill_frequency_per_day?: number;
  };
}

export interface ShadowJevChoiceQuestion {
  type: "choice";
  instructions: JsonValue;
  criteria: Record<ShadowJevMarketRegime, JsonValue>;
}

export interface ShadowJevNoulQuestion {
  type: "noul";
  instructions: JsonValue;
  criteria: {
    true: JsonValue;
    false: JsonValue;
  };
}

export interface ShadowJevQuestions {
  market_regime: ShadowJevChoiceQuestion;
  current_band_suitable: ShadowJevNoulQuestion;
  temporary_outside_excursion?: ShadowJevNoulQuestion;
}

export interface ShadowJevRequest {
  model: typeof modelRequested;
  state: ShadowJevState;
  questions: ShadowJevQuestions;
}

const MAX_RECENT_CANDLES = 24;

export function buildJevRequest(input: ShadowJevInput): ShadowJevRequest {
  const observedAt = toIsoDate(input.observedAt, "observedAt");
  const observedAtMs = Date.parse(observedAt);
  const policy = input.policyInput;
  const band = policy.band;

  const state: ShadowJevState = {
    observed_at: observedAt,
    asset_symbol: requireText(policy.assetSymbol, "policyInput.assetSymbol"),
    current_price: requireFinite(policy.price, "policyInput.price"),
    band: {
      low_price: requireFinite(band.lowPrice, "policyInput.band.lowPrice"),
      high_price: requireFinite(band.highPrice, "policyInput.band.highPrice"),
      level_count: requireFinite(band.levelCount, "policyInput.band.levelCount"),
      spacing: requireFinite(band.spacing, "policyInput.band.spacing"),
      status: band.status,
      ...(band.lastRevisionAt
        ? { last_revision_at: toIsoDate(band.lastRevisionAt, "policyInput.band.lastRevisionAt") }
        : {}),
    },
    candle_interval_ms: requireFinite(policy.candleIntervalMs, "policyInput.candleIntervalMs"),
    recent_closed_candles: policy.candles
      .filter((candle) => toTime(candle.closedAt, "policyInput.candles[].closedAt") <= observedAtMs)
      .sort(
        (left, right) =>
          toTime(left.closedAt, "policyInput.candles[].closedAt") -
          toTime(right.closedAt, "policyInput.candles[].closedAt"),
      )
      .slice(-MAX_RECENT_CANDLES)
      .map((candle, index) => ({
        opened_at: toIsoDate(candle.openedAt, `policyInput.candles[${index}].openedAt`),
        closed_at: toIsoDate(candle.closedAt, `policyInput.candles[${index}].closedAt`),
        open: requireFinite(candle.open, `policyInput.candles[${index}].open`),
        high: requireFinite(candle.high, `policyInput.candles[${index}].high`),
        low: requireFinite(candle.low, `policyInput.candles[${index}].low`),
        close: requireFinite(candle.close, `policyInput.candles[${index}].close`),
      })),
    ...(input.strategy?.objective
      ? { strategy_objective: requireText(input.strategy.objective, "strategy.objective") }
      : {}),
    ...(policy.indicators ? { indicators: projectIndicators(policy.indicators) } : {}),
  };

  const outsideBand = state.current_price < state.band.low_price || state.current_price > state.band.high_price;

  return {
    model: modelRequested,
    state,
    questions: {
      market_regime: {
        type: "choice",
        instructions: {
          question:
            "Which single market regime best describes the observed price behavior in `recent_closed_candles` at `observed_at`? Use only observations present in state. This is a retrospective classification, not a trading instruction or forecast.",
          evidence_boundary:
            "Treat `current_price`, `band`, and `recent_closed_candles` as observations. Do not infer missing candles or use events after `observed_at`.",
        },
        criteria: {
          range:
            "Repeated two-sided oscillation or mean reversion without a sustained net directional displacement across the observed window.",
          drift_up:
            "Persistent upward displacement across the observed window; noise or pullbacks do not erase the directional progression.",
          drift_down:
            "Persistent downward displacement across the observed window; noise or rebounds do not erase the directional progression.",
          unstable_transition:
            "The observed window contains an abrupt structural change, discontinuity, contradictory segments, or instability that is not represented well by one range or directional drift label.",
          insufficient_evidence:
            "The observed coverage, continuity, or number of candles is inadequate to distinguish the other regimes reliably.",
        },
      },
      current_band_suitable: {
        type: "noul",
        instructions: {
          question:
            "At `observed_at`, does `band` remain structurally suitable for the recent observed price oscillations in `recent_closed_candles`? Judge descriptive fit only. Do not recommend a band change, make a trading decision, or claim future profit.",
          temporary_excursion_note:
            "A current price just outside the band can still be compatible with structural suitability when recent observed oscillations continue to fit the band.",
        },
        criteria: {
          true:
            "Recent observed oscillations are still substantially represented by the band's bounds and spacing, including a possibly temporary edge excursion.",
          false:
            "Recent observed oscillations show a material structural mismatch with the band's bounds or spacing, rather than only a brief edge excursion.",
        },
      },
      ...(outsideBand
        ? {
            temporary_outside_excursion: {
              type: "noul" as const,
              instructions: {
                question:
                  "Given that `current_price` is outside `band` at `observed_at`, will at least one of the next six completed one-hour candles close within the inclusive band? Use only evidence available at `observed_at`; no future candles are present in state.",
                evaluation_horizon:
                  "This prediction is later scored against the closing prices of the first six completed one-hour candles after `observed_at`. Intrabar touches do not count.",
              },
              criteria: {
                true:
                  "At least one of those six hourly candles closes at or between the band's inclusive low and high prices.",
                false:
                  "All six hourly candles close outside the band's inclusive low and high prices.",
              },
            },
          }
        : {}),
    },
  };
}

function projectIndicators(indicators: ShadowJevPolicyIndicators): NonNullable<ShadowJevState["indicators"]> {
  return {
    ...(indicators.observedAt ? { observed_at: toIsoDate(indicators.observedAt, "policyInput.indicators.observedAt") } : {}),
    ...(indicators.atrPct !== undefined ? { atr_pct: requireFinite(indicators.atrPct, "policyInput.indicators.atrPct") } : {}),
    ...(indicators.realizedVolPct !== undefined
      ? { realized_vol_pct: requireFinite(indicators.realizedVolPct, "policyInput.indicators.realizedVolPct") }
      : {}),
    ...(indicators.amplitudePct !== undefined
      ? { amplitude_pct: requireFinite(indicators.amplitudePct, "policyInput.indicators.amplitudePct") }
      : {}),
    ...(indicators.fillFrequencyPerDay !== undefined
      ? {
          fill_frequency_per_day: requireFinite(
            indicators.fillFrequencyPerDay,
            "policyInput.indicators.fillFrequencyPerDay",
          ),
        }
      : {}),
  };
}

function toIsoDate(value: Date | string, path: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${path} must be a valid date.`);
  }
  return date.toISOString();
}

function toTime(value: Date | string, path: string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new TypeError(`${path} must be a valid date.`);
  }
  return time;
}

function requireFinite(value: number, path: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite.`);
  }
  return value;
}

function requireText(value: string, path: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${path} must not be empty.`);
  }
  return value;
}
