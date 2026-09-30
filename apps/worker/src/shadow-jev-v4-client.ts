import { type JevClient, ShadowJevResponseError, ShadowJevTimeoutError } from "./shadow-jev-client";
import { type ShadowJevV4Request, v4ModelRequested } from "./shadow-jev-v4-questions";

export async function evaluateJevV4(request: ShadowJevV4Request, client: JevClient, options: { timeoutMs?: number } = {}) {
  if (request.model !== v4ModelRequested) throw new TypeError("Unsupported V4 model.");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid timeout.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rawResponse = await Promise.race([client.evaluate(request, { signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ShadowJevTimeoutError(timeoutMs)); }, timeoutMs); })]);
    try {
      const response = object(rawResponse), answers = object(response.answers), usage = object(response.usage);
      if (typeof response.model !== "string" || !response.model.trim()) throw new Error("Missing model version.");
      const parsed = {} as Record<"grid_candidate" | "exit_candidate", { choice: string; probabilities: Record<string, number>; confidence: number }>;
      for (const id of ["grid_candidate", "exit_candidate"] as const) {
        const answer = object(answers[id]), probabilities = object(answer.probabilities);
        const keys = Object.keys(request.questions[id].criteria);
        if (answer.type !== "choice" || typeof answer.choice !== "string" || !keys.includes(answer.choice) ||
          Object.keys(probabilities).length !== keys.length || Object.keys(probabilities).some(k => !keys.includes(k))) throw new Error(`Invalid ${id} options.`);
        const distribution = Object.fromEntries(keys.map(k => [k, probability(probabilities[k])]));
        if (Math.abs(Object.values(distribution).reduce((a, b) => a + b, 0) - 1) > 0.01 ||
          distribution[answer.choice]! + 1e-9 < Math.max(...Object.values(distribution))) throw new Error(`Invalid ${id} distribution.`);
        parsed[id] = { choice: answer.choice, probabilities: distribution, confidence: probability(answer.confidence) };
      }
      const tokens = (v: unknown) => { if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error("Invalid usage."); return v; };
      return { answers: parsed, modelResolved: response.model, rawResponse,
        usage: { input_tokens: tokens(usage.input_tokens), output_tokens: tokens(usage.output_tokens) } };
    } catch (error) { throw new ShadowJevResponseError(error instanceof Error ? error.message : "Invalid V4 response.", rawResponse); }
  } finally { if (timer) clearTimeout(timer); }
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected an object.");
  return v as Record<string, unknown>;
}
function probability(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new Error("Invalid probability.");
  return v;
}
