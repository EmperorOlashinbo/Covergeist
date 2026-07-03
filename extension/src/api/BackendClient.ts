import * as vscode from 'vscode';
import type { AuthService } from '../auth/AuthService';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class QuotaError extends Error {
  constructor(
    public readonly remaining: number,
    public readonly resetAt: string,
  ) {
    super('Monthly generation limit reached');
    this.name = 'QuotaError';
  }
}

export class SubscriptionError extends Error {
  constructor() {
    super('No active subscription');
    this.name = 'SubscriptionError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class BackendClient {
  constructor(private readonly authService: AuthService) {}

  private get apiUrl(): string {
    return (
      vscode.workspace.getConfiguration('covergeist').get<string>('apiUrl') ??
      'https://covergeist-production.up.railway.app'
    );
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false,
  ): Promise<T> {
    const token = await this.authService.getAccessToken();

    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new NetworkError(
        'Covergeist: backend unreachable — check your connection.',
      );
    }

    if (response.status === 401) {
      if (!isRetry) {
        const newToken = await this.authService.forceRefresh();
        if (newToken) {
          return this.request<T>(method, path, body, true);
        }
      }
      void vscode.window.showErrorMessage('Session expired — please sign in.');
      throw new AuthError('Session expired');
    }

    if (response.status === 402) {
      const payload = (await response.json()) as {
        remaining?: number;
        resetAt?: string;
      };
      throw new QuotaError(payload.remaining ?? 0, payload.resetAt ?? '');
    }

    if (response.status === 403) {
      throw new SubscriptionError();
    }

    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json() as { error?: string; detail?: string };
        detail = body.detail ?? body.error ?? '';
      } catch { /* ignore parse errors */ }
      throw new NetworkError(detail || `Request failed with status ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
