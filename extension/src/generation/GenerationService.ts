import * as vscode from 'vscode';
import type { GenerateResponse, SubscriptionResponse } from '@covergeist/shared';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import type { CodeSnippet, FileSnippet } from '../adapters/LanguageAdapter';
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
   * Auth + subscription checks only. Returns true if cleared to generate.
   * Shows the appropriate prompt if not cleared.
   */
  async checkAuth(onSubscribed?: () => void): Promise<boolean> {
    // 1. Auth gate
    const token = await this.authService.getAccessToken();
    if (!token) {
      const choice = await vscode.window.showInformationMessage(
        'Sign in to Covergeist to generate tests.',
        'Sign In',
      );
      if (choice === 'Sign In') void this.authService.signIn();
      return false;
    }

    // 2. Subscription gate — check DB first, then sync with Stripe if not found
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
      return false;
    }

    return true;
  }

  /**
   * Auth + subscription checks and snippet extraction for a single function range.
   * No progress spinner — runs before the AI call.
   * Returns the snippet if ready to generate, null if blocked (prompt already shown).
   */
  async checkAndPrepare(
    document: vscode.TextDocument,
    range: vscode.Range,
    onSubscribed: () => void,
  ): Promise<CodeSnippet | null> {
    if (!(await this.checkAuth(onSubscribed))) return null;

    const projectRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!projectRoot) return null;

    const adapter = await this.registry.resolve(projectRoot);
    if (!adapter) return null;

    return adapter.extractSnippet(document, range);
  }

  /**
   * Single-function AI generation — run inside withProgress.
   */
  async generate(snippet: CodeSnippet): Promise<GenerateResponse | null> {
    return this.callGenerate('/v1/generate', { snippet });
  }

  /**
   * File-level AI generation — all uncovered functions in one call — run inside withProgress.
   */
  async generateForFile(fileSnippet: FileSnippet): Promise<GenerateResponse | null> {
    return this.callGenerate('/v1/generate-file', { fileSnippet });
  }

  private async callGenerate(path: string, body: unknown): Promise<GenerateResponse | null> {
    try {
      return await this.client.post<GenerateResponse>(path, body);
    } catch (err) {
      if (err instanceof QuotaError) {
        await this.quotaService.showUpgradePrompt('quota-exhausted');
        return null;
      }
      if (err instanceof SubscriptionError) {
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
