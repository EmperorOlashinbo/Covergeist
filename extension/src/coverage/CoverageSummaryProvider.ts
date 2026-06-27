import * as path from 'path';
import * as vscode from 'vscode';
import type { CoverageMap } from '../adapters/LanguageAdapter';
import type { CoverageService } from './CoverageService';

export class CoverageSummaryProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: CoverageMap | null = null;
  private projectRoot: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(coverageService: CoverageService) {
    this.disposables.push(
      coverageService.onCoverageUpdated((map, root) => {
        this.cache = map;
        this.projectRoot = root;
        this._onDidChangeTreeData.fire();
      }),
    );
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (!this.cache || !this.projectRoot) {
      const item = new vscode.TreeItem('Run a scan to see coverage');
      item.iconPath = new vscode.ThemeIcon('play');
      item.command = { command: 'covergeist.runScan', title: 'Run Coverage Scan' };
      return [item];
    }

    const items: SummaryItem[] = [];

    for (const [absolutePath, fileCoverage] of this.cache.files) {
      const relPath = path
        .relative(this.projectRoot, absolutePath)
        .replace(/\\/g, '/');
      const total = fileCoverage.lines.size;
      const covered = [...fileCoverage.lines.values()].filter(Boolean).length;
      const pct = total > 0 ? Math.round((covered / total) * 100) : 100;
      items.push(new SummaryItem(relPath, pct, covered, total));
    }

    // Most uncovered files first so coverage gaps are immediately visible
    items.sort((a, b) => a.pct - b.pct);

    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

class SummaryItem extends vscode.TreeItem {
  constructor(
    relPath: string,
    readonly pct: number,
    covered: number,
    total: number,
  ) {
    super(relPath, vscode.TreeItemCollapsibleState.None);
    this.description = `${pct}%`;
    this.tooltip =
      total > 0 ? `${covered} / ${total} lines covered` : 'No tracked lines';
    this.iconPath =
      pct === 100
        ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconFailed'));
  }
}
