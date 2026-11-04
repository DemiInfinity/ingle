// Finds a running Ollama engine, or starts Ingle's bundled one.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { expandHome, IngleSettings } from '../shared/settings';
import { OllamaClient } from './ollama';

export type EngineState = 'starting' | 'ready' | 'offline';

export const OFFLINE_TEXT = 'Engine asleep — it starts by itself when you send a message';

export class EngineServer {
  state: EngineState = 'starting';
  text = 'Checking the engine…';
  private proc?: ChildProcess;
  private starting?: Promise<boolean>;
  private poll?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly onChange: (state: EngineState, text: string) => void, private settings: () => IngleSettings) {}

  private set(state: EngineState, text: string) {
    const changed = state !== this.state || text !== this.text;
    this.state = state;
    this.text = text;
    if (changed && !this.disposed) this.onChange(state, text);
    // While offline, look again now and then: the Mac app may start its engine.
    if (state === 'offline' && !this.poll && !this.disposed) {
      this.poll = setInterval(() => void this.check(), 15000);
    } else if (state !== 'offline' && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  /** Is anything answering at serverURL? Updates the state. */
  async check(): Promise<boolean> {
    const v = await new OllamaClient(this.settings().serverURL).version(1500);
    if (v !== null) {
      this.set('ready', v ? `Engine ready (Ollama ${v})` : 'Engine ready');
      return true;
    }
    if (!this.starting) this.set('offline', OFFLINE_TEXT);
    return false;
  }

  /** Check, and start the bundled engine if nothing answers. */
  async ensure(autoStart = true): Promise<boolean> {
    if (await this.check()) return true;
    if (!autoStart) return false;
    return this.start();
  }

  /** Start `<enginePath> serve` on serverURL's port and wait up to 10 s for it. */
  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    const settings = this.settings();
    const client = new OllamaClient(settings.serverURL);
    if ((await client.version(1500)) !== null) {
      this.set('ready', 'Engine ready');
      return true;
    }
    let url: URL;
    try {
      url = new URL(settings.serverURL);
    } catch {
      this.set('offline', 'The server address in Ingle’s settings isn’t valid.');
      return false;
    }
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    const bin = expandHome(settings.enginePath || '');
    if (!local) {
      this.set('offline', `Can’t reach the engine at ${url.host}. Check that computer is on.`);
      return false;
    }
    if (!bin || !fs.existsSync(bin)) {
      this.set('offline', OFFLINE_TEXT);
      return false;
    }
    this.set('starting', 'Starting Ingle’s engine…');
    const port = url.port || '11434';
    try {
      const proc = spawn(bin, ['serve'], {
        env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_KEEP_ALIVE: settings.keepAlive },
        stdio: 'ignore',
        detached: false,
      });
      proc.on('error', () => {
        if (this.proc === proc) this.proc = undefined;
      });
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = undefined;
      });
      this.proc = proc;
    } catch {
      this.set('offline', OFFLINE_TEXT);
      return false;
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !this.disposed) {
      await new Promise((r) => setTimeout(r, 400));
      if ((await client.version(1000)) !== null) {
        this.set('ready', 'Engine ready');
        return true;
      }
      if (!this.proc) break; // it exited
    }
    this.set('offline', OFFLINE_TEXT);
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.poll) clearInterval(this.poll);
    // Only stop an engine we started; the Mac app's engine is left alone.
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.proc = undefined;
  }
}
