// ingle-code: the library entry point (what the VS Code extension imports).
export { CodeEngine } from './engine/engine';
export type { PageOpts } from './engine/engine';
export * from './engine/types';
export * from './engine/format';
export { TOOL_SPECS, TOOL_NAMES, callTool } from './engine/tools';
export type { ToolSpec, ToolOutput } from './engine/tools';
export { LANGUAGES, languageOf, isTestFile } from './engine/languages';
export { resolveOllamaHost } from './engine/exhaustive';
export { McpServer } from './mcp/server';
