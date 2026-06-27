import * as vscode from 'vscode';
import type { CoverageService } from './CoverageService';

export class DecorationProvider implements vscode.Disposable {
  private readonly uncoveredDecoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly coverageService: CoverageService,
    context: vscode.ExtensionContext,
  ) {
    this.uncoveredDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath('assets/haunted.svg'),
      gutterIconSize: 'contain',
      backgroundColor: 'rgba(204, 68, 68, 0.07)',
      isWholeLine: true,
    });

    // Re-apply decorations when the user switches files
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) this.decorateEditor(editor);
      }),
    );

    // Refresh all visible editors when a new scan completes
    this.disposables.push(
      coverageService.onCoverageUpdated(() => {
        for (const editor of vscode.window.visibleTextEditors) {
          this.decorateEditor(editor);
        }
      }),
    );

    // Decorate whatever is already open when the provider is created
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorateEditor(editor);
    }
  }

  private decorateEditor(editor: vscode.TextEditor): void {
    try {
      const absolutePath = editor.document.uri.fsPath;
      const fileCoverage = this.coverageService.getCoverageForFile(absolutePath);

      if (!fileCoverage) {
        editor.setDecorations(this.uncoveredDecoration, []);
        return;
      }

      const uncoveredRanges: vscode.Range[] = [];
      for (const [lineNum, covered] of fileCoverage.lines) {
        if (!covered) {
          // LCOV lines are 1-indexed; VS Code ranges are 0-indexed
          const vscodeLine = lineNum - 1;
          uncoveredRanges.push(new vscode.Range(vscodeLine, 0, vscodeLine, 0));
        }
      }

      editor.setDecorations(this.uncoveredDecoration, uncoveredRanges);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Covergeist: failed to apply decorations — ${(err as Error).message}`,
      );
    }
  }

  dispose(): void {
    this.uncoveredDecoration.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
