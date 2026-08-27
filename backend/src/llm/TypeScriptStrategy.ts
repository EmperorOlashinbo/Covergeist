import type { CodeSnippet, FileSnippet } from '@covergeist/shared';

interface Prompt {
  system: string;
  user: string;
}

export class TypeScriptStrategy {
  static buildPrompt(snippet: CodeSnippet): Prompt {
    const isVitest = snippet.runner === 'vitest';
    const runner = isVitest ? 'Vitest' : 'Jest';
    const mockFn = isVitest ? 'vi.fn()' : 'jest.fn()';
    const mockModule = isVitest ? 'vi.mock(...)' : 'jest.mock(...)';

    // Derive the import path the test file should use (same directory, no extension)
    const srcFile = snippet.relativeFilePath;
    const baseName = srcFile.replace(/\.[^./]+$/, ''); // strip extension
    const fileName = baseName.split('/').pop() ?? baseName; // last segment
    const importPath = `./${fileName}`;

    const system = [
      `You are a TypeScript test generator using ${runner}.`,
      'Output ONLY a single, complete, syntactically valid TypeScript test file.',
      'No markdown fences, no explanations, no prose — raw TypeScript only.',
      'Rules:',
      `  1. Import the module under test from "${importPath}" — use this exact path everywhere.`,
      '  2. Do NOT use any other import paths for the module under test.',
      `  3. Use only ${runner} APIs: describe(), it(), expect(), ${mockFn}, ${mockModule}, beforeEach(), afterEach().`,
      '  4. One import block at the top, one or more describe() blocks, no duplicate sections.',
      '  5. The file must be complete and syntactically valid — no cut-off code.',
    ].join('\n');

    const lines = [
      `Source file: ${srcFile}`,
      `Test file will be saved as: ${baseName}.test.ts`,
      '',
      'Function to test:',
      snippet.snippetCode,
    ];

    if (snippet.contextCode.trim()) {
      lines.push('', 'Other exports/imports in the same source file (for context only — do not import from these paths):', snippet.contextCode);
    }

    return { system, user: lines.join('\n') };
  }

  static buildFilePrompt(fileSnippet: FileSnippet): Prompt {
    const isVitest = fileSnippet.runner === 'vitest';
    const runner = isVitest ? 'Vitest' : 'Jest';
    const mockFn = isVitest ? 'vi.fn()' : 'jest.fn()';
    const mockModule = isVitest ? 'vi.mock(...)' : 'jest.mock(...)';

    const srcFile = fileSnippet.relativeFilePath;
    const baseName = srcFile.replace(/\.[^./]+$/, '');
    const fileName = baseName.split('/').pop() ?? baseName;
    const importPath = `./${fileName}`;

    const fnNames = fileSnippet.uncoveredFunctions.map(f => f.name).join(', ');

    const system = [
      `You are a TypeScript test generator using ${runner}.`,
      'Output ONLY a single, complete, syntactically valid TypeScript test file.',
      'No markdown fences, no explanations, no prose — raw TypeScript only.',
      'Rules:',
      `  1. Import ALL tested symbols from "${importPath}" — use this exact path everywhere, no other paths.`,
      '  2. Write exactly ONE import statement at the very top of the file.',
      `  3. Use only ${runner} APIs: describe(), it(), expect(), ${mockFn}, ${mockModule}, beforeEach(), afterEach().`,
      `  4. Write one separate describe('${fnNames.split(', ').join("') block and one describe('")}') block for EACH function listed below.`,
      '  5. Each describe() block must have at least 2 it() test cases (happy path + edge/error case).',
      '  6. The file must be syntactically complete — every describe() and it() block fully closed with }.',
      '  7. Never duplicate an import or a describe() block.',
    ].join('\n');

    const fnBlocks = fileSnippet.uncoveredFunctions
      .map(f => `### Function: ${f.name}\n${f.code}`)
      .join('\n\n');

    const lines = [
      `Source file: ${srcFile}`,
      `Test file will be saved as: ${baseName}.test.ts`,
      '',
      `Generate tests for the following ${fileSnippet.uncoveredFunctions.length} uncovered function(s):`,
      '',
      fnBlocks,
    ];

    if (fileSnippet.contextCode.trim()) {
      lines.push(
        '',
        'Context from the source file (imports, types — for reference only, do NOT import from these paths):',
        fileSnippet.contextCode,
      );
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
