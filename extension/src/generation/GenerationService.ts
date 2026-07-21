import * as vscode from 'vscode';
import type { GenerateResponse, SubscriptionResponse } from '@covergeist/shared';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { CodeSnippet } from '../adapters/LanguageAdapter';
import { QuotaError, SubscriptionError } from '../api/BackendClient';
import type { BackendClient } from '../api/BackendClient';
import type { AuthService } from '../auth/AuthService';
import type { QuotaService } from '../quota/QuotaService';

export class GenerationService {
  constructor(
    private readonly authService: AuthService,
    private readonly client: BackendClient,
    private readonly registry: AdapterRegistry,
    private readonly quotaService: QuotaService,
  ) {}

  /**
   * Auth + subscription checks and snippet extraction.
   * No progress spinner — runs before the AI call.
   * Returns the snippet if ready to generate, null if blocked (prompt already shown).
   */
  async checkAndPrepare(
    document: vscode.TextDocument,
    range: vscode.Range,
    onSubscribed: () => void,
  ): Promise<CodeSnippet | null> {
    // 1. Auth gate
    const token = await this.authService.getAccessToken();
    if (!token) {
      const choice = await vscode.window.showInformationMessage(
        'Sign in to Covergeist to generate tests.',
        'Sign In',
      );
      if (choice === 'Sign In') void this.authService.signIn();
      return null;
    }

    // 2. Subscription gate
    try {
      const sub = await this.client.get<SubscriptionResponse>('/v1/subscription');
      if (sub.status !== 'active' && sub.status !== 'trialing') {
        await this.quotaService.showUpgradePrompt('no-subscription', onSubscribed);
        return null;
      }
    } catch (err) {
      if (err instanceof SubscriptionError) {
        await this.quotaService.showUpgradePrompt('no-subscription', onSubscribed);
        return null;
      }
      throw err;
    }

    // 3. Extract snippet
    const projectRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!projectRoot) return null;

    const adapter = await this.registry.resolve(projectRoot);
    if (!adapter) return null;

    return adapter.extractSnippet(document, range);
  }

  /**
   * The actual AI generation call — run this inside withProgress.
   */
  async generate(snippet: CodeSnippet): Promise<GenerateResponse | null> {
    try {
      return await this.client.post<GenerateResponse>('/v1/generate', { snippet });
    } catch (err) {
      if (err instanceof QuotaError) {
        await this.quotaService.showUpgradePrompt('quota-exhausted');
        return null;
      }
      throw err;
    }
  }
}
