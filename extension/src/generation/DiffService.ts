import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();

  set(key: string, content: string): void {
    this.store.set(key, content);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.path) ?? '';
  }
}

export class DiffService implements vscode.Disposable {
  static readonly SCHEME = 'covergeist-diff';

  private readonly provider = new DiffContentProvider();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      DiffService.SCHEME,
      this.provider,
    );
  }

  async showDiff(
    workspaceRoot: string,
    test: string,
    suggestedTestFilePath: string,
  ): Promise<void> {
    const absolutePath = path.join(workspaceRoot, suggestedTestFilePath);

    let existing = '';
    try {
      existing = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      // File does not exist yet — left side will be blank
    }

    const proposed = existing ? `${existing}\n\n${test}` : test;

    const stamp = Date.now().toString();
    const beforeKey = `/before/${stamp}`;
    const afterKey = `/after/${stamp}`;
    const beforeUri = vscode.Uri.parse(`${DiffService.SCHEME}:/before/${stamp}`);
    const afterUri = vscode.Uri.parse(`${DiffService.SCHEME}:/after/${stamp}`);

    this.provider.set(beforeKey, existing);
    this.provider.set(afterKey, proposed);

    const title = `${path.basename(suggestedTestFilePath)} ↔ Generated (Covergeist)`;

    try {
      await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);

      const choice = await vscode.window.showInformationMessage(
        'Accept the generated test?',
        'Accept',
        'Reject',
      );

      if (choice === 'Accept') {
        // Implicit reject: if the user already closed the diff tab, do nothing
        if (!this.isDiffTabOpen(afterUri)) return;

        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, proposed, 'utf8');

        await this.closeDiffTab(afterUri);
        await vscode.commands.executeCommand('covergeist.runScan');
      } else {
        // Reject or notification dismissed — close the diff editor if still open
        await this.closeDiffTab(afterUri);
      }
    } finally {
      this.provider.delete(beforeKey);
      this.provider.delete(afterKey);
    }
  }

  private isDiffTabOpen(afterUri: vscode.Uri): boolean {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.toString() === afterUri.toString()
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private async closeDiffTab(afterUri: vscode.Uri): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.toString() === afterUri.toString()
        ) {
          await vscode.window.tabGroups.close(tab, false);
          return;
        }
      }
    }
  }

  dispose(): void {
    this.registration.dispose();
  }
}
