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

  /**
   * Shows "quota exhausted" notification. On "Upgrade" click, opens the billing
   * page and starts polling GET /v1/subscription every 10 s (up to 5 min) so the
   * status bar updates automatically when the subscription becomes active.
   */
  async showUpgradePrompt(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "You've used all your generations this month. Upgrade to continue.",
      'Upgrade',
    );
    if (choice !== 'Upgrade') return;

    const billingUrl =
      vscode.workspace.getConfiguration('covergeist').get<string>('billingUrl') ??
      'https://covergeist.com/billing';
    await vscode.env.openExternal(vscode.Uri.parse(billingUrl));

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
        await this.refresh(); // refreshes status bar with new quota
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
