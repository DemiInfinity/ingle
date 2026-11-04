// Per-turn tool filtering (mirrors ToolSelection.swift on the Mac). Pure: the engine works out which tools
// are available and whether MCP is wanted, and this decides which of them the model sees this turn.
// Local models pick tools far less reliably as the list grows (≈85% right with 5 tools, ≈45% with 20),
// so optional tools are only offered when the message plausibly needs them.
import type { CommandEntry } from '../tools/commands';
import { wantsSSH } from '../tools/sshConfig';

/** Optional tools and the words in the user's message that make them worth offering. */
export const TOOL_WANTS: Record<string, RegExp> = {
  // Builder tools only when the user is talking about skills, rules or commands.
  skill_create: /skill|rule/,
  rule_create: /skill|rule/,
  command_create: /command/,
  read_document: /pdf|docx?\b|word doc|xlsx|excel|spreadsheet|document|\.pages|keynote|numbers file|rtf/,
  view_image: /image|screenshot|png|jpe?g|heic|gif|webp|picture|photo|diagram|mock-?up|icon/,
  open_url: /\bopen\b.*(url|link|browser|http|site|page)|https?:\/\//,
  secret_list: /secret|password|passcode|token|api[ _-]?key|credential|log ?in|auth|sign ?in/,
  memory_read: /remember|memory|memories|forget|about me|preference/,
  memory_rewrite: /remember|memory|memories|forget|about me|preference/,
  memory_forget: /remember|memory|memories|forget|about me|preference/,
};

/** Words that make the `delegate` (helper) tool worth offering. */
export const DELEGATE_WANTS = /research|compare|look into|investigate|summari[sz]e|find out|dig into|go through|sub-?agent|helper|in parallel|across (the|all)/;

export interface SelectableTool { name: string; readOnly: boolean }

export interface SelectionInput<T extends SelectableTool> {
  /** Tools already filtered by `available(ctx)`, without `delegate`. */
  available: T[];
  lastUser: string;
  isSubAgent: boolean;
  /** Active commands (only must_use and never_use are read). */
  active: Pick<CommandEntry, 'mustUse' | 'neverUse'>[];
  /** Names of the MCP tools (mcp_tools, mcp_call). */
  mcpToolNames: string[];
  /** Whether the message asks for MCP ("mcp" or a configured server's name). */
  mcpWanted: boolean;
  /** SSH hosts the model may use (empty when SSH is off). ssh_command is offered when the message mentions ssh,
   *  server, remote or one of these names. */
  sshHosts?: string[];
  delegate?: T;
}

export function selectTools<T extends SelectableTool>(input: SelectionInput<T>): T[] {
  const { available, isSubAgent, active, mcpToolNames, mcpWanted, delegate } = input;
  const t = input.lastUser.toLowerCase();
  // Commands: tools a must_use needs are always offered; never_use tools are removed.
  const forced = new Set<string>();
  const banned = new Set<string>();
  for (const c of active) {
    for (const r of c.mustUse) {
      if (r.kind === 'tool') forced.add(r.tool.toLowerCase());
      else if (r.kind === 'mcp') mcpToolNames.forEach((n) => forced.add(n));
    }
    for (const n of c.neverUse) if (!n.toLowerCase().startsWith('mcp:')) banned.add(n.trim().toLowerCase());
  }
  // Helpers: read-only tools only, and never_use applies to them too.
  if (isSubAgent) return available.filter((tool) => tool.readOnly && !banned.has(tool.name.toLowerCase()));
  const list = available.filter((tool) => {
    if (forced.has(tool.name)) return true;
    if (mcpToolNames.includes(tool.name)) return mcpWanted;
    if (tool.name === 'ssh_command') return wantsSSH(t, input.sshHosts ?? []);
    return !TOOL_WANTS[tool.name] || TOOL_WANTS[tool.name].test(t);
  });
  if (delegate && (forced.has('delegate') || DELEGATE_WANTS.test(t))) list.push(delegate);
  return list.filter((tool) => !banned.has(tool.name.toLowerCase()));
}
