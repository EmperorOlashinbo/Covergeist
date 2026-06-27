import * as vscode from 'vscode';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { TypeScriptAdapter } from './adapters/typescript/TypeScriptAdapter';
import { BackendClient, NetworkError } from './api/BackendClient';
import { AuthService } from './auth/AuthService';
import { CoverageSummaryProvider } from './coverage/CoverageSummaryProvider';
import { CoverageService } from './coverage/CoverageService';
import { DecorationProvider } from './coverage/DecorationProvider';
import { DiffService } from './generation/DiffService';
import { GenerateTestCodeActionProvider } from './generation/GenerateTestCodeActionProvider';
import { GenerationService } from './generation/GenerationService';
import { QuotaService } from './quota/QuotaService';

let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- Auth ---
  const authService = new AuthService(context);
  await authService.initialize(); // silently restore session from SecretStorage

  const backendClient = new BackendClient(authService);

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

  // Refresh quota whenever a session is established (sign-in or token restore)
  authService.onDidSignIn(() => void quotaService.refresh());

  // --- Generation ---
  const generationService = new GenerationService(authService, backendClient, registry, quotaService);
  const diffService = new DiffService();

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
      // Progress notification covers only the API call — dismissed before the diff opens
      let result: Awaited<ReturnType<typeof generationService.generateTest>>;
      try {
        result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Covergeist: Generating test…', cancellable: false },
          () => generationService.generateTest(document, range),
        );
      } catch (err) {
        if (err instanceof NetworkError) {
          const msg = err.message.includes('504')
            ? 'Generation timed out — please try again.'
            : err.message;
          void vscode.window.showErrorMessage(msg);
          return;
        }
        throw err;
      }

      if (!result) return;

      const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      if (!workspaceRoot) return;

      await diffService.showDiff(workspaceRoot, result.test, result.suggestedTestFilePath);
      void quotaService.refresh();
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
    coverageService,
    quotaService,
    statusBarItem,
    decorationProvider,
    summaryProvider,
    summaryView,
    diffService,
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
