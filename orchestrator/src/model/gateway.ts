import { z } from 'zod';
import { StageFailure } from '../engine/types.ts';
import { sha256 } from '../util/hash.ts';

export interface ModelRequest {
  stageId: string;
  /** Which distinct set of inputs this is for the stage. See StageContext.generation. */
  generation: number;
  system: string;
  prompt: string;
}

export interface ModelResponse {
  text: string;
  /** The model that answered, or a label for a recording. */
  model: string;
}

/**
 * The one seam between the agents and whatever produces their text.
 * Agents are written once against this interface. Whether a live model answers or a recording is
 * replayed is decided when the run is wired up, not inside any agent.
 */
export interface ModelGateway {
  readonly id: string;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface ModelCallRecord {
  gateway: string;
  model: string;
  stageId: string;
  generation: number;
  /** Hashes, not content: enough to prove what was sent and received without copying it into the log. */
  promptHash: string;
  responseHash: string;
  durationMs: number;
}

/** Wraps a gateway so every call is counted against the run's budget and written to the audit log. */
export class MeteredGateway implements ModelGateway {
  readonly id: string;
  private readonly inner: ModelGateway;
  private readonly onCall: (record: ModelCallRecord) => void;

  constructor(inner: ModelGateway, onCall: (record: ModelCallRecord) => void) {
    this.inner = inner;
    this.id = inner.id;
    this.onCall = onCall;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const started = Date.now();
    const response = await this.inner.generate(request, signal);
    this.onCall({
      gateway: this.inner.id,
      model: response.model,
      stageId: request.stageId,
      generation: request.generation,
      promptHash: sha256(`${request.system}\n${request.prompt}`),
      responseHash: sha256(response.text),
      durationMs: Date.now() - started,
    });
    return response;
  }
}

/**
 * Pulls the JSON object out of a model reply, tolerating a code fence or stray prose around it.
 * The reply is tried as-is first: file contents inside the JSON often contain code fences of their
 * own, and those must not be mistaken for a fence around the reply.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  if (fenced) candidates.push(fenced[1]!);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  let lastError = 'model reply contains no JSON object';
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
      lastError = 'model reply is JSON but not an object';
    } catch (error) {
      lastError = `model reply is not valid JSON: ${(error as Error).message}`;
    }
  }
  throw new StageFailure(lastError);
}

/**
 * Asks the model for a value of a given shape and refuses anything else.
 * A reply that fails validation raises a retryable failure whose message lists what was wrong;
 * the engine passes that back as feedback on the next attempt.
 */
export async function generateStructured<T>(
  gateway: ModelGateway,
  schema: z.ZodType<T>,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<T> {
  const instructions = [
    request.prompt,
    '',
    'Reply with a single JSON object that matches this JSON Schema, and nothing else:',
    JSON.stringify(z.toJSONSchema(schema)),
  ].join('\n');
  const response = await gateway.generate({ ...request, prompt: instructions }, signal);
  const parsed = schema.safeParse(extractJson(response.text));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new StageFailure(`model reply does not match the required shape: ${problems}`);
  }
  return parsed.data;
}
