import * as vscode from 'vscode';
import type { GenerateResponse, SubscriptionResponse } from '@covergeist/shared';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
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

  async generateTest(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): Promise<GenerateResponse | null> {
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

    // 2. Subscription gate — GET /v1/subscription returns {status:'none'} when not subscribed
    try {
      const sub = await this.client.get<SubscriptionResponse>('/v1/subscription');
      if (sub.status !== 'active' && sub.status !== 'trialing') {
        await this.quotaService.showUpgradePrompt();
        return null;
      }
    } catch (err) {
      if (err instanceof SubscriptionError) {
        await this.quotaService.showUpgradePrompt();
        return null;
      }
      throw err;
    }

    // 3. Resolve adapter and extract snippet
    const projectRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!projectRoot) return null;

    const adapter = await this.registry.resolve(projectRoot);
    if (!adapter) return null;

    const snippet = await adapter.extractSnippet(document, range);

    // 4. POST snippet to backend — handle quota exhaustion
    let result: GenerateResponse;
    try {
      result = await this.client.post<GenerateResponse>('/v1/generate', { snippet });
    } catch (err) {
      if (err instanceof QuotaError) {
        await this.quotaService.showUpgradePrompt();
        return null;
      }
      throw err;
    }

    return result;
  }

}
