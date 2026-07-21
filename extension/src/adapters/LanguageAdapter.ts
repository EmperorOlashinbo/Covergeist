import type * as vscode from 'vscode';

export type TestRunner = 'jest' | 'vitest';

export interface FileCoverage {
  lines: Map<number, boolean>;
  functions: Map<string, boolean>;
}

export interface CoverageMap {
  files: Map<string, FileCoverage>;
}

export interface CodeSnippet {
  language: string;
  runner: TestRunner;
  functionName: string;
  snippetCode: string;
  contextCode: string;
  relativeFilePath: string;
}

export interface LanguageAdapter {
  readonly id: string;
  readonly displayName: string;

  canHandle(projectRoot: string): Promise<boolean>;
  analyzeStatically(projectRoot: string): Promise<CoverageMap>;
  detectRunner(projectRoot: string): Promise<TestRunner | null>;
  extractSnippet(document: vscode.TextDocument, range: vscode.Range): Promise<CodeSnippet>;
  resolveTestFilePath(sourceFilePath: string, projectRoot: string): string;
}
