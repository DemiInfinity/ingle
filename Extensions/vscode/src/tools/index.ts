// Every tool the chat can use. The engine adds `delegate` itself.
import { commandTools } from './command';
import { commandCreateTool } from './commands';
import { documentTools } from './documents';
import { fileTools } from './files';
import { knowledgeTools } from './knowledge';
import { mcpTools } from './mcp';
import { memoryTools } from './memory';
import { repoMapTool } from './repomap';
import { sshTools } from './ssh';
import type { ToolDef } from './types';
import { webTools } from './web';

export { DENIED } from './paths';
export { BUILDER_TOOLS } from './knowledge';
export { WEB_SYSTEM_PROMPT } from './web';
export { MEMORY_SYSTEM_PROMPT } from './stores';
export { pendingEditPreview } from './files';
export { enabledSSHHosts } from './ssh';

/** All tools, in the order they're offered. Filter with `available(ctx)` (and `readOnly` for helpers). */
export function allTools(): ToolDef[] {
  return [repoMapTool, ...fileTools, ...documentTools, ...commandTools, ...sshTools, ...webTools, ...memoryTools, ...knowledgeTools, commandCreateTool, ...mcpTools];
}

/** One tool by name. */
export function toolNamed(name: string): ToolDef | undefined {
  return allTools().find((t) => t.name === name);
}
