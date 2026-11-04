// Minimal client for the local Ollama HTTP API (global fetch, no dependencies).

export interface RawToolCall {
  function?: { name?: string; arguments?: unknown };
  [key: string]: unknown;
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: RawToolCall[];
  tool_name?: string;
  images?: string[];
}

export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: Record<string, unknown>[];
  /** false = no thinking; true or a level ("low" | "medium" | "high", for models that take levels — see effort.ts). */
  think: Think;
  numCtx: number;
  keepAlive: string;
}

export interface ChatHandlers {
  onContent?(text: string): boolean | void;
  onThinking?(text: string): boolean | void;
  onThinkingLoop?(): void;
}

export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: RawToolCall[];
  evalCount: number;
  evalDuration: number; // nanoseconds
  thinkingLoopStopped?: boolean;
}

/** Detect four consecutive copies of a 24–256 character phrase, using a bounded tail. */
export class ThinkingRepeatGuard {
  private tail = '';

  push(text: string): boolean {
    this.tail = (this.tail + text).slice(-2048);
    const n = this.tail.length;
    for (let period = 24; period <= Math.min(256, Math.floor(n / 4)); period++) {
      const last = this.tail.slice(n - period);
      if (this.tail.slice(n - 2 * period, n - period) !== last) continue;
      if (this.tail.slice(n - 3 * period, n - 2 * period) !== last) continue;
      if (this.tail.slice(n - 4 * period, n - 3 * period) === last) return true;
    }
    return false;
  }
}

/** Ollama's `think`: on/off, or a level for models that take one (gpt-oss). */
export type Think = boolean | 'low' | 'medium' | 'high';

export class OllamaError extends Error {}
class ThinkUnsupported extends Error {}

function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; done(): void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort);
  return {
    signal: ctl.signal,
    done() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

function errorText(body: string): string {
  try {
    const obj = JSON.parse(body) as { error?: unknown };
    if (typeof obj.error === 'string') return obj.error;
  } catch {
    /* not JSON */
  }
  return body.trim() || 'Unknown error';
}

export class OllamaClient {
  readonly base: string;

  constructor(base: string) {
    this.base = (base || 'http://localhost:11434').replace(/\/+$/, '');
  }

  private url(p: string): string {
    return `${this.base}/${p}`;
  }

  /** The server version, or null if it doesn't answer in time. */
  async version(timeoutMs = 1500): Promise<string | null> {
    const t = timeoutSignal(timeoutMs);
    try {
      const res = await fetch(this.url('api/version'), { signal: t.signal });
      if (!res.ok) return null;
      const obj = (await res.json()) as { version?: string };
      return obj.version ?? '';
    } catch {
      return null;
    } finally {
      t.done();
    }
  }

  /** Installed model tags (empty on error). */
  async tags(timeoutMs = 3000): Promise<string[]> {
    const t = timeoutSignal(timeoutMs);
    try {
      const res = await fetch(this.url('api/tags'), { signal: t.signal });
      if (!res.ok) return [];
      const obj = (await res.json()) as { models?: { name?: string }[] };
      return (obj.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    } catch {
      return [];
    } finally {
      t.done();
    }
  }

  /** Model capabilities from /api/show (e.g. ["completion","tools","vision","thinking"]), or null on error. */
  async capabilities(model: string, timeoutMs = 4000): Promise<string[] | null> {
    const t = timeoutSignal(timeoutMs);
    try {
      const res = await fetch(this.url('api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: t.signal,
      });
      if (!res.ok) return null;
      const obj = (await res.json()) as { capabilities?: unknown };
      return Array.isArray(obj.capabilities) ? obj.capabilities.map(String) : [];
    } catch {
      return null;
    } finally {
      t.done();
    }
  }

  async embed(model: string, input: string[], timeoutMs = 20000): Promise<number[][] | null> {
    const t = timeoutSignal(timeoutMs);
    try {
      const res = await fetch(this.url('api/embed'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input, keep_alive: '5m' }),
        signal: t.signal,
      });
      if (!res.ok) return null;
      const obj = (await res.json()) as { embeddings?: number[][] };
      return Array.isArray(obj.embeddings) ? obj.embeddings : null;
    } catch {
      return null;
    } finally {
      t.done();
    }
  }

  /** Streaming /api/chat. If the model rejects `think` (only before anything was streamed): a level is retried
   *  as plain `true`, then without `think` at all. Same as OllamaClient.chat in Swift. */
  async chat(req: ChatRequest, signal: AbortSignal, handlers: ChatHandlers = {}): Promise<ChatResult> {
    const tries: (Think | undefined)[] = typeof req.think === 'string' ? [req.think, true, undefined] : [req.think, undefined];
    for (let i = 0; ; i++) {
      try {
        const result = await this.stream(req, tries[i], signal, handlers);
        if (result.thinkingLoopStopped) {
          handlers.onThinkingLoop?.();
          const messages = [...req.messages];
          if (result.thinking) {
            messages.push({ role: 'assistant', content: 'My previous thinking before it started repeating (incomplete context; do not repeat it):\n' + result.thinking.slice(-3000) });
          }
          messages.push({ role: 'user', content: 'Your previous response started repeating its reasoning before answering. Stop thinking and answer the original request directly now, using the conversation above and any useful context. Be concise and do not repeat the loop.' });
          const fallback = await this.stream({ ...req, messages, think: false }, false, signal, handlers);
          if (fallback.thinkingLoopStopped) handlers.onThinkingLoop?.();
          return fallback;
        }
        return result;
      } catch (e) {
        if (!(e instanceof ThinkUnsupported) || i >= tries.length - 1) throw e;
      }
    }
  }

  private async stream(req: ChatRequest, think: Think | undefined, signal: AbortSignal, h: ChatHandlers): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      keep_alive: req.keepAlive,
      options: tuning(req.model, !!req.think, req.numCtx),
    };
    if (think !== undefined) body.think = think;
    if (req.tools && req.tools.length) body.tools = req.tools;

    const res = await fetch(this.url('api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const message = errorText(await res.text().catch(() => ''));
      if (think !== undefined && /think/i.test(message)) throw new ThinkUnsupported(message);
      throw new OllamaError(message);
    }

    const result: ChatResult = { content: '', thinking: '', toolCalls: [], evalCount: 0, evalDuration: 0 };
    let emitted = false;
    let finished = false;
    const handleLine = (line: string) => {
      let obj: {
        error?: unknown;
        message?: { content?: string; thinking?: string; tool_calls?: RawToolCall[] };
        done?: boolean;
        eval_count?: number;
        eval_duration?: number;
      };
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof obj.error === 'string') {
        if (!emitted && think !== undefined && /think/i.test(obj.error)) throw new ThinkUnsupported(obj.error);
        throw new OllamaError(obj.error);
      }
      const m = obj.message;
      if (m) {
        if (m.thinking) {
          emitted = true;
          result.thinking += m.thinking;
          if (h.onThinking?.(m.thinking)) {
            result.thinkingLoopStopped = true;
            finished = true;
            return;
          }
        }
        if (m.content) {
          emitted = true;
          result.content += m.content;
          if (h.onContent?.(m.content)) {
            result.thinkingLoopStopped = true;
            finished = true;
            return;
          }
        }
        if (Array.isArray(m.tool_calls)) {
          emitted = true;
          result.toolCalls.push(...m.tool_calls);
        }
      }
      if (obj.done) {
        result.evalCount = obj.eval_count ?? 0;
        result.evalDuration = obj.eval_duration ?? 0;
        finished = true;
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value as Uint8Array, { stream: true });
        let i: number;
        while (!finished && (i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) handleLine(line);
        }
      }
      if (!finished && buf.trim()) handleLine(buf.trim());
    } finally {
      reader.cancel().catch(() => undefined);
    }
    return result;
  }
}


/** Sampling settings the model makers recommend, sent on every request rather than trusting Ollama's defaults. */
export function tuning(model: string, think: boolean, numCtx: number): Record<string, number> {
  const o: Record<string, number> = { num_ctx: numCtx };
  if (/qwen3/i.test(model)) {
    // Qwen3.x model cards: precise coding with thinking, or the non-thinking settings.
    Object.assign(o, think
      // presence_penalty with thinking too: quantised models loop most in their thinking (keep in step with ModelTuning).
      ? { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5 }
      : { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 });
  }
  return o;
}
