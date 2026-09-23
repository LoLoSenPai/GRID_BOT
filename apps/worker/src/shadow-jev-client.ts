import {
  marketRegimes,
  modelRequested,
  questionSetVersion,
  type ShadowJevMarketRegime,
  type ShadowJevRequest,
} from "./shadow-jev-questions";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface JevClientRequestOptions {
  signal?: AbortSignal;
}

export interface JevClient {
  evaluate(request: ShadowJevRequest, options?: JevClientRequestOptions): Promise<unknown>;
}

export interface HttpJevClientOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export interface EvaluateJevOptions {
  timeoutMs?: number;
}

export interface ShadowJevChoiceAnswer {
  type: "choice";
  choice: ShadowJevMarketRegime;
  probabilities: Record<ShadowJevMarketRegime, number>;
  confidence: number;
}

export interface ShadowJevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface ShadowJevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ShadowJevEvaluation {
  questionSetVersion: typeof questionSetVersion;
  modelRequested: typeof modelRequested;
  modelResolved: string;
  answers: {
    marketRegime: ShadowJevChoiceAnswer;
    currentBandSuitable: ShadowJevNoulAnswer;
    temporaryOutsideExcursion: ShadowJevNoulAnswer | null;
  };
  usage: ShadowJevUsage;
  rawResponse: unknown;
}

export class ShadowJevTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Jev evaluation timed out after ${timeoutMs} ms.`);
    this.name = "ShadowJevTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ShadowJevResponseError extends Error {
  readonly rawResponse?: unknown;

  constructor(message: string, rawResponse?: unknown) {
    super(message);
    this.name = "ShadowJevResponseError";
    this.rawResponse = rawResponse;
  }
}

export class HttpJevClient implements JevClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpJevClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new TypeError("apiKey must not be empty.");
    }
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async evaluate(request: ShadowJevRequest, options: JevClientRequestOptions = {}): Promise<unknown> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TypeSafe API returned HTTP ${response.status}${body ? `: ${body}` : "."}`);
    }

    return response.json();
  }
}

export async function evaluateJev(
  request: ShadowJevRequest,
  client: JevClient,
  options: EvaluateJevOptions = {},
): Promise<ShadowJevEvaluation> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number.");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ShadowJevTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });

  try {
    const rawResponse = await Promise.race([client.evaluate(request, { signal: controller.signal }), timeout]);
    try {
      return parseEvaluation(request, rawResponse);
    } catch (error) {
      if (error instanceof ShadowJevResponseError && error.rawResponse === undefined) {
        throw new ShadowJevResponseError(error.message, rawResponse);
      }
      throw error;
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function parseEvaluation(request: ShadowJevRequest, rawResponse: unknown): ShadowJevEvaluation {
  const response = requireRecord(rawResponse, "response");
  const answers = requireRecord(response.answers, "response.answers");
  const marketRegime = parseMarketRegime(answers.market_regime);
  const currentBandSuitable = parseNoul(answers.current_band_suitable, "response.answers.current_band_suitable");
  const temporaryOutsideExcursion = request.questions.temporary_outside_excursion
    ? parseNoul(answers.temporary_outside_excursion, "response.answers.temporary_outside_excursion")
    : null;
  const usage = requireRecord(response.usage, "response.usage");

  return {
    questionSetVersion,
    modelRequested,
    modelResolved: requireString(response.model, "response.model"),
    answers: {
      marketRegime,
      currentBandSuitable,
      temporaryOutsideExcursion,
    },
    usage: {
      input_tokens: requireNonNegativeInteger(usage.input_tokens, "response.usage.input_tokens"),
      output_tokens: requireNonNegativeInteger(usage.output_tokens, "response.usage.output_tokens"),
    },
    rawResponse,
  };
}

function parseMarketRegime(value: unknown): ShadowJevChoiceAnswer {
  const answer = requireRecord(value, "response.answers.market_regime");
  if (answer.type !== "choice") {
    throw new ShadowJevResponseError("response.answers.market_regime.type must be choice.");
  }
  const choice = requireString(answer.choice, "response.answers.market_regime.choice");
  if (!isMarketRegime(choice)) {
    throw new ShadowJevResponseError(`Unknown market regime choice: ${choice}.`);
  }
  const rawProbabilities = requireRecord(answer.probabilities, "response.answers.market_regime.probabilities");
  const probabilities = Object.fromEntries(
    marketRegimes.map((regime) => [
      regime,
      requireProbability(rawProbabilities[regime], `response.answers.market_regime.probabilities.${regime}`),
    ]),
  ) as Record<ShadowJevMarketRegime, number>;
  const sum = Object.values(probabilities).reduce((total, probability) => total + probability, 0);
  if (Math.abs(sum - 1) > 0.01) {
    throw new ShadowJevResponseError("Market regime probabilities must sum to 1 (within 0.01). ");
  }
  return {
    type: "choice",
    choice,
    probabilities,
    confidence: requireProbability(answer.confidence, "response.answers.market_regime.confidence"),
  };
}

function parseNoul(value: unknown, path: string): ShadowJevNoulAnswer {
  const answer = requireRecord(value, path);
  if (answer.type !== "noul") {
    throw new ShadowJevResponseError(`${path}.type must be noul.`);
  }
  return { type: "noul", noul: requireProbability(answer.noul, `${path}.noul`) };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShadowJevResponseError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ShadowJevResponseError(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireProbability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ShadowJevResponseError(`${path} must be a probability between 0 and 1.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ShadowJevResponseError(`${path} must be a non-negative integer.`);
  }
  return value;
}

function isMarketRegime(value: string): value is ShadowJevMarketRegime {
  return (marketRegimes as readonly string[]).includes(value);
}
