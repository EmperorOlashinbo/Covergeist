import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicClient, LLMTimeoutError } from './AnthropicClient';

const FAKE_KEY = 'sk-test-key';

function makeResponse(text: string, status = 200) {
  return Promise.resolve(
    new Response(
      JSON.stringify({ content: [{ type: 'text', text }] }),
      { status, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

describe('AnthropicClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the text content from a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(makeResponse('describe("fn", () => {});'));
    const client = new AnthropicClient(FAKE_KEY);
    const result = await client.generate({ system: 'sys', user: 'usr' });
    expect(result).toBe('describe("fn", () => {});');
  });

  it('sends the correct headers and model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(makeResponse('ok'));
    const client = new AnthropicClient(FAKE_KEY);
    await client.generate({ system: 'sys', user: 'usr' });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(FAKE_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-3-5-haiku-20241022');
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0);
  });

  it('throws LLMTimeoutError when the request times out', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal)?.addEventListener('abort', () => {
          const err = new DOMException('aborted', 'AbortError');
          reject(err);
        });
      });
    });

    const client = new AnthropicClient(FAKE_KEY);
    const promise = client.generate({ system: 'sys', user: 'usr' });
    vi.advanceTimersByTime(12_001);
    await expect(promise).rejects.toThrow(LLMTimeoutError);
  });

  it('throws a plain Error when Anthropic returns a non-OK status', async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(makeResponse('', 500));
    const client = new AnthropicClient(FAKE_KEY);
    await expect(client.generate({ system: 'sys', user: 'usr' })).rejects.toThrow(
      'Anthropic API responded with 500',
    );
  });

  it('returns empty string when content array is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      Promise.resolve(
        new Response(JSON.stringify({ content: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const client = new AnthropicClient(FAKE_KEY);
    const result = await client.generate({ system: 'sys', user: 'usr' });
    expect(result).toBe('');
  });
});
