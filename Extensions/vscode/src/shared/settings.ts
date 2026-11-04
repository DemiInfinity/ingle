// Shared settings, written by the Ingle Mac app to ~/.ingle/settings.json.
// The extension only reads it. If the file is missing, defaults below are used.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AssistantSettings {
  id: 'daily' | 'hard';
  name: string;            // "Ember" / "Flint"
  model: string;           // Ollama tag
  persona: string;         // the full character text
  contextLength: number;   // num_ctx
}

export interface IngleSettings {
  userName: string;
  assistants: AssistantSettings[];
  autocompleteModel: string;
  keepAlive: string;                 // e.g. "15m" or "-1m"
  serverURL: string;                 // e.g. "http://localhost:11434"
  enginePath: string;                // bundled `ollama` binary inside Ingle.app
  web: { onByDefault: boolean; provider: 'duckduckgo' | 'searxng' | 'brave'; searxngURL: string; braveKey: string };
  memory: { enabled: boolean; askFirst: boolean };
  workspaceFolders: string[];        // "~/Projects" style paths
  useClaudeSkills: boolean;
  smartMatching: boolean;
  /** MCP servers switched off in the Mac app. */
  mcpDisabled?: string[];
  /** Live MCP status from the Mac app, keyed by server name. */
  mcpStatus?: Record<string, { state: 'running' | 'starting' | 'stopped' | 'failed'; tools?: string[]; error?: string }>;
}

export const INGLE_HOME = path.join(os.homedir(), '.ingle');
export const paths = {
  home: INGLE_HOME,
  settings: path.join(INGLE_HOME, 'settings.json'),
  rules: path.join(INGLE_HOME, 'rules'),
  skills: path.join(INGLE_HOME, 'skills'),
  claudeSkills: path.join(os.homedir(), '.claude', 'skills'),
  memory: path.join(INGLE_HOME, 'memory'),
  research: path.join(INGLE_HOME, 'research'),
  mcp: path.join(INGLE_HOME, 'mcp.json'),
  manifest: path.join(INGLE_HOME, 'INGLE.md'),
  bridgeToken: path.join(INGLE_HOME, 'bridge-token'),
};

const DAILY_PERSONA = 'Warm, quick and to the point. Use British English. Be direct and honest: if something is a bad idea, say so and suggest something better. Keep answers short unless asked for detail, and prefer working code over long explanations.';
const HARD_PERSONA = 'Calm, careful and thorough. Use British English. Think problems through before answering, explain trade-offs plainly, and point out risks or edge cases that might have been missed.';

export const defaultSettings: IngleSettings = {
  userName: os.userInfo().username,
  assistants: [
    { id: 'daily', name: 'Ember', model: 'hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS', persona: DAILY_PERSONA, contextLength: 32768 },
    { id: 'hard', name: 'Flint', model: 'qwen3.8:27b-mlx', persona: HARD_PERSONA, contextLength: 32768 },
  ],
  autocompleteModel: 'qwen2.5-coder:1.5b-base',
  keepAlive: '15m',
  serverURL: 'http://localhost:11434',
  enginePath: '/Applications/Ingle.app/Contents/Resources/OllamaRuntime/ollama',
  web: { onByDefault: true, provider: 'duckduckgo', searxngURL: '', braveKey: '' },
  memory: { enabled: true, askFirst: false },
  workspaceFolders: ['~/Projects'],
  useClaudeSkills: true,
  smartMatching: true,
};

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Reads ~/.ingle/settings.json, filling anything missing from the defaults. Never throws. */
export function loadSettings(): IngleSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settings, 'utf8')) as Partial<IngleSettings>;
    return {
      ...defaultSettings,
      ...raw,
      assistants: raw.assistants?.length ? raw.assistants : defaultSettings.assistants,
      web: { ...defaultSettings.web, ...(raw.web ?? {}) },
      memory: { ...defaultSettings.memory, ...(raw.memory ?? {}) },
    };
  } catch {
    return defaultSettings;
  }
}

export function assistant(settings: IngleSettings, id: string): AssistantSettings {
  return settings.assistants.find((a) => a.id === id) ?? settings.assistants[0];
}
