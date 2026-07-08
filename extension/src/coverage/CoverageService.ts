import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { CoverageMap, FileCoverage } from '../adapters/LanguageAdapter';

const WARN_THRESHOLD_MS = 30_000;
const KILL_THRESHOLD_MS = 60_000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '.cache']);

export type CoverageListener = (map: CoverageMap, projectRoot: string) => void;

export class CoverageService implements vscode.Disposable {
  private cache: CoverageMap | null = null;
  private readonly listeners = new Set<CoverageListener>();

  constructor(private readonly registry: AdapterRegistry) {}

  onCoverageUpdated(listener: CoverageListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  getCoverageForFile(absolutePath: string): FileCoverage | null {
    return this.cache?.files.get(absolutePath) ?? null;
  }

  getCache(): CoverageMap | null {
    return this.cache;
  }

  async runScan(projectRoot: string): Promise<void> {
    const adapter = await this.registry.resolve(projectRoot);
    if (!adapter) {
      void vscode.window.showInformationMessage(
        'Covergeist: No supported project type found. Open a TypeScript or JavaScript project folder.',
      );
      return;
    }

    const runner = await adapter.detectRunner(projectRoot);
    if (!runner) {
      await this.handleNoRunner(projectRoot);
      return;
    }

    const controller = new AbortController();

    const warnTimer = setTimeout(() => {
      void vscode.window.showWarningMessage(
        'Coverage scan is taking longer than expected — your test suite may be slow.',
      );
    }, WARN_THRESHOLD_MS);

    const killTimer = setTimeout(() => {
      controller.abort();
    }, KILL_THRESHOLD_MS);

    try {
      const lcovPath = await adapter.runCoverage(projectRoot, runner, controller.signal);
      const map = await adapter.parseCoverage(lcovPath);
      this.cache = map;
      for (const listener of this.listeners) {
        listener(map, projectRoot);
      }
      const fileCount = map.files.size;
      if (fileCount === 0) {
        const choice = await vscode.window.showWarningMessage(
          'Covergeist: Coverage ran but found 0 files. ' +
          'Jest needs test files that import your source code. ' +
          'Also add "collectCoverageFrom": ["src/**/*.{ts,js}"] to your Jest config so all source files are tracked.',
          'How to fix',
        );
        if (choice === 'How to fix') {
          await vscode.env.openExternal(
            vscode.Uri.parse('https://jestjs.io/docs/configuration#collectcoveragefrom-array'),
          );
        }
        return;
      }
      void vscode.window.showInformationMessage(
        `Covergeist: Scan complete — ${fileCount} file${fileCount === 1 ? '' : 's'} analysed. Uncovered lines are highlighted in red.`,
      );
    } catch (err) {
      if (controller.signal.aborted) {
        void vscode.window.showErrorMessage(
          'Coverage scan timed out after 60 seconds and was terminated.',
        );
      } else {
        await this.handleScanError(err as Error, runner);
      }
    } finally {
      clearTimeout(warnTimer);
      clearTimeout(killTimer);
    }
  }

  private async handleNoRunner(projectRoot: string): Promise<void> {
    const nested = this.findNestedRootsWithRunner(projectRoot);

    if (nested.length === 1) {
      const rel = path.relative(projectRoot, nested[0]);
      const choice = await vscode.window.showInformationMessage(
        `Covergeist found a test runner in '${rel}'. Open that folder to scan it.`,
        'Open Folder',
      );
      if (choice === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(nested[0]));
      }
      return;
    }

    if (nested.length > 1) {
      const labels = nested.map(r => path.relative(projectRoot, r));
      const pick = await vscode.window.showQuickPick(labels, {
        placeHolder: 'Multiple projects found — pick one to scan',
      });
      if (pick) {
        const selected = nested.find(r => path.relative(projectRoot, r) === pick);
        if (selected) {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(selected));
        }
      }
      return;
    }

    // No runner anywhere — offer to install one
    const choice = await vscode.window.showInformationMessage(
      'Covergeist: No test runner found. Add Jest or Vitest to get started.',
      'Set up Jest',
      'Set up Vitest',
    );
    if (!choice) return;

    const terminal = vscode.window.createTerminal('Covergeist Setup');
    terminal.show();
    if (choice === 'Set up Jest') {
      terminal.sendText('npm install --save-dev jest && npx jest --init');
    } else {
      terminal.sendText('npm install --save-dev vitest @vitest/coverage-v8');
    }
  }

  private async handleScanError(err: Error, runner: string): Promise<void> {
    if (err.message.includes('LCOV file not found')) {
      const choice = await vscode.window.showErrorMessage(
        'Coverage ran but produced no output. A coverage provider needs to be configured.',
        runner === 'jest' ? 'Fix Jest config' : 'Add coverage provider',
      );
      if (!choice) return;

      const terminal = vscode.window.createTerminal('Covergeist Setup');
      terminal.show();
      if (runner === 'jest') {
        terminal.sendText('npx jest --coverage --coverageReporters=lcov');
      } else {
        terminal.sendText('npm install --save-dev @vitest/coverage-v8');
      }
      return;
    }

    void vscode.window.showErrorMessage(`Coverage scan failed: ${err.message}`);
  }

  private findNestedRootsWithRunner(projectRoot: string, maxDepth = 2): string[] {
    const results: string[] = [];

    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        const sub = path.join(dir, entry.name);
        const pkgPath = path.join(sub, 'package.json');

        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
              dependencies?: Record<string, string>;
              devDependencies?: Record<string, string>;
              scripts?: Record<string, string>;
            };
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            const scripts = Object.values(pkg.scripts ?? {}).join(' ');
            const hasRunner =
              'jest' in allDeps || 'vitest' in allDeps ||
              scripts.includes('jest') || scripts.includes('vitest');

            if (hasRunner) {
              results.push(sub);
              continue; // Don't recurse into a found project root
            }
          } catch {
            // ignore malformed package.json
          }
        }

        walk(sub, depth + 1);
      }
    };

    walk(projectRoot, 1);
    return results;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
