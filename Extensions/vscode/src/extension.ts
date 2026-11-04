import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatPanels } from './ui/chatView';
import { PreviewPanels } from './ui/previewPanel';
import { setPreviewOpener } from './tools/preview';
import { paths } from './shared/settings';

// Ingle for VS Code: a chat panel in the sidebar that talks to your local models directly,
// sharing ~/.ingle with the Ingle Mac app. If the Mac app is open, it's also told which
// project and file you're in (the old "bridge"), so its own chat window knows too.

type Diagnostic = { line: number; severity: 'error' | 'warning'; message: string };

let timer: NodeJS.Timeout | undefined;

function config() {
  return vscode.workspace.getConfiguration('ingle');
}

// MARK: Bridge to the Mac app (optional)

function token(): string | undefined {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.ingle', 'bridge-token'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

async function postToApp(route: string, body: unknown): Promise<void> {
  const secret = token();
  if (!secret) return;
  const port = config().get<number>('port', 47123);
  try {
    await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingle-Token': secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // The Mac app isn't open — that's fine, the sidebar chat doesn't need it.
  }
}

function diagnosticsFor(doc: vscode.TextDocument): Diagnostic[] {
  return vscode.languages
    .getDiagnostics(doc.uri)
    .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
    .slice(0, 20)
    .map((d) => ({
      line: d.range.start.line + 1,
      severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
      message: d.message,
    }));
}

function snapshot() {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  const folder = doc ? vscode.workspace.getWorkspaceFolder(doc.uri) : vscode.workspace.workspaceFolders?.[0];
  const selection =
    editor && doc && config().get<boolean>('shareSelection', true) && !editor.selection.isEmpty
      ? doc.getText(editor.selection).slice(0, 8000)
      : undefined;
  return {
    editor: 'VS Code',
    workspace: folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined,
    file: doc?.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
    language: doc?.languageId,
    selection,
    diagnostics: doc && config().get<boolean>('shareProblems', true) ? diagnosticsFor(doc) : undefined,
  };
}

function scheduleAppUpdate() {
  if (!config().get<boolean>('shareWithApp', true)) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void postToApp('/context', snapshot()), 400);
}

// MARK: Helpers for the editor commands

/** Twenty lines either side of a line, for context when nothing is selected. */
function around(doc: vscode.TextDocument, line: number): string {
  const start = Math.max(0, line - 21);
  const end = Math.min(doc.lineCount - 1, line + 19);
  return doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
}

function nearestProblem(editor: vscode.TextEditor): Diagnostic | undefined {
  const line = editor.selection.active.line + 1;
  const list = diagnosticsFor(editor.document);
  return list.find((d) => d.line === line) ?? list.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
}

function fileName(doc: vscode.TextDocument): string {
  return path.basename(doc.uri.fsPath || doc.uri.path) || 'selection';
}

// MARK: Activation

export function activate(context: vscode.ExtensionContext) {
  const tabs = new ChatPanels(context);
  // The previewer (task 39): plan cards, file links, open_preview and Ingle: Open Preview all use it.
  PreviewPanels.init(context);
  setPreviewOpener((file) => PreviewPanels.open(file));

  const problemCommand = (fix: boolean) => async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const problem = nearestProblem(editor);
    const line = problem?.line ?? editor.selection.active.line + 1;
    const text = problem
      ? `${fix ? 'Fix' : 'Explain'} this ${problem.severity} in ${fileName(editor.document)} on line ${problem.line}${fix ? '' : ' and how to fix it'}:\n${problem.message}`
      : `${fix ? 'Fix' : 'Explain'} any problems in this code.`;
    const engine = await tabs.reveal();
    await engine.ask(text, { name: `${fileName(editor.document)} (around line ${line})`, code: around(editor.document, line), language: editor.document.languageId }, true);
  };

  context.subscriptions.push(
    tabs,
    vscode.window.registerWebviewPanelSerializer(ChatPanels.viewType, tabs),

    vscode.commands.registerCommand('ingle.newTab', () => { tabs.openNew(); }),
    vscode.commands.registerCommand('ingle.focus', () => tabs.reveal()),
    vscode.commands.registerCommand('ingle.openPreview', async (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!file) return;
      const problem = await PreviewPanels.open(file);
      if (problem) void vscode.window.showWarningMessage('Ingle: ' + problem);
    }),
    vscode.commands.registerCommand('ingle.popOut', () => tabs.popOut()),
    vscode.commands.registerCommand('ingle.forgetApprovals', () => {
      const n = tabs.forgetApprovals();
      void vscode.window.showInformationMessage(n ? `Ingle will ask before every action again (cleared ${n}).` : 'Nothing was allowed for this session.');
    }),
    vscode.commands.registerCommand('ingle.newChat', async () => {
      const engine = await tabs.reveal();
      await engine.handle({ type: 'newChat' });
    }),
    vscode.commands.registerCommand('ingle.askSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { await tabs.reveal(); return; }
      const doc = editor.document;
      const code = editor.selection.isEmpty ? around(doc, editor.selection.active.line + 1) : doc.getText(editor.selection).slice(0, 12000);
      const engine = await tabs.reveal();
      await engine.ask('', { name: `${fileName(doc)} (selected)`, code, language: doc.languageId }, false);
    }),
    vscode.commands.registerCommand('ingle.explainProblem', problemCommand(false)),
    vscode.commands.registerCommand('ingle.fixProblem', problemCommand(true)),
    ...(['terms', 'privacy'] as const).map((doc) =>
      vscode.commands.registerCommand(`ingle.${doc}`, () =>
        vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'legal', doc === 'terms' ? 'TERMS.md' : 'PRIVACY.md')))),
    vscode.commands.registerCommand('ingle.about', async () => {
      const version = String((context.extension.packageJSON as { version?: unknown }).version ?? '');
      const pick = await vscode.window.showInformationMessage(
        `Ingle for VS Code ${version}. Powered by Ollama — the open-source engine by the Ollama team (MIT licence), built on llama.cpp and MLX. Free for personal, non-commercial use.`,
        'Terms of Use', 'Privacy', 'Licence', 'ollama.com');
      if (pick === 'Terms of Use') await vscode.commands.executeCommand('ingle.terms');
      else if (pick === 'Privacy') await vscode.commands.executeCommand('ingle.privacy');
      else if (pick === 'Licence') await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'legal', 'LICENSING.md'));
      else if (pick === 'ollama.com') await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
    }),
    vscode.commands.registerCommand('ingle.openHome', () => {
      fs.mkdirSync(paths.home, { recursive: true });
      return vscode.env.openExternal(vscode.Uri.file(paths.home));
    }),

    vscode.window.onDidChangeActiveTextEditor(scheduleAppUpdate),
    vscode.window.onDidChangeTextEditorSelection(scheduleAppUpdate),
    vscode.languages.onDidChangeDiagnostics(scheduleAppUpdate),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) scheduleAppUpdate();
    }),
  );
  scheduleAppUpdate();
}

export function deactivate() {
  if (timer) clearTimeout(timer);
}
