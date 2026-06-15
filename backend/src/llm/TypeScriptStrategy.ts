import type { CodeSnippet } from '@covergeist/shared';

interface Prompt {
  system: string;
  user: string;
}

export class TypeScriptStrategy {
  static buildPrompt(snippet: CodeSnippet): Prompt {
    const system =
      snippet.runner === 'vitest'
        ? 'You are a TypeScript test generator. Output ONLY valid TypeScript test code — no markdown code fences, no explanations, no prose. The output must be executable TypeScript that can be saved directly to a .test.ts file and run with Vitest. Use Vitest\'s API: describe(), it(), expect(), vi.fn(), beforeEach(), afterEach(). Import the function under test using the correct relative path.'
        : 'You are a TypeScript test generator. Output ONLY valid TypeScript test code — no markdown code fences, no explanations, no prose. The output must be executable TypeScript that can be saved directly to a .test.ts file and run with Jest. Use Jest\'s API: describe(), it(), expect(), jest.fn(), beforeEach(), afterEach(). Import the function under test using the correct relative path.';

    const lines = [
      `Generate a comprehensive test for the following TypeScript function from \`${snippet.relativeFilePath}\`.`,
      '',
      'Function to test:',
      snippet.snippetCode,
    ];

    if (snippet.contextCode.trim()) {
      lines.push('', 'Surrounding context:', snippet.contextCode);
    }

    return { system, user: lines.join('\n') };
  }

  static sanitiseResponse(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('```')) return trimmed;

    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) return trimmed;

    const withoutOpenFence = trimmed.slice(firstNewline + 1);
    const closingFence = withoutOpenFence.lastIndexOf('```');
    return closingFence >= 0
      ? withoutOpenFence.slice(0, closingFence).trimEnd()
      : withoutOpenFence.trimEnd();
  }
}
