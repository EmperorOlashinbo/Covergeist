import { describe, it, expect } from 'vitest';
import { TypeScriptStrategy } from './TypeScriptStrategy';
import type { CodeSnippet } from '@covergeist/shared';

const baseSnippet: CodeSnippet = {
  language: 'typescript',
  runner: 'jest',
  functionName: 'add',
  snippetCode: 'function add(a: number, b: number) { return a + b; }',
  contextCode: '',
  relativeFilePath: 'src/math.ts',
};

describe('TypeScriptStrategy.buildPrompt', () => {
  it('includes the function code in the user message', () => {
    const { user } = TypeScriptStrategy.buildPrompt(baseSnippet);
    expect(user).toContain(baseSnippet.snippetCode);
  });

  it('includes the relative file path in the user message', () => {
    const { user } = TypeScriptStrategy.buildPrompt(baseSnippet);
    expect(user).toContain('src/math.ts');
  });

  it('uses Jest system prompt when runner is jest', () => {
    const { system } = TypeScriptStrategy.buildPrompt({ ...baseSnippet, runner: 'jest' });
    expect(system).toContain('Jest');
    expect(system).not.toContain('Vitest');
  });

  it('uses Vitest system prompt when runner is vitest', () => {
    const { system } = TypeScriptStrategy.buildPrompt({ ...baseSnippet, runner: 'vitest' });
    expect(system).toContain('Vitest');
    expect(system).toContain('vi.fn()');
  });

  it('includes surrounding context when contextCode is non-empty', () => {
    const { user } = TypeScriptStrategy.buildPrompt({
      ...baseSnippet,
      contextCode: 'import { something } from "./other";',
    });
    expect(user).toContain('Surrounding context');
    expect(user).toContain('import { something }');
  });

  it('omits surrounding context section when contextCode is blank', () => {
    const { user } = TypeScriptStrategy.buildPrompt({ ...baseSnippet, contextCode: '   ' });
    expect(user).not.toContain('Surrounding context');
  });

  it('system prompt instructs no markdown fences', () => {
    const { system } = TypeScriptStrategy.buildPrompt(baseSnippet);
    expect(system).toContain('no markdown code fences');
  });
});

describe('TypeScriptStrategy.sanitiseResponse', () => {
  it('returns plain code unchanged', () => {
    const code = 'describe("add", () => { it("works", () => {}); });';
    expect(TypeScriptStrategy.sanitiseResponse(code)).toBe(code);
  });

  it('strips typescript code fence', () => {
    const raw = '```typescript\ndescribe("x", () => {});\n```';
    expect(TypeScriptStrategy.sanitiseResponse(raw)).toBe('describe("x", () => {});');
  });

  it('strips plain code fence', () => {
    const raw = '```\ndescribe("x", () => {});\n```';
    expect(TypeScriptStrategy.sanitiseResponse(raw)).toBe('describe("x", () => {});');
  });

  it('strips opening fence but handles missing closing fence gracefully', () => {
    const raw = '```typescript\ndescribe("x", () => {});';
    const result = TypeScriptStrategy.sanitiseResponse(raw);
    expect(result).toBe('describe("x", () => {});');
    expect(result).not.toContain('```');
  });

  it('trims leading and trailing whitespace', () => {
    const raw = '  \n  describe("x", () => {});  \n  ';
    expect(TypeScriptStrategy.sanitiseResponse(raw)).toBe('describe("x", () => {});');
  });

  it('preserves internal newlines', () => {
    const code = 'describe("x", () => {\n  it("y", () => {});\n});';
    expect(TypeScriptStrategy.sanitiseResponse(code)).toBe(code);
  });
});
