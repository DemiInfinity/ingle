// Steer while it works: messages typed during a run wait here and join the conversation at the model's next step.
// Pure (no vscode), tested in test/workflow.test.ts. Same rules as ChatStore.drainQueue in the Mac app.

export interface QueuedMessage { id: string; text: string }

/** Messages waiting per chat (so a background run in one chat never takes another chat's messages). */
export class SteerQueue {
  private readonly byChat = new Map<string, QueuedMessage[]>();

  push(chat: string, m: QueuedMessage): void {
    this.byChat.set(chat, [...(this.byChat.get(chat) ?? []), m]);
  }

  /** What's waiting, oldest first (for the UI). */
  peek(chat: string): QueuedMessage[] {
    return [...(this.byChat.get(chat) ?? [])];
  }

  /** Takes everything waiting for a chat, oldest first. */
  take(chat: string): QueuedMessage[] {
    const list = this.byChat.get(chat) ?? [];
    this.byChat.delete(chat);
    return list;
  }

  /** Removes one waiting message (the × on its chip). */
  remove(chat: string, id: string): boolean {
    const list = this.byChat.get(chat) ?? [];
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    if (next.length) this.byChat.set(chat, next); else this.byChat.delete(chat);
    return true;
  }

  has(chat: string): boolean {
    return (this.byChat.get(chat)?.length ?? 0) > 0;
  }
}

interface MessageShape { role: string; toolCalls?: unknown[] }

/** Whether a user message can go in now: not between a reply that called tools and those tools' results (the model
 *  API needs every tool result straight after the call). */
export function canInsertNow(messages: MessageShape[]): boolean {
  let tools = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') { tools++; continue; }
    if (m.role === 'assistant') return tools >= (m.toolCalls?.length ?? 0);
    return true;
  }
  return true;
}

/** How a queued message reads to the model (the chat shows it as typed). */
export function steerText(text: string): string {
  return `(Sent while you were working — take it into account from here.)\n${text}`;
}

/** Appends queued messages at a step boundary, oldest first, made by `make`. Returns how many went in (0 when it
 *  isn't a step boundary yet; they stay queued). */
export function insertQueued<T extends MessageShape>(messages: T[], queue: SteerQueue, chat: string, make: (q: QueuedMessage) => T): number {
  if (!queue.has(chat) || !canInsertNow(messages)) return 0;
  const list = queue.take(chat);
  for (const q of list) messages.push(make(q));
  return list.length;
}
