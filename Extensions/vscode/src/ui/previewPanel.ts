import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isTextKind, previewKind, resolveLocalLink, toggleTask, type PreviewKind } from '../tools/previewCore';

// Ingle's previewer in VS Code: the same page as the Mac app (Support/preview, copied to media/preview when the
// extension is compiled), in a webview beside the editor. One panel per file.
// Safety: a strict CSP with no network sources (only this extension's files and the file's own folder), HTML pages
// in a sandboxed frame (scripts only when switched on, never same-origin), and nothing fetched at runtime.

/** Downloaded files carry the quarantine flag: their pages start with JavaScript off. */
function fromWeb(file: string): boolean {
  if (process.platform !== 'darwin') return false;
  try { cp.execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { stdio: 'ignore' }); return true; } catch { return false; }
}

class PreviewPanel {
  readonly kind: PreviewKind;
  private js: boolean;
  private ready = false;
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private last = '';

  constructor(
    readonly file: string,
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly onDispose: () => void,
  ) {
    this.kind = previewKind(file);
    this.js = !fromWeb(file);
    const media = vscode.Uri.joinPath(extensionUri, 'media', 'preview');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [media, vscode.Uri.file(path.dirname(file))],
    };
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'tab-icon.png');
    panel.webview.html = this.html(media);
    panel.webview.onDidReceiveMessage((m: unknown) => { void this.received(m); });
    panel.onDidDispose(() => {
      this.watcher?.close();
      if (this.timer) clearTimeout(this.timer);
      this.onDispose();
    });
    // Watch the folder, not the file: an atomic save replaces the file, which would end a file watch.
    try {
      this.watcher = fs.watch(path.dirname(file), (_e, name) => {
        if (name && name.toString() !== path.basename(file)) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.render(), 120);
      });
    } catch { /* the folder can't be watched; Reload still works by reopening */ }
  }

  private html(media: vscode.Uri): string {
    const w = this.panel.webview;
    const root = w.asWebviewUri(media).toString() + '/';
    // No http(s) anywhere: pages can't call home or load trackers, and work offline.
    const inline = this.kind === 'html' && this.js ? " 'unsafe-inline'" : '';
    const csp = [
      "default-src 'none'",
      `script-src ${w.cspSource}${inline}`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `img-src ${w.cspSource} data: blob:`,
      `font-src ${w.cspSource} data:`,
      `media-src ${w.cspSource}`,
      "frame-src 'self' about: data: blob:",
      "form-action 'none'",
    ].join('; ');
    let page = '';
    try { page = fs.readFileSync(path.join(media.fsPath, 'index.html'), 'utf8'); } catch {
      return '<p style="font-family:sans-serif">The previewer’s files are missing. Rebuild the extension (npm run compile).</p>';
    }
    return page.split('{{CSP}}').join(csp).split('{{ROOT}}').join(root);
  }

  private async received(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as { type?: string; href?: string; index?: number; checked?: boolean; on?: boolean };
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.render(true);
        return;
      case 'toggle': {
        if (typeof m.index !== 'number' || typeof m.checked !== 'boolean') return;
        let text = '';
        try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
        const next = toggleTask(text, m.index, m.checked);
        if (next !== undefined) fs.writeFileSync(this.file, next);
        return;
      }
      case 'source':
        await vscode.window.showTextDocument(vscode.Uri.file(this.file), { preview: false, viewColumn: vscode.ViewColumn.Beside });
        return;
      case 'js':
        this.js = !!m.on;
        // The CSP allows inline page scripts only while JavaScript is on, so rebuild the page.
        this.ready = false;
        this.panel.webview.html = this.html(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview'));
        return;
      case 'open': {
        const href = m.href ?? '';
        const local = resolveLocalLink(href, path.dirname(this.file));
        if (local) { await PreviewPanels.open(local); return; }
        if (/^(https?|mailto):/i.test(href)) {
          const go = await vscode.window.showInformationMessage(`Open this link in your browser?\n${href}`, { modal: true }, 'Open');
          if (go === 'Open') await vscode.env.openExternal(vscode.Uri.parse(href));
        }
        return;
      }
    }
  }

  /** Sends the file to the page (skipped when nothing changed, unless forced). */
  render(force = false) {
    if (!this.ready) return;
    let text = '';
    const missing = !fs.existsSync(this.file);
    if (!missing && isTextKind(this.kind) && this.kind !== 'svg') {
      try { text = fs.readFileSync(this.file, 'utf8'); } catch { /* shown empty */ }
    }
    let stamp = '';
    try { stamp = String(fs.statSync(this.file).mtimeMs); } catch { /* gone */ }
    const key = stamp + '\n' + text + '\n' + this.js;
    if (!force && key === this.last) return;
    this.last = key;
    const base = this.panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(this.file))).toString() + '/';
    const payload = missing
      ? { type: 'render', kind: 'markdown', name: path.basename(this.file), text: `*${path.basename(this.file)} isn’t there any more.*`, base, chrome: 'vscode' }
      : {
          type: 'render', kind: this.kind, name: path.basename(this.file), text, base, stamp,
          lang: path.extname(this.file).slice(1).toLowerCase(), editable: isWritable(this.file), chrome: 'vscode', js: this.js,
        };
    void this.panel.webview.postMessage(payload);
  }
}

function isWritable(file: string): boolean {
  try { fs.accessSync(file, fs.constants.W_OK); return true; } catch { return false; }
}

/** All preview panels. `PreviewPanels.open(file)` is the one way the extension shows a file in the previewer. */
export class PreviewPanels {
  static readonly viewType = 'ingle.preview';
  private static extensionUri?: vscode.Uri;
  private static panels = new Map<string, PreviewPanel>();

  static init(context: vscode.ExtensionContext) {
    PreviewPanels.extensionUri = context.extensionUri;
  }

  /** Opens (or brings forward) a preview of `file` beside the editor. Returns why it couldn't, or undefined. */
  static async open(file: string): Promise<string | undefined> {
    const abs = path.resolve(file);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { return `${abs} doesn’t exist.`; }
    if (stat.isDirectory()) return `${abs} is a folder; the preview shows files.`;
    if (previewKind(abs) === 'pdf') {
      // VS Code's webviews have no PDF viewer: hand PDFs to the Mac's default app.
      await vscode.env.openExternal(vscode.Uri.file(abs));
      return undefined;
    }
    const existing = PreviewPanels.panels.get(abs);
    if (existing) { existing.panel.reveal(undefined, true); return undefined; }
    if (!PreviewPanels.extensionUri) return 'The previewer isn’t ready yet.';
    const panel = vscode.window.createWebviewPanel(PreviewPanels.viewType, path.basename(abs),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    PreviewPanels.panels.set(abs, new PreviewPanel(abs, panel, PreviewPanels.extensionUri, () => PreviewPanels.panels.delete(abs)));
    return undefined;
  }
}
