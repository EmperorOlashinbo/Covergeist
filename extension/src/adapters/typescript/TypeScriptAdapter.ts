import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
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
    _document: vscode.TextDocument,
    _range: vscode.Range,
  ): Promise<CodeSnippet> {
    throw new Error('extractSnippet not implemented — Story 3.1');
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
