import * as vscode from 'vscode';
import type { SubscriptionResponse } from '@covergeist/shared';
import type { AdapterRegistry } from '../adapters/AdapterRegistry';
import { SubscriptionError } from '../api/BackendClient';
import type { BackendClient } from '../api/BackendClient';
import type { AuthService } from '../auth/AuthService';

export class GenerationService {
  constructor(
    private readonly authService: AuthService,
    private readonly client: BackendClient,
    private readonly registry: AdapterRegistry,
  ) {}

  async generateTest(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
    // 1. Auth gate
    const token = await this.authService.getAccessToken();
    if (!token) {
      const choice = await vscode.window.showInformationMessage(
        'Sign in to Covergeist to generate tests.',
        'Sign In',
      );
      if (choice === 'Sign In') void this.authService.signIn();
      return;
    }

    // 2. Subscription gate — GET /v1/subscription returns {status:'none'} when not subscribed
    try {
      const sub = await this.client.get<SubscriptionResponse>('/v1/subscription');
      if (sub.status !== 'active' && sub.status !== 'trialing') {
        await this.showUpgradeMessage();
        return;
      }
    } catch (err) {
      if (err instanceof SubscriptionError) {
        await this.showUpgradeMessage();
        return;
      }
      throw err;
    }

    // 3. Resolve adapter and extract snippet
    const projectRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!projectRoot) return;

    const adapter = await this.registry.resolve(projectRoot);
    if (!adapter) return;

    await adapter.extractSnippet(document, range);
    // Story 3.2 will POST the snippet to /v1/generate and pass the result to Story 3.3
  }

  private async showUpgradeMessage(): Promise<void> {
    const billingUrl =
      vscode.workspace.getConfiguration('covergeist').get<string>('billingUrl') ??
      'https://covergeist.com/billing';
    const choice = await vscode.window.showInformationMessage(
      'Subscribe to Covergeist to generate tests.',
      'Upgrade',
    );
    if (choice === 'Upgrade') {
      await vscode.env.openExternal(vscode.Uri.parse(billingUrl));
    }
  }
}
