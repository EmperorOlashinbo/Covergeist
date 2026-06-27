import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { CoverageMap, FileCoverage } from '../adapters/LanguageAdapter';

const WARN_THRESHOLD_MS = 30_000;
const KILL_THRESHOLD_MS = 60_000;

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
        'No supported language adapter found for this project.',
      );
      return;
    }

    const runner = await adapter.detectRunner(projectRoot);
    if (!runner) {
      void vscode.window.showInformationMessage(
        'No supported test runner detected. Configure Jest or Vitest in your project.',
      );
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
    } catch (err) {
      if (controller.signal.aborted) {
        void vscode.window.showErrorMessage(
          'Coverage scan timed out after 60 seconds and was terminated.',
        );
      } else {
        void vscode.window.showErrorMessage(
          `Coverage scan failed: ${(err as Error).message}`,
        );
      }
    } finally {
      clearTimeout(warnTimer);
      clearTimeout(killTimer);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
