export class LLMTimeoutError extends Error {
  constructor() {
    super('Anthropic API did not respond within 12 seconds');
    this.name = 'LLMTimeoutError';
  }
}

interface AnthropicPrompt {
  system: string;
  user: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

export class AnthropicClient {
  private static readonly MODEL = 'claude-3-5-haiku-20241022';
  private static readonly TIMEOUT_MS = 12_000;
  private static readonly MAX_TOKENS = 1024;

  constructor(private readonly apiKey: string) {}

  async generate(prompt: AnthropicPrompt): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AnthropicClient.TIMEOUT_MS);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: AnthropicClient.MODEL,
          max_tokens: AnthropicClient.MAX_TOKENS,
          temperature: 0,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Anthropic API responded with ${response.status}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      return data.content[0]?.text ?? '';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMTimeoutError();
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
