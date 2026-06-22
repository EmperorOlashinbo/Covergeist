import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';

const AUTH_CALLBACK_PORT = 7654;
const REDIRECT_URI = `http://127.0.0.1:${AUTH_CALLBACK_PORT}/auth`;
const REFRESH_TOKEN_KEY = 'covergeist.refreshToken';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface AuthConfig {
  oauthClientId: string;
  frontendApiUrl: string;
}

function getClerkConfig(): AuthConfig {
  const cfg = vscode.workspace.getConfiguration('covergeist');
  return {
    oauthClientId: cfg.get<string>('clerkOAuthClientId') ?? '',
    frontendApiUrl: cfg.get<string>('clerkFrontendApiUrl') ?? '',
  };
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function fetchToken(url: string, params: Record<string, string>): Promise<TokenResponse> {
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
  private callbackServer: http.Server | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

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

  async signIn(): Promise<void> {
    const { oauthClientId, frontendApiUrl } = getClerkConfig();
    if (!oauthClientId || !frontendApiUrl) {
      void vscode.window.showErrorMessage(
        'Covergeist: Auth is not configured. Check covergeist.clerkOAuthClientId and covergeist.clerkFrontendApiUrl settings.',
      );
      return;
    }

    // Close any previously abandoned flow
    this.callbackServer?.close();
    this.callbackServer = null;

    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = crypto.randomBytes(16).toString('hex');

    this.pendingVerifier = verifier;
    this.pendingState = state;

    // Start local callback server before opening the browser so the redirect lands
    await this.startCallbackServer(frontendApiUrl, oauthClientId);

    const url = new URL(`${frontendApiUrl}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oauthClientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);

    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  }

  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
      return this.accessToken;
    }
    return this.forceRefresh();
  }

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
    this.callbackServer?.close();
    this.callbackServer = null;
  }

  private startCallbackServer(frontendApiUrl: string, oauthClientId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let timeoutHandle: ReturnType<typeof setTimeout>;

      const server = http.createServer((req, res) => {
        clearTimeout(timeoutHandle);

        const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${AUTH_CALLBACK_PORT}`);
        if (reqUrl.pathname !== '/auth') {
          res.writeHead(404);
          res.end();
          return;
        }

        server.close();
        this.callbackServer = null;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body style="font-family:sans-serif;padding:2rem">' +
          '<h2>Signed in to Covergeist ✓</h2>' +
          '<p>You can close this tab and return to VS Code.</p>' +
          '</body></html>',
        );

        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');
        void this.exchangeCode(code, state, frontendApiUrl, oauthClientId);
      });

      this.callbackServer = server;

      timeoutHandle = setTimeout(() => {
        server.close();
        this.callbackServer = null;
        this.pendingVerifier = null;
        this.pendingState = null;
      }, CALLBACK_TIMEOUT_MS);

      server.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });

      server.listen(AUTH_CALLBACK_PORT, '127.0.0.1', () => resolve());
    });
  }

  private async exchangeCode(
    code: string | null,
    state: string | null,
    frontendApiUrl: string,
    oauthClientId: string,
  ): Promise<void> {
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
      const tokens = await fetchToken(`${frontendApiUrl}/oauth/token`, {
        grant_type: 'authorization_code',
        client_id: oauthClientId,
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

  private async performRefresh(refreshToken: string): Promise<void> {
    const { frontendApiUrl, oauthClientId } = getClerkConfig();
    const tokens = await fetchToken(`${frontendApiUrl}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: oauthClientId,
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
