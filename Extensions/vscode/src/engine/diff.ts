// In-memory documents for diffs: ingle-diff:/<id>/<file name>.
import * as path from 'path';
import * as vscode from 'vscode';

export const DIFF_SCHEME = 'ingle-diff';

export class DiffProvider implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private counter = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? '';
  }

  /** Store text and return a URI that shows it (the file name keeps syntax colouring). */
  put(text: string, fileName: string): vscode.Uri {
    const p = `/${++this.counter}/${path.basename(fileName) || 'untitled'}`;
    this.docs.set(p, text);
    if (this.docs.size > 40) {
      const first = this.docs.keys().next().value;
      if (first !== undefined) this.docs.delete(first);
    }
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: p });
  }

  /** Opens VS Code's diff between a file on disk (or nothing) and proposed text. */
  async show(filePath: string | undefined, proposed: string, title: string, currentText?: string): Promise<void> {
    const name = filePath ? path.basename(filePath) : 'untitled';
    let left: vscode.Uri;
    if (currentText !== undefined) left = this.put(currentText, name);
    else if (filePath) left = vscode.Uri.file(filePath);
    else left = this.put('', name);
    const right = this.put(proposed, name);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }
}
