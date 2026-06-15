import * as vscode from 'vscode';
import type { CoverageService } from '../coverage/CoverageService';

export class GenerateTestCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly coverageService: CoverageService) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): Promise<vscode.CodeAction[]> {
    // Only show the action when there is coverage data and the range has uncovered lines
    const fileCoverage = this.coverageService.getCoverageForFile(document.uri.fsPath);
    if (!fileCoverage) return [];

    // LCOV line numbers are 1-indexed; VS Code range lines are 0-indexed
    let hasUncovered = false;
    for (let l = range.start.line + 1; l <= range.end.line + 1; l++) {
      if (fileCoverage.lines.get(l) === false) {
        hasUncovered = true;
        break;
      }
    }
    if (!hasUncovered) return [];

    // Look up the function name from the document symbol tree
    const functionName = await this.getFunctionNameAt(document, range);
    const title = functionName ? `Generate test for ${functionName}` : 'Generate test';

    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.command = {
      command: 'covergeist.generateTest',
      title,
      arguments: [document, range instanceof vscode.Selection ? range : range],
    };
    return [action];
  }

  private async getFunctionNameAt(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): Promise<string | null> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
      return this.findFunctionName(symbols ?? [], range) ?? null;
    } catch {
      return null;
    }
  }

  private findFunctionName(
    symbols: vscode.DocumentSymbol[],
    range: vscode.Range | vscode.Selection,
  ): string | undefined {
    const functionKinds = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor,
    ]);

    let best: vscode.DocumentSymbol | undefined;

    const search = (syms: vscode.DocumentSymbol[]): void => {
      for (const sym of syms) {
        if (sym.range.contains(range)) {
          if (
            functionKinds.has(sym.kind) &&
            (!best || sym.range.start.isAfter(best.range.start))
          ) {
            best = sym;
          }
          search(sym.children);
        }
      }
    };

    search(symbols);
    return best?.name;
  }
}
