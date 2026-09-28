import { type JevClient, ShadowJevResponseError, ShadowJevTimeoutError } from "./shadow-jev-client";
import { type ShadowJevV3Request, v3ModelRequested } from "./shadow-jev-v3-questions";

export interface ShadowJevV3Evaluation {
  modelResolved: string;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  usage: { input_tokens: number; output_tokens: number };
  rawResponse: unknown;
}

export async function evaluateJevV3(request: ShadowJevV3Request, client: JevClient,
  options: { timeoutMs?: number } = {}): Promise<ShadowJevV3Evaluation> {
  if (request.model !== v3ModelRequested) throw new TypeError("Unsupported V3 Jev model.");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid Jev timeout.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rawResponse = await Promise.race([
      client.evaluate(request, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ShadowJevTimeoutError(timeoutMs)); }, timeoutMs);
      }),
    ]);
    try {
      return parseV3Response(request, rawResponse);
    } catch (error) {
      if (error instanceof ShadowJevResponseError) throw new ShadowJevResponseError(error.message, rawResponse);
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseV3Response(request: ShadowJevV3Request, rawResponse: unknown): ShadowJevV3Evaluation {
  const response = record(rawResponse, "response");
  const answers = record(response.answers, "response.answers");
  const candidate = record(answers.grid_candidate, "response.answers.grid_candidate");
  if (candidate.type !== "choice") throw new ShadowJevResponseError("V3 grid_candidate must be a Choice.");
  const criteria = request.questions.grid_candidate.criteria;
  const keys = Object.keys(criteria);
  const choice = candidate.choice;
  if (typeof choice !== "string" || !keys.includes(choice)) {
    throw new ShadowJevResponseError("V3 grid_candidate selected an unknown option.");
  }
  const rawProbabilities = record(candidate.probabilities, "response.answers.grid_candidate.probabilities");
  if (Object.keys(rawProbabilities).length !== keys.length ||
    Object.keys(rawProbabilities).some(key => !keys.includes(key))) {
    throw new ShadowJevResponseError("V3 grid_candidate probability options do not match the request.");
  }
  const probabilities: Record<string, number> = {};
  for (const key of keys) probabilities[key] = probability(rawProbabilities[key], `probabilities.${key}`);
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.01) throw new ShadowJevResponseError("V3 probabilities must sum to one.");
  if (probabilities[choice]! + 1e-9 < Math.max(...Object.values(probabilities))) {
    throw new ShadowJevResponseError("V3 selected option is not the probability maximum.");
  }
  const modelResolved = response.model;
  if (typeof modelResolved !== "string" || !modelResolved.trim()) {
    throw new ShadowJevResponseError("V3 response.model is missing.");
  }
  const usage = record(response.usage, "response.usage");
  return { modelResolved, choice, probabilities,
    confidence: probability(candidate.confidence, "response.answers.grid_candidate.confidence"),
    usage: { input_tokens: nonNegativeInteger(usage.input_tokens, "usage.input_tokens"),
      output_tokens: nonNegativeInteger(usage.output_tokens, "usage.output_tokens") }, rawResponse };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShadowJevResponseError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}
function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ShadowJevResponseError(`${path} must be a probability.`);
  }
  return value;
}
function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ShadowJevResponseError(`${path} must be a non-negative integer.`);
  }
  return value;
}
