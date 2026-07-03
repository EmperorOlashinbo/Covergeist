import * as vscode from 'vscode';
import type { QuotaResponse, SubscriptionResponse } from '@covergeist/shared';
import { AuthError, BackendClient, SubscriptionError } from '../api/BackendClient';

const POLL_INTERVAL_MS = 10_000;        // 10 seconds between subscription checks
const POLL_MAX_MS = 5 * 60 * 1_000;    // stop polling after 5 minutes

export class QuotaService implements vscode.Disposable {
  private lastQuota: QuotaResponse | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollStart = 0;

  constructor(
    private readonly client: BackendClient,
    private readonly statusBarItem: vscode.StatusBarItem,
  ) {}

  private async openCheckout(): Promise<void> {
    try {
      const { url } = await this.client.post<{ url: string }>(
        '/v1/billing/checkout',
        {},
      );
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err) {
      if (err instanceof AuthError) {
        // BackendClient already showed "Session expired — please sign in."
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `Covergeist: Could not start checkout — ${detail}`,
      );
    }
  }

  /** Fetches current quota and updates the status bar. Safe to call at any time. */
  async refresh(): Promise<void> {
    try {
      const quota = await this.client.get<QuotaResponse>('/v1/quota');
      this.lastQuota = quota;
      const remaining = quota.limit - quota.used;
      this.statusBarItem.text =
        `$(pulse) Covergeist: ${remaining} generation${remaining === 1 ? '' : 's'} left`;
    } catch (err) {
      if (err instanceof SubscriptionError) {
        this.lastQuota = null;
        this.statusBarItem.text = '$(pulse) Covergeist: Subscribe to generate tests';
      }
      // AuthError or NetworkError: leave status bar unchanged (no session or offline)
    }
  }

  /** True when the locally-cached quota shows remaining generations. */
  hasRemainingQuota(): boolean {
    return this.lastQuota !== null && this.lastQuota.used < this.lastQuota.limit;
  }

  getQuota(): QuotaResponse | null {
    return this.lastQuota;
  }

  async showUpgradePrompt(reason: 'no-subscription' | 'quota-exhausted' = 'quota-exhausted'): Promise<void> {
    const [message, button] =
      reason === 'no-subscription'
        ? ['Subscribe to Covergeist to generate tests.', 'Subscribe']
        : ["You've used all your generations this month. Upgrade to continue.", 'Upgrade'];

    const choice = await vscode.window.showInformationMessage(message, button);
    if (choice !== button) return;

    await this.openCheckout();
    this.startSubscriptionPolling();
  }

  dispose(): void {
    this.stopPolling();
  }

  // ── Subscription polling ────────────────────────────────────────────────────

  private startSubscriptionPolling(): void {
    this.stopPolling();
    this.pollStart = Date.now();
    this.pollTimer = setInterval(() => void this.pollSubscription(), POLL_INTERVAL_MS);
  }

  private async pollSubscription(): Promise<void> {
    if (Date.now() - this.pollStart > POLL_MAX_MS) {
      this.stopPolling();
      return;
    }
    try {
      const sub = await this.client.get<SubscriptionResponse>('/v1/subscription');
      if (sub.status === 'active') {
        this.stopPolling();
        await this.refresh();
        void vscode.window.showInformationMessage(
          'Covergeist: Subscription activated — you can now generate tests!',
        );
      }
    } catch (err) {
      if (err instanceof AuthError) this.stopPolling();
      // Ignore transient network errors — keep polling
    }
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
