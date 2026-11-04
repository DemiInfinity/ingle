// open_preview: show a file, rendered, beside the editor. No approval: it only shows a file the user could see anyway.
import { resolvePath, tidy } from './paths';
import { previewKind } from './previewCore';
import { str, type ToolDef } from './types';
import * as cp from 'child_process';

/** Set by extension.ts (the previewer lives in the UI layer). */
let opener: ((file: string) => Promise<string | undefined>) | undefined;
export function setPreviewOpener(fn: (file: string) => Promise<string | undefined>): void { opener = fn; }

/** Shows a file in the previewer. Why it couldn't, or undefined. */
export async function openInPreview(file: string): Promise<string | undefined> {
  return opener ? opener(file) : 'The previewer isn’t available here.';
}

function quarantined(file: string): boolean {
  if (process.platform !== 'darwin') return false;
  try { cp.execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { stdio: 'ignore' }); return true; } catch { return false; }
}

export const openPreviewTool: ToolDef = {
  name: 'open_preview',
  description: 'Show a file to the user, rendered, in a preview beside the editor: Markdown, HTML pages, SVG, images, PDF, CSV, JSON, YAML or code. Use it after writing a file the user will want to see.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] },
  readOnly: true,
  available: () => opener !== undefined,
  describe: (a) => ({ title: 'Show in the preview', detail: str(a, 'path'), icon: 'eye' }),
  async run(args, ctx) {
    const p = str(args, 'path');
    if (!p) return 'Give a file path, e.g. docs/plan.md.';
    const file = resolvePath(p, ctx.workspaceRoot);
    // Never auto-open HTML that came from the web.
    if (previewKind(file) === 'html' && quarantined(file)) {
      return `${tidy(file)} was downloaded from the web, so it isn’t opened automatically. Tell the user they can open it with Open Preview themselves (scripts start switched off).`;
    }
    if (!opener) return 'The previewer isn’t available here.';
    const problem = await opener(file);
    return problem ?? `Showing ${tidy(file)} in the preview beside the editor.`;
  },
};
