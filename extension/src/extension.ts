import * as vscode from 'vscode';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { TypeScriptAdapter } from './adapters/typescript/TypeScriptAdapter';
import { CoverageService } from './coverage/CoverageService';
import { DecorationProvider } from './coverage/DecorationProvider';
import { CoverageSummaryProvider } from './coverage/CoverageSummaryProvider';

let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const registry = new AdapterRegistry();
  registry.register(new TypeScriptAdapter());

  const coverageService = new CoverageService(registry);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(pulse) Covergeist';
  statusBarItem.tooltip = 'Covergeist — click to run a coverage scan';
  statusBarItem.command = 'covergeist.runScan';
  statusBarItem.show();

  const decorationProvider = new DecorationProvider(coverageService, context);

  const summaryProvider = new CoverageSummaryProvider(coverageService);
  const summaryView = vscode.window.registerTreeDataProvider(
    'covergeist.summaryView',
    summaryProvider,
  );

  const runScanCommand = vscode.commands.registerCommand(
    'covergeist.runScan',
    async () => {
      const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectRoot) {
        void vscode.window.showInformationMessage(
          'Open a workspace folder to run a coverage scan.',
        );
        return;
      }
      await coverageService.runScan(projectRoot);
    },
  );

  context.subscriptions.push(
    statusBarItem,
    coverageService,
    decorationProvider,
    summaryProvider,
    summaryView,
    runScanCommand,
  );
}

export function deactivate(): void {
  statusBarItem?.dispose();
  statusBarItem = undefined;
}
