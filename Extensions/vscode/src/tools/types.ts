// The contract every tool implements. The engine (src/engine) only talks to tools through this.
import type { IngleSettings } from '../shared/settings';
import type { ApprovalRequest } from '../shared/protocol';

export type ToolArgs = Record<string, unknown>;

/** What a tool returns when the user says no. Lives here (not paths.ts) so pure modules needn't load vscode. */
export const DENIED = "The user denied this action. Don't retry it; ask them what they'd like instead.";

export interface ToolContext {
  settings: IngleSettings;
  workspaceRoot?: string;          // the open folder in VS Code, if any
  web: boolean;                    // Web switch for this chat
  isSubAgent: boolean;             // helpers may only use readOnly tools
  /** Ask the user via the approval card. Resolves 'allow' or 'deny' ("always" is handled by the engine).
   *  `target` is the absolute path the approval is about (command folder, file, read path), used for its session scope. */
  requestApproval(req: Omit<ApprovalRequest, 'id' | 'sessionScope'>, target?: string): Promise<'allow' | 'deny'>;
  /** Short status for the activity line, e.g. "Searching the web…". */
  setActivity(text: string | null): void;
  /** Cancelled when the user presses Stop. */
  signal: AbortSignal;
  /** True if the current model can see images. Image tools can return OCR text instead when false. */
  vision: boolean;
}

/** A tool may return plain text, or text plus images (base64 JPEG/PNG, no data: prefix) for vision models.
 *  The engine sends images to the model when it can see them; otherwise it only sends the text. */
export interface ToolResult { text: string; images?: string[] }

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the arguments ({ type: 'object', properties, required }). */
  parameters: Record<string, unknown>;
  /** True if the tool never changes anything (helpers can use it). */
  readOnly: boolean;
  /** Whether to offer this tool in a given chat (e.g. web tools only when ctx.web). */
  available(ctx: ToolContext): boolean;
  /** Row shown in the chat: title, detail and codicon. */
  describe(args: ToolArgs): { title: string; detail: string; icon: string };
  /** Run it. Tools ask for approval themselves via ctx.requestApproval when needed, and return the
   *  result text for the model. They must never throw — return an error sentence instead. */
  run(args: ToolArgs, ctx: ToolContext): Promise<string | ToolResult>;
}

/** Ollama's tool format. */
export function toOllama(t: ToolDef): Record<string, unknown> {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

export function str(args: ToolArgs, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
