import * as vscode from 'vscode';
import type { GenerateResponse, SubscriptionResponse } from '@covergeist/shared';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { CodeSnippet } from '../adapters/LanguageAdapter';
import { QuotaError, SubscriptionError, NetworkError } from '../api/BackendClient';
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
    // First check the DB (fast). If not active, sync with Stripe in case the
    // webhook was missed — this lets users who already paid skip the prompt.
    let isActive = false;
    try {
      const sub = await this.client.get<SubscriptionResponse>('/v1/subscription');
      isActive = sub.status === 'active' || sub.status === 'trialing';
    } catch (err) {
      if (!(err instanceof SubscriptionError)) throw err;
    }

    if (!isActive) {
      try {
        const synced = await this.client.post<SubscriptionResponse>('/v1/subscription/sync', {});
        isActive = synced.status === 'active' || synced.status === 'trialing';
      } catch {
        // Sync failed — fall through to upgrade prompt
      }
    }

    if (!isActive) {
      await this.quotaService.showUpgradePrompt('no-subscription', onSubscribed);
      return null;
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
      if (err instanceof SubscriptionError) {
        // Quota middleware blocked the request — subscription exists but wasn't
        // reflected in the DB yet. Prompt sync + retry.
        await this.quotaService.showUpgradePrompt('no-subscription');
        return null;
      }
      if (err instanceof NetworkError) {
        const isTimeout =
          err.message.includes('llm_timeout') ||
          err.message.includes('timed out') ||
          err.message.includes('504');
        void vscode.window.showErrorMessage(
          isTimeout
            ? 'Covergeist: Generation timed out — please try again.'
            : `Covergeist: Generation failed — ${err.message}`,
        );
        return null;
      }
      throw err;
    }
  }
}
