// Per-turn tool filtering (mirrors ToolSelection.swift on the Mac). Pure: the engine works out which tools
// are available and whether MCP is wanted, and this decides which of them the model sees this turn.
// Local models pick tools far less reliably as the list grows (≈85% right with 5 tools, ≈45% with 20),
// so optional tools are only offered when the message plausibly needs them.
import { bannedToolNames, requiredTools, type CommandEntry } from '../tools/commands';
import { wantsSSH } from '../tools/sshConfig';

/** Code intelligence (task 33b): offered in coding requests that need it — a named symbol (`backticks`, foo(),
 *  snake_case) or words about uses, callers, definitions, changes, errors or big files. Same patterns as
 *  ToolSelection.codeIntelWants in Swift. Patterns run on the lower-cased message. */
export const NAMES_SYMBOL = /`[^`\n]+`|\b[a-z_$][\w$]*\(\)|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
const USES = /\bcall(s|ed|ers?|ing)?\b|\buse[sd]\b|\busages?\b|\breferences?\b|\brefs\b|\bdefin|\bdeclar|\bwhere is\b|\bimpact|\baffect|\bdepend|\brename|\brefactor|\bsignature|\bshared\b/;
const CHANGES = /\bchang|\bmodif|\bupdat|\bremov|\bdelet|\breplac|\bbreak|\bsafe to\b/;
const either = (...res: RegExp[]): RegExp => new RegExp(res.map((r) => r.source).join('|'));
export const CODE_INTEL_WANTS: Record<string, RegExp> = {
  definition: either(USES, NAMES_SYMBOL),
  references: either(USES, NAMES_SYMBOL),
  callers: either(USES, NAMES_SYMBOL),
  impact: either(USES, CHANGES, NAMES_SYMBOL),
  callees: /\bcallees?\b|what (does|do) .{0,60}\bcall|\bcalls? (into|out)|call (graph|tree|chain)|\bdepend/,
  outline: /\boutline|\bstructure|\bsymbols?\b|what'?s in|\b(functions|methods|classes|types) in\b|\bskim/,
  diagnostics: /\berrors?\b|\bdiagnos|type[- ]?(check|error)|\bcompil|\bwarnings?\b|\bbroken\b|\bproblems?\b|squiggl|does it build|\blint/,
  read_exhaustively: /\blogs?\b|\bhuge\b|\bbig file|\blarge file|\bwhole file|\bentire file|\bevery line|exhaustiv|too (big|long|large)|all of (it|the file|this file)/,
};

/** Optional tools and the words in the user's message that make them worth offering. */
export const TOOL_WANTS: Record<string, RegExp> = {
  ...CODE_INTEL_WANTS,
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
  /** Active commands (only must_use, never_use and then_run are read). */
  active: (Pick<CommandEntry, 'mustUse' | 'neverUse'> & { thenRun?: string })[];
  /** Names of the MCP tools (mcp_tools, mcp_call). */
  mcpToolNames: string[];
  /** Whether the message asks for MCP ("mcp" or a configured server's name). */
  mcpWanted: boolean;
  /** SSH hosts the model may use (empty when SSH is off). ssh_command is offered when the message mentions ssh,
   *  server, remote or one of these names. */
  sshHosts?: string[];
  delegate?: T;
  /** From the effort level: strict (Low) drops the helper and repo_map unless asked; relaxed (High/Max) always
   *  offers the helper. Default normal. Same as ToolSelection.filter(strictness:) in Swift. */
  strictness?: 'strict' | 'normal' | 'relaxed';
}

/** Extra wants under strict filtering (Low effort): tools that are normally always offered. */
export const STRICT_WANTS: Record<string, RegExp> = {
  repo_map: /repo map|project structure|overview|codebase|architecture/,
  report_read: /report|research|earlier/,
  report_search: /report|research|earlier/,
};

export function selectTools<T extends SelectableTool>(input: SelectionInput<T>): T[] {
  const { available, isSubAgent, active, mcpToolNames, mcpWanted, delegate } = input;
  const strictness = input.strictness ?? 'normal';
  const t = input.lastUser.toLowerCase();
  // Commands: tools a must_use (or then_run) needs are always offered, from everything available; never_use
  // tools are removed (mcp: bans are blocked per call instead).
  const forced = requiredTools(active, mcpToolNames);
  const banned = bannedToolNames(active);
  // Helpers: read-only tools only, and never_use applies to them too.
  if (isSubAgent) return available.filter((tool) => tool.readOnly && !banned.has(tool.name.toLowerCase()));
  const list = available.filter((tool) => {
    if (forced.has(tool.name.toLowerCase())) return true;
    if (mcpToolNames.includes(tool.name)) return mcpWanted;
    if (tool.name === 'ssh_command') return wantsSSH(t, input.sshHosts ?? []);
    if (strictness === 'strict' && STRICT_WANTS[tool.name] && !STRICT_WANTS[tool.name].test(t)) return false;
    return !TOOL_WANTS[tool.name] || TOOL_WANTS[tool.name].test(t);
  });
  const wantsHelper = strictness === 'relaxed' || (strictness !== 'strict' && DELEGATE_WANTS.test(t));
  if (delegate && (forced.has('delegate') || wantsHelper)) list.push(delegate);
  return list.filter((tool) => !banned.has(tool.name.toLowerCase()));
}
