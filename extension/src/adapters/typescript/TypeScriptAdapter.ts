import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  CodeSnippet,
  CoverageMap,
  FileCoverage,
  LanguageAdapter,
  TestRunner,
} from '../LanguageAdapter';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export class TypeScriptAdapter implements LanguageAdapter {
  readonly id = 'typescript';
  readonly displayName = 'TypeScript / JavaScript';

  async canHandle(projectRoot: string): Promise<boolean> {
    const pkg = this.readPackageJson(projectRoot);
    if (pkg) {
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ('typescript' in allDeps || 'ts-jest' in allDeps) {
        return true;
      }
    }
    return this.hasSourceFiles(projectRoot, ['.ts', '.js']);
  }

  async detectRunner(projectRoot: string): Promise<TestRunner | null> {
    const pkg = this.readPackageJson(projectRoot);
    if (!pkg) return null;

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scriptValues = Object.values(pkg.scripts ?? {}).join(' ');

    const hasJest = 'jest' in allDeps || scriptValues.includes('jest');
    const hasVitest = 'vitest' in allDeps || scriptValues.includes('vitest');

    // Jest takes precedence per ADR-1 when both are present
    if (hasJest) return 'jest';
    if (hasVitest) return 'vitest';
    return null;
  }

  async runCoverage(
    projectRoot: string,
    runner: TestRunner,
    signal?: AbortSignal,
  ): Promise<string> {
    const args =
      runner === 'jest'
        ? ['jest', '--coverage', '--passWithNoTests']
        : ['vitest', 'run', '--coverage'];

    await this.spawnCoverageProcess('npx', args, projectRoot, signal);

    const lcovPath = path.join(projectRoot, 'coverage', 'lcov.info');
    if (!fs.existsSync(lcovPath)) {
      throw new Error(
        `LCOV file not found at ${lcovPath}. Ensure coverage is configured to output LCOV format.`,
      );
    }
    return lcovPath;
  }

  async parseCoverage(lcovPath: string): Promise<CoverageMap> {
    const content = fs.readFileSync(lcovPath, 'utf8');
    const files = new Map<string, FileCoverage>();

    let currentPath: string | null = null;
    let lines: Map<number, boolean> = new Map();
    let functions: Map<string, boolean> = new Map();

    for (const raw of content.split('\n')) {
      const line = raw.trim();

      if (line.startsWith('SF:')) {
        currentPath = line.slice(3);
        lines = new Map();
        functions = new Map();
      } else if (line.startsWith('DA:')) {
        const rest = line.slice(3);
        const comma = rest.indexOf(',');
        if (comma !== -1) {
          const lineNum = parseInt(rest.slice(0, comma), 10);
          const hits = parseInt(rest.slice(comma + 1), 10);
          if (!isNaN(lineNum)) lines.set(lineNum, hits > 0);
        }
      } else if (line.startsWith('FNDA:')) {
        const rest = line.slice(5);
        const comma = rest.indexOf(',');
        if (comma !== -1) {
          const hits = parseInt(rest.slice(0, comma), 10);
          const fnName = rest.slice(comma + 1);
          if (fnName) functions.set(fnName, hits > 0);
        }
      } else if (line === 'end_of_record' && currentPath !== null) {
        files.set(currentPath, {
          lines: new Map(lines),
          functions: new Map(functions),
        });
        currentPath = null;
      }
    }

    return { files };
  }

  resolveTestFilePath(sourceFilePath: string, projectRoot: string): string {
    const dir = path.dirname(sourceFilePath);
    const ext = path.extname(sourceFilePath);
    const base = path.basename(sourceFilePath, ext);

    // Look for a __tests__ directory in the parent of the source file's directory
    const parentDir = path.dirname(dir);
    const candidateTestsDir = path.join(parentDir, '__tests__');

    if (fs.existsSync(path.join(projectRoot, candidateTestsDir))) {
      return path.join(parentDir, '__tests__', `${base}.test${ext}`).replace(/\\/g, '/');
    }

    return path.join(dir, `${base}.test${ext}`).replace(/\\/g, '/');
  }

  async extractSnippet(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): Promise<CodeSnippet> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const projectRoot = workspaceFolder?.uri.fsPath ?? path.dirname(document.uri.fsPath);

    const runner = (await this.detectRunner(projectRoot)) ?? 'jest';

    // Primary path: use VS Code's document symbol provider for accurate boundaries
    let fnRange: vscode.Range;
    let functionName: string;

    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
      const sym = this.findInnermostFunctionSymbol(symbols ?? [], range);
      if (sym) {
        fnRange = sym.range;
        functionName = sym.name;
      } else {
        const bounds = this.inferFunctionBounds(document, range.start.line);
        fnRange = new vscode.Range(
          bounds.startLine, 0,
          bounds.endLine, document.lineAt(bounds.endLine).text.length,
        );
        functionName = bounds.name;
      }
    } catch {
      const bounds = this.inferFunctionBounds(document, range.start.line);
      fnRange = new vscode.Range(
        bounds.startLine, 0,
        bounds.endLine, document.lineAt(bounds.endLine).text.length,
      );
      functionName = bounds.name;
    }

    let snippetCode = document.getText(fnRange);
    if (snippetCode.length > 8000) snippetCode = snippetCode.slice(0, 8000);

    // Up to 5 lines before + 5 lines after the function = up to 10 context lines
    const beforeStart = Math.max(0, fnRange.start.line - 5);
    const afterEnd = Math.min(document.lineCount - 1, fnRange.end.line + 5);
    const contextLines: string[] = [];
    for (let i = beforeStart; i < fnRange.start.line; i++) {
      contextLines.push(document.lineAt(i).text);
    }
    for (let i = fnRange.end.line + 1; i <= afterEnd; i++) {
      contextLines.push(document.lineAt(i).text);
    }
    let contextCode = contextLines.join('\n');
    if (contextCode.length > 2000) contextCode = contextCode.slice(0, 2000);

    const relativeFilePath = path.relative(projectRoot, document.uri.fsPath).replace(/\\/g, '/');

    return { language: 'typescript', runner, functionName, snippetCode, contextCode, relativeFilePath };
  }

  private findInnermostFunctionSymbol(
    symbols: vscode.DocumentSymbol[],
    range: vscode.Range,
  ): vscode.DocumentSymbol | null {
    const functionKinds = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor,
    ]);

    let best: vscode.DocumentSymbol | null = null;

    const search = (syms: vscode.DocumentSymbol[]): void => {
      for (const sym of syms) {
        if (sym.range.contains(range)) {
          if (functionKinds.has(sym.kind) && (!best || sym.range.start.isAfter(best.range.start))) {
            best = sym;
          }
          search(sym.children);
        }
      }
    };

    search(symbols);
    return best;
  }

  private inferFunctionBounds(
    document: vscode.TextDocument,
    targetLine: number,
  ): { startLine: number; endLine: number; name: string } {
    // Walk backward to find a function declaration line
    let startLine = targetLine;
    for (let i = targetLine; i >= Math.max(0, targetLine - 30); i--) {
      const text = document.lineAt(i).text;
      if (/\bfunction\b|\)\s*\{|\)\s*:\s*\w.*\{|=>\s*\{/.test(text)) {
        startLine = i;
        break;
      }
    }

    // Brace-count forward to find closing brace
    let depth = 0;
    let endLine = targetLine;
    let started = false;
    for (let i = startLine; i < Math.min(startLine + 200, document.lineCount); i++) {
      for (const ch of document.lineAt(i).text) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
      }
      if (started && depth === 0) { endLine = i; break; }
    }

    // Extract function name from the declaration line
    const startText = document.lineAt(startLine).text.trim();
    let name = 'unknownFunction';
    let m: RegExpExecArray | null;
    if ((m = /function\s+(\w+)/.exec(startText))) {
      name = m[1];
    } else if ((m = /(?:const|let|var)\s+(\w+)\s*=/.exec(startText))) {
      name = m[1];
    } else if ((m = /(?:(?:public|private|protected|static|override|abstract|async)\s+)+(\w+)\s*\(/.exec(startText))) {
      name = m[1];
    } else if ((m = /^(\w+)\s*\(/.exec(startText))) {
      name = m[1];
    }

    return { startLine, endLine, name };
  }

  private spawnCoverageProcess(
    cmd: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Coverage scan aborted before starting'));
        return;
      }

      const child = spawn(cmd, args, { cwd, stdio: 'pipe' });

      const onAbort = (): void => {
        child.kill();
        reject(new Error('Coverage scan terminated after timeout'));
      };

      signal?.addEventListener('abort', onAbort);

      child.on('close', () => {
        signal?.removeEventListener('abort', onAbort);
        // Resolve regardless of exit code — failing tests still write coverage
        resolve();
      });

      child.on('error', err => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }

  private readPackageJson(projectRoot: string): PackageJson | null {
    try {
      const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
      return JSON.parse(content) as PackageJson;
    } catch {
      return null;
    }
  }

  private hasSourceFiles(dir: string, extensions: string[]): boolean {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'out', '.git'].includes(entry.name)) continue;
        if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) return true;
        if (entry.isDirectory()) {
          const sub = path.join(dir, entry.name);
          for (const child of fs.readdirSync(sub, { withFileTypes: true })) {
            if (child.isFile() && extensions.some(ext => child.name.endsWith(ext))) return true;
          }
        }
      }
    } catch {
      // ignore permission errors
    }
    return false;
  }
}
