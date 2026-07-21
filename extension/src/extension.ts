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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- Auth ---
  const authService = new AuthService(context);
  await authService.initialize();

  const backendClient = new BackendClient(authService);

  // --- Coverage ---
  const registry = new AdapterRegistry();
  registry.register(new TypeScriptAdapter());
  const coverageService = new CoverageService(registry);

  // --- Status bar ---
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(pulse) Covergeist';
  statusBarItem.tooltip = 'Covergeist — click to run a coverage scan';
  statusBarItem.command = 'covergeist.runScan';
  statusBarItem.show();

  // --- Quota ---
  const quotaService = new QuotaService(backendClient, statusBarItem);

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

  // Helper: scan the current workspace
  const runScan = async (): Promise<void> => {
    const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!projectRoot) {
      void vscode.window.showInformationMessage('Open a workspace folder to run a coverage scan.');
      return;
    }
    await coverageService.runScan(projectRoot);
  };

  // --- Commands ---
  const runScanCommand = vscode.commands.registerCommand('covergeist.runScan', runScan);

  const generateTestCommand = vscode.commands.registerCommand(
    'covergeist.generateTest',
    async (document: vscode.TextDocument, range: vscode.Range) => {
      // Retry callback: called automatically when subscription activates
      const retry = (): void => {
        void vscode.commands.executeCommand('covergeist.generateTest', document, range);
      };

      // Step 1: auth + subscription checks — no spinner yet
      const snippet = await generationService.checkAndPrepare(document, range, retry);
      if (!snippet) return;

      // Step 2: AI call — spinner only shows here
      let result: Awaited<ReturnType<typeof generationService.generate>>;
      try {
        result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Covergeist: Generating test…', cancellable: false },
          () => generationService.generate(snippet),
        );
      } catch (err) {
        if (err instanceof NetworkError) {
          const msg = err.message.includes('504') || err.message.includes('timed out')
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

  const signInCommand = vscode.commands.registerCommand('covergeist.signIn', () => authService.signIn());
  const signOutCommand = vscode.commands.registerCommand('covergeist.signOut', () => authService.signOut());

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

  // --- Auto sign-in prompt & auto scan ---
  // Run scan immediately if already signed in, otherwise prompt to sign in
  if (authService.isSignedIn()) {
    await quotaService.refresh();
    void runScan();
  } else {
    const choice = await vscode.window.showInformationMessage(
      'Welcome to Covergeist! Sign in to generate tests for uncovered code.',
      'Sign In',
      'Later',
    );
    if (choice === 'Sign In') {
      void authService.signIn();
    }
  }

  // After sign-in: refresh quota and auto-run scan
  authService.onDidSignIn(async () => {
    await quotaService.refresh();
    void runScan();
  });
}

export function deactivate(): void { /* nothing */ }
