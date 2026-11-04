// Chats for this workspace, saved in context.globalStorageUri/chats-<hash>.json (last 50).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, ChatSummary } from '../shared/protocol';
import type { RawToolCall } from './ollama';

/** A message as saved: the UI shape plus what's needed to replay it to Ollama. */
export interface StoredMessage extends ChatMessage {
  /** Raw tool_calls exactly as Ollama sent them (assistant messages). */
  toolCalls?: RawToolCall[];
  /** Base64 images sent with this message (user attachments, or images returned by a tool). */
  images?: string[];
}

export interface StoredChat {
  id: string;
  title: string;
  assistantId: string;
  messages: StoredMessage[];
  updated: number;
  web: boolean;
  think: boolean;
  useContext: boolean;
  usage?: { used: number; limit: number };
  /** True once the model has summarised the first message into a short title. */
  autoTitled?: boolean;
}

export const NEW_TITLE = 'New chat';
const MAX_CHATS = 50;

export function uid(): string {
  return crypto.randomUUID();
}

export class ChatStore {
  chats: StoredChat[] = [];
  private readonly file: string;
  private saveTimer?: NodeJS.Timeout;

  constructor(storageDir: string, workspaceKey: string) {
    const hash = crypto.createHash('sha1').update(workspaceKey).digest('hex').slice(0, 16);
    this.file = path.join(storageDir, `chats-${hash}.json`);
    try {
      fs.mkdirSync(storageDir, { recursive: true });
    } catch { /* ignore */ }
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        this.chats = (raw as StoredChat[]).filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages));
      }
    } catch {
      this.chats = [];
    }
  }

  get(id: string): StoredChat | undefined {
    return this.chats.find((c) => c.id === id);
  }

  create(assistantId: string, web: boolean, think: boolean): StoredChat {
    const chat: StoredChat = { id: uid(), title: NEW_TITLE, assistantId, messages: [], updated: Date.now(), web, think, useContext: true };
    this.chats.unshift(chat);
    return chat;
  }

  delete(id: string) {
    this.chats = this.chats.filter((c) => c.id !== id);
    this.save();
  }

  summaries(): ChatSummary[] {
    return this.chats
      .filter((c) => c.messages.length)
      .sort((a, b) => b.updated - a.updated)
      .map((c) => ({ id: c.id, title: c.title, updated: c.updated, assistantId: c.assistantId }));
  }

  /** Save soon (coalesces bursts while streaming). */
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 1500);
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const keep = this.chats
      .filter((c) => c.messages.length)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_CHATS);
    const keepIds = new Set(keep.map((c) => c.id));
    // Drop old chats from memory too (empty ones stay until used).
    this.chats = this.chats.filter((c) => keepIds.has(c.id) || !c.messages.length);
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(keep));
      fs.renameSync(tmp, this.file);
    } catch { /* best effort */ }
  }
}
