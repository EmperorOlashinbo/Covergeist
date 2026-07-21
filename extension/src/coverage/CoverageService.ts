import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { CoverageMap, FileCoverage } from '../adapters/LanguageAdapter';

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
        'Covergeist: No TypeScript or JavaScript files found in this folder.',
      );
      return;
    }

    try {
      const map = await adapter.analyzeStatically(projectRoot);
      this.cache = map;
      for (const listener of this.listeners) {
        listener(map, projectRoot);
      }

      const fileCount = map.files.size;
      if (fileCount === 0) {
        void vscode.window.showInformationMessage(
          'Covergeist: No source files with functions found. Make sure you have .ts or .js files in your project.',
        );
        return;
      }

      let uncovered = 0;
      let total = 0;
      for (const fc of map.files.values()) {
        for (const covered of fc.functions.values()) {
          total++;
          if (!covered) uncovered++;
        }
      }

      if (uncovered === 0) {
        void vscode.window.showInformationMessage(
          `Covergeist: All ${total} function${total === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'} appear to have tests.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          `Covergeist: Found ${uncovered} untested function${uncovered === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}. Red highlights show uncovered code.`,
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Covergeist: Scan failed — ${(err as Error).message}`,
      );
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
