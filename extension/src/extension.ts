import * as vscode from 'vscode';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { TypeScriptAdapter } from './adapters/typescript/TypeScriptAdapter';
import { BackendClient } from './api/BackendClient';
import { AuthService } from './auth/AuthService';
import { CoverageSummaryProvider } from './coverage/CoverageSummaryProvider';
import { CoverageService } from './coverage/CoverageService';
import { DecorationProvider } from './coverage/DecorationProvider';
import { GenerateTestCodeActionProvider } from './generation/GenerateTestCodeActionProvider';
import { GenerationService } from './generation/GenerationService';
import { QuotaService } from './quota/QuotaService';

let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- Auth ---
  const authService = new AuthService(context);
  await authService.initialize(); // silently restore session from SecretStorage

  const backendClient = new BackendClient(authService);

  // Handle vscode://covergeist.covergeist/auth?code=…&state=… redirects
  const uriHandler = vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri): void {
      if (uri.path === '/auth') {
        void authService.handleCallback(uri);
      }
    },
  });

  // --- Coverage ---
  const registry = new AdapterRegistry();
  registry.register(new TypeScriptAdapter());
  const coverageService = new CoverageService(registry);

  // --- Status bar ---
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(pulse) Covergeist';
  statusBarItem.tooltip = 'Covergeist — click to run a coverage scan';
  statusBarItem.command = 'covergeist.runScan';
  statusBarItem.show();

  // --- Quota ---
  const quotaService = new QuotaService(backendClient, statusBarItem);
  await quotaService.refresh();

  // --- Generation ---
  const generationService = new GenerationService(authService, backendClient, registry);

  // --- UI providers ---
  const decorationProvider = new DecorationProvider(coverageService, context);
  const summaryProvider = new CoverageSummaryProvider(coverageService);
  const summaryView = vscode.window.registerTreeDataProvider(
    'covergeist.summaryView',
    summaryProvider,
  );

  // --- Commands ---
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

  const generateTestCommand = vscode.commands.registerCommand(
    'covergeist.generateTest',
    async (document: vscode.TextDocument, range: vscode.Range) => {
      await generationService.generateTest(document, range);
    },
  );

  const generateTestCodeActionProvider = vscode.languages.registerCodeActionsProvider(
    [
      { language: 'typescript' },
      { language: 'javascript' },
      { language: 'typescriptreact' },
      { language: 'javascriptreact' },
    ],
    new GenerateTestCodeActionProvider(coverageService),
    { providedCodeActionKinds: GenerateTestCodeActionProvider.providedCodeActionKinds },
  );

  const signInCommand = vscode.commands.registerCommand(
    'covergeist.signIn',
    () => authService.signIn(),
  );

  const signOutCommand = vscode.commands.registerCommand(
    'covergeist.signOut',
    () => authService.signOut(),
  );

  context.subscriptions.push(
    authService,
    uriHandler,
    coverageService,
    quotaService,
    statusBarItem,
    decorationProvider,
    summaryProvider,
    summaryView,
    runScanCommand,
    generateTestCommand,
    generateTestCodeActionProvider,
    signInCommand,
    signOutCommand,
  );
}

export function deactivate(): void {
  statusBarItem?.dispose();
  statusBarItem = undefined;
}
