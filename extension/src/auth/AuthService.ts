import * as crypto from 'crypto';
import * as vscode from 'vscode';

// vscode://covergeist.covergeist/auth  (publisher.extensionName/path)
const REDIRECT_URI = 'vscode://covergeist.covergeist/auth';
const REFRESH_TOKEN_KEY = 'covergeist.refreshToken';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface AuthConfig {
  publishableKey: string;
  frontendApiUrl: string;
}

function getClerkConfig(): AuthConfig {
  const cfg = vscode.workspace.getConfiguration('covergeist');
  return {
    publishableKey: cfg.get<string>('clerkPublishableKey') ?? '',
    frontendApiUrl: cfg.get<string>('clerkFrontendApiUrl') ?? '',
  };
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function fetchToken(
  url: string,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }
  return response.json() as Promise<TokenResponse>;
}

export class AuthService implements vscode.Disposable {
  private accessToken: string | null = null;
  private accessTokenExpiry = 0;
  private pendingVerifier: string | null = null;
  private pendingState: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Called once on activate — silently restores session from SecretStorage. */
  async initialize(): Promise<void> {
    const refreshToken = await this.context.secrets.get(REFRESH_TOKEN_KEY);
    if (refreshToken) {
      try {
        await this.performRefresh(refreshToken);
      } catch {
        // Refresh token expired or invalid; user will be prompted on next generation
      }
    }
  }

  /** Opens Clerk's PKCE authorization page in the default browser. */
  async signIn(): Promise<void> {
    const { publishableKey, frontendApiUrl } = getClerkConfig();
    if (!publishableKey || !frontendApiUrl) {
      void vscode.window.showErrorMessage(
        'Covergeist: Auth is not configured. Check covergeist.clerkPublishableKey and covergeist.clerkFrontendApiUrl settings.',
      );
      return;
    }

    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = crypto.randomBytes(16).toString('hex');

    this.pendingVerifier = verifier;
    this.pendingState = state;

    const url = new URL(`${frontendApiUrl}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', publishableKey);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);

    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  }

  /** Handles the vscode://covergeist.covergeist/auth?code=…&state=… redirect. */
  async handleCallback(uri: vscode.Uri): Promise<void> {
    const params = new URLSearchParams(uri.query);
    const code = params.get('code');
    const state = params.get('state');

    if (!code || state !== this.pendingState) {
      void vscode.window.showErrorMessage(
        'Covergeist: Authentication failed — invalid callback parameters.',
      );
      return;
    }

    const verifier = this.pendingVerifier;
    this.pendingVerifier = null;
    this.pendingState = null;

    if (!verifier) {
      void vscode.window.showErrorMessage(
        'Covergeist: Authentication failed — no pending sign-in flow found.',
      );
      return;
    }

    try {
      const { frontendApiUrl, publishableKey } = getClerkConfig();
      const tokens = await fetchToken(`${frontendApiUrl}/oauth/token`, {
        grant_type: 'authorization_code',
        client_id: publishableKey,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });

      this.storeTokens(tokens);
      await this.context.secrets.store(REFRESH_TOKEN_KEY, tokens.refresh_token ?? '');
      void vscode.window.showInformationMessage('Covergeist: Signed in successfully.');
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Covergeist: Sign-in failed — ${(err as Error).message}`,
      );
    }
  }

  /**
   * Returns a valid access token, transparently refreshing if the current one
   * has expired. Returns null when there is no session.
   */
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
      return this.accessToken;
    }
    return this.forceRefresh();
  }

  /**
   * Forces a token refresh. Used by BackendClient when it receives a 401.
   * Returns the new access token, or null if the refresh fails.
   */
  async forceRefresh(): Promise<string | null> {
    const refreshToken = await this.context.secrets.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) return null;
    try {
      await this.performRefresh(refreshToken);
      return this.accessToken;
    } catch {
      return null;
    }
  }

  async signOut(): Promise<void> {
    this.accessToken = null;
    this.accessTokenExpiry = 0;
    await this.context.secrets.delete(REFRESH_TOKEN_KEY);
  }

  isSignedIn(): boolean {
    return this.accessToken !== null && Date.now() < this.accessTokenExpiry;
  }

  dispose(): void {
    // nothing to release — secrets are managed by VS Code
  }

  private async performRefresh(refreshToken: string): Promise<void> {
    const { frontendApiUrl, publishableKey } = getClerkConfig();
    const tokens = await fetchToken(`${frontendApiUrl}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: publishableKey,
      refresh_token: refreshToken,
    });
    this.storeTokens(tokens);
    if (tokens.refresh_token) {
      await this.context.secrets.store(REFRESH_TOKEN_KEY, tokens.refresh_token);
    }
  }

  private storeTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token;
    this.accessTokenExpiry = Date.now() + tokens.expires_in * 1_000;
  }
}
