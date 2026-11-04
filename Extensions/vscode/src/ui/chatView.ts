import * as vscode from 'vscode';
import { ChatEngine, EngineShared } from '../engine/chatEngine';
import type { FromWebview, ToWebview } from '../shared/protocol';

/**
 * One Ingle chat tab in the editor area. Each tab has its own engine (its own current chat, reply and
 * approvals); all tabs share the chat history and the Ollama engine.
 */
class ChatTab {
  readonly engine: ChatEngine;
  /** True once the page has sent 'ready' (its script is listening). */
  private ready = false;
  /** Things worth keeping that arrive before the page is listening; everything else is covered by 'init'. */
  private pendingPrefill?: string;
  private pendingApproval?: ToWebview;
  private pendingStatus?: ToWebview;

  constructor(
    readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    shared: EngineShared,
    private readonly extensionUri: vscode.Uri,
    chatId: string | undefined,
    onDispose: (tab: ChatTab) => void,
  ) {
    this.engine = new ChatEngine(context, shared, chatId);
    this.engine.setPoster((msg) => this.post(msg));
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'ingle-ember.svg');
    panel.webview.html = html(panel.webview, media);

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
      const msg = raw as FromWebview;
      if (msg.type === 'ready') {
        this.ready = true;
        this.post({ type: 'init', state: this.engine.state() });
        this.flushPending();
      }
      this.engine.handle(msg).catch((err: unknown) => {
        console.error('[Ingle] webview message failed', msg.type, err);
      });
    });

    panel.onDidDispose(() => {
      this.ready = false;
      this.engine.dispose();
      onDispose(this);
    });
  }

  private post(msg: ToWebview): void {
    // The tab is named after its chat, like Claude's.
    let title: string | undefined;
    if (msg.type === 'init') title = msg.state.chats.find((c) => c.id === msg.state.chatId)?.title;
    if (msg.type === 'chats') title = msg.chats.find((c) => c.id === msg.chatId)?.title;
    if (title !== undefined) this.panel.title = title && title !== 'New chat' ? title : 'Ingle';

    if (this.ready) {
      void this.panel.webview.postMessage(msg);
      return;
    }
    switch (msg.type) {
      case 'prefill': this.pendingPrefill = msg.text; break;
      case 'approval': case 'approvalClear': this.pendingApproval = msg; break;
      case 'status': this.pendingStatus = msg; break;
      default: break;
    }
  }

  private flushPending(): void {
    const w = this.panel.webview;
    if (this.pendingStatus) void w.postMessage(this.pendingStatus);
    if (this.pendingApproval && this.pendingApproval.type === 'approval') void w.postMessage(this.pendingApproval);
    if (this.pendingPrefill !== undefined) void w.postMessage({ type: 'prefill', text: this.pendingPrefill } satisfies ToWebview);
    this.pendingStatus = undefined;
    this.pendingApproval = undefined;
    this.pendingPrefill = undefined;
  }
}

/** All Ingle tabs. The Ingle icon in the editor title bar always opens another one. */
export class ChatPanels implements vscode.WebviewPanelSerializer, vscode.Disposable {
  static readonly viewType = 'ingle.chat';

  private readonly shared: EngineShared;
  private readonly tabs: ChatTab[] = [];
  /** The Ingle tab used last — editor commands ("Ask Ingle about this") go there. */
  private lastActive?: ChatTab;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.shared = new EngineShared(context);
  }

  /** A new Ingle tab with a new chat. The first opens beside your code; later ones join the Ingle tabs. */
  openNew(): ChatTab {
    const beside = vscode.workspace.getConfiguration('ingle').get<boolean>('openBeside', true);
    const column = this.lastActive?.panel.viewColumn ?? (beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
    const panel = vscode.window.createWebviewPanel(
      ChatPanels.viewType, 'Ingle', { viewColumn: column, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] },
    );
    return this.add(panel, undefined);
  }

  /** Focus the last Ingle tab, or open one. Returns its engine. */
  async reveal(): Promise<ChatEngine> {
    const tab = this.lastActive ?? this.tabs[this.tabs.length - 1];
    if (tab) {
      tab.panel.reveal(undefined, false);
      return tab.engine;
    }
    return this.openNew().engine;
  }

  /** Move the current Ingle tab into its own window. */
  async popOut(): Promise<void> {
    await this.reveal();
    try {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    } catch {
      void vscode.window.showInformationMessage('This version of VS Code can’t move tabs into a new window. Drag the Ingle tab out instead.');
    }
  }

  /** Brings Ingle tabs back after VS Code restarts, each with the chat it was showing. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const chatId = state && typeof state === 'object' && typeof (state as { chatId?: unknown }).chatId === 'string'
      ? (state as { chatId: string }).chatId : undefined;
    this.add(panel, chatId);
  }

  private add(panel: vscode.WebviewPanel, chatId: string | undefined): ChatTab {
    const tab = new ChatTab(panel, this.context, this.shared, this.context.extensionUri, chatId, (t) => {
      const i = this.tabs.indexOf(t);
      if (i >= 0) this.tabs.splice(i, 1);
      if (this.lastActive === t) this.lastActive = this.tabs[this.tabs.length - 1];
    });
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.lastActive = tab; });
    this.tabs.push(tab);
    this.lastActive = tab;
    return tab;
  }

  dispose(): void {
    for (const t of [...this.tabs]) t.panel.dispose();
    this.shared.dispose();
  }
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = makeNonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Ingle</title>
</head>
<body>
<div id="app" class="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
