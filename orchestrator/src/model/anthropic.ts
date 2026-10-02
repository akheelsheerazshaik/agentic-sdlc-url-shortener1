import { StageFailure } from '../engine/types.ts';
import type { ModelGateway, ModelRequest, ModelResponse } from './gateway.ts';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  model?: string;
  error?: { type?: string; message?: string };
}

/** Calls the Anthropic Messages API over HTTPS with the built-in fetch; there is no SDK dependency. */
export class AnthropicGateway implements ModelGateway {
  readonly id = 'anthropic';
  private readonly options: Required<Omit<AnthropicOptions, 'fetch'>>;
  private readonly fetch: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.options = {
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, ''),
      maxTokens: options.maxTokens ?? 16_000,
    };
    this.fetch = options.fetch ?? fetch;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
        }),
      });
    } catch (error) {
      // Network failures are worth retrying. The key is never part of the message.
      throw new StageFailure(`model request failed: ${(error as Error).message}`);
    }

    const body = (await response.json().catch(() => ({}))) as MessagesResponse;
    if (!response.ok) {
      const detail = body.error?.message ?? response.statusText;
      // Rate limits and server errors may clear on retry; a rejected request or bad key will not.
      const retryable = response.status === 429 || response.status >= 500;
      throw new StageFailure(`model returned HTTP ${response.status}: ${detail}`, { retryable });
    }
    if (body.stop_reason === 'max_tokens') {
      throw new StageFailure('model reply was cut off at the token limit', { retryable: false });
    }
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (text === '') throw new StageFailure('model returned no text');
    return { text, model: body.model ?? this.options.model };
  }
}
