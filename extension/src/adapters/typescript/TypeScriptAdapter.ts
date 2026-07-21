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

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next',
  'coverage', '.cache', '.vscode', '.idea', '.turbo', 'vendor',
]);
const SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const SKIP_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'else', 'return',
  'new', 'typeof', 'instanceof', 'void', 'delete', 'throw', 'case',
  'await', 'yield', 'import', 'export', 'class', 'extends', 'super',
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll',
]);

export class TypeScriptAdapter implements LanguageAdapter {
  readonly id = 'typescript';
  readonly displayName = 'TypeScript / JavaScript';

  async canHandle(projectRoot: string): Promise<boolean> {
    const pkg = this.readPackageJson(projectRoot);
    if (pkg) {
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ('typescript' in allDeps || 'ts-jest' in allDeps) return true;
    }
    return this.hasSourceFiles(projectRoot);
  }

  // ── Static analysis (primary scan method) ──────────────────────────────────

  async analyzeStatically(projectRoot: string): Promise<CoverageMap> {
    const sourceFiles: string[] = [];
    const testFiles: string[] = [];

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
        } else if (e.isFile() && SRC_EXTS.has(path.extname(e.name))) {
          const full = path.normalize(path.join(dir, e.name));
          if (TEST_RE.test(e.name)) {
            testFiles.push(full);
          } else {
            sourceFiles.push(full);
          }
        }
      }
    };

    walk(projectRoot);

    const files = new Map<string, FileCoverage>();

    for (const sourceFile of sourceFiles) {
      let content: string;
      try { content = fs.readFileSync(sourceFile, 'utf8'); }
      catch { continue; }

      const fns = this.extractFunctionRanges(content);
      if (fns.length === 0) continue;

      const relevantTests = this.findTestFilesForSource(sourceFile, testFiles);
      const testContents = relevantTests
        .map(tf => { try { return fs.readFileSync(tf, 'utf8'); } catch { return ''; } })
        .join('\n');

      const lines = new Map<number, boolean>();
      const functions = new Map<string, boolean>();

      for (const fn of fns) {
        const covered =
          testContents.length > 0 &&
          new RegExp(`\\b${fn.name}\\b`).test(testContents);

        functions.set(fn.name, covered);
        for (let l = fn.startLine; l <= fn.endLine; l++) {
          lines.set(l, covered);
        }
      }

      if (lines.size > 0) {
        files.set(sourceFile, { lines, functions });
      }
    }

    return { files };
  }

  // ── Runner detection (used for test generation prompts) ───────────────────

  async detectRunner(projectRoot: string): Promise<TestRunner | null> {
    const pkg = this.readPackageJson(projectRoot);
    if (!pkg) return null;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scriptValues = Object.values(pkg.scripts ?? {}).join(' ');
    if ('jest' in allDeps || scriptValues.includes('jest')) return 'jest';
    if ('vitest' in allDeps || scriptValues.includes('vitest')) return 'vitest';
    return null;
  }

  // ── Snippet extraction for test generation ────────────────────────────────

  resolveTestFilePath(sourceFilePath: string, projectRoot: string): string {
    const dir = path.dirname(sourceFilePath);
    const ext = path.extname(sourceFilePath);
    const base = path.basename(sourceFilePath, ext);
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
    const runner = (await this.detectRunner(projectRoot)) ?? 'vitest';

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
        fnRange = new vscode.Range(bounds.startLine, 0, bounds.endLine, document.lineAt(bounds.endLine).text.length);
        functionName = bounds.name;
      }
    } catch {
      const bounds = this.inferFunctionBounds(document, range.start.line);
      fnRange = new vscode.Range(bounds.startLine, 0, bounds.endLine, document.lineAt(bounds.endLine).text.length);
      functionName = bounds.name;
    }

    let snippetCode = document.getText(fnRange);
    if (snippetCode.length > 8000) snippetCode = snippetCode.slice(0, 8000);

    const beforeStart = Math.max(0, fnRange.start.line - 5);
    const afterEnd = Math.min(document.lineCount - 1, fnRange.end.line + 5);
    const contextLines: string[] = [];
    for (let i = beforeStart; i < fnRange.start.line; i++) contextLines.push(document.lineAt(i).text);
    for (let i = fnRange.end.line + 1; i <= afterEnd; i++) contextLines.push(document.lineAt(i).text);
    let contextCode = contextLines.join('\n');
    if (contextCode.length > 2000) contextCode = contextCode.slice(0, 2000);

    const relativeFilePath = path.relative(projectRoot, document.uri.fsPath).replace(/\\/g, '/');

    return { language: 'typescript', runner, functionName, snippetCode, contextCode, relativeFilePath };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private findTestFilesForSource(sourceFile: string, allTestFiles: string[]): string[] {
    const base = path.basename(sourceFile, path.extname(sourceFile));
    return allTestFiles.filter(tf => {
      const tfBase = path.basename(tf, path.extname(tf)).replace(/\.(test|spec)$/, '');
      return tfBase === base;
    });
  }

  private extractFunctionRanges(
    content: string,
  ): Array<{ name: string; startLine: number; endLine: number }> {
    const lines = content.split('\n');
    const results: Array<{ name: string; startLine: number; endLine: number }> = [];

    const PATTERNS: RegExp[] = [
      // Named function declarations: (export) (async) function name(
      /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/,
      // Arrow / expression: (export) const name = (async) (
      /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\(|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/,
      // Class methods: (modifiers) name(
      /^[ \t]+(?:(?:public|private|protected|static|abstract|override|async|readonly|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
    ];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();

      if (
        !trimmed ||
        trimmed.startsWith('//') || trimmed.startsWith('*') ||
        trimmed.startsWith('/*') || trimmed.startsWith('@') ||
        trimmed.startsWith('import ') || trimmed.startsWith('export type') ||
        trimmed.startsWith('type ') || trimmed.startsWith('interface ')
      ) continue;

      let name: string | null = null;
      for (const pat of PATTERNS) {
        const m = pat.exec(raw);
        if (m?.[1] && !SKIP_KEYWORDS.has(m[1])) {
          name = m[1];
          break;
        }
      }
      if (!name) continue;

      // Brace-count to find the end of the function body
      let depth = 0;
      let started = false;
      let endLine = i;

      outer:
      for (let j = i; j < Math.min(i + 500, lines.length); j++) {
        const l = lines[j];
        let inStr = false;
        let strCh = '';
        for (let k = 0; k < l.length; k++) {
          const ch = l[k];
          if (inStr) {
            if (ch === strCh && l[k - 1] !== '\\') inStr = false;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
          if (ch === '/' && l[k + 1] === '/') break;
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') {
            depth--;
            if (started && depth === 0) { endLine = j; break outer; }
          }
        }
      }

      // Expression-body arrow: const f = () => value (no braces)
      if (!started) {
        const combined = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
        if (/=>\s*[^{\n]/.test(combined)) {
          results.push({ name, startLine: i + 1, endLine: i + 1 });
          continue;
        }
      }

      if (started) {
        results.push({ name, startLine: i + 1, endLine: endLine + 1 });
      }
    }

    return results;
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
    let startLine = targetLine;
    for (let i = targetLine; i >= Math.max(0, targetLine - 30); i--) {
      const text = document.lineAt(i).text;
      if (/\bfunction\b|\)\s*\{|\)\s*:\s*\w.*\{|=>\s*\{/.test(text)) {
        startLine = i;
        break;
      }
    }
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
    const startText = document.lineAt(startLine).text.trim();
    let name = 'unknownFunction';
    let m: RegExpExecArray | null;
    if ((m = /function\s+(\w+)/.exec(startText))) name = m[1];
    else if ((m = /(?:const|let|var)\s+(\w+)\s*=/.exec(startText))) name = m[1];
    else if ((m = /(?:(?:public|private|protected|static|override|abstract|async)\s+)+(\w+)\s*\(/.exec(startText))) name = m[1];
    else if ((m = /^(\w+)\s*\(/.exec(startText))) name = m[1];
    return { startLine, endLine, name };
  }

  private readPackageJson(projectRoot: string): PackageJson | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as PackageJson;
    } catch { return null; }
  }

  private hasSourceFiles(dir: string): boolean {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.isFile() && SRC_EXTS.has(path.extname(entry.name))) return true;
        if (entry.isDirectory()) {
          const sub = path.join(dir, entry.name);
          for (const child of fs.readdirSync(sub, { withFileTypes: true })) {
            if (child.isFile() && SRC_EXTS.has(path.extname(child.name))) return true;
          }
        }
      }
    } catch { /* ignore */ }
    return false;
  }
}
