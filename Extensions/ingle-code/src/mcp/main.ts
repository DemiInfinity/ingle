// Entry point for bin/ingle-code: an MCP server on stdin/stdout. Logs go to stderr.
import { McpServer, VERSION } from './server';
import { EngineOptions } from '../engine/types';

const HELP = `ingle-code ${VERSION} — read-only code intelligence as an MCP server (stdio)

Usage: ingle-code [--root <folder>] [--model <ollama model>] [--ollama-host <url>] [--idle-minutes <n>] [--no-servers] [--verbose]

  --root           Workspace to analyse (default: the client's first root, else the current folder). Also $INGLE_CODE_ROOT.
  --model          Model for read_exhaustively (default: $INGLE_CODE_MODEL, else the smallest installed model).
  --ollama-host    Local Ollama address (default: $OLLAMA_HOST or http://localhost:11434). Only local addresses are allowed.
  --idle-minutes   Stop a language server after this many idle minutes (default 10).
  --no-servers     Don't start language servers; every answer is approximate.
  --verbose        Log to stderr.
`;

function parseArgs(argv: string[]): (Omit<EngineOptions, 'root'> & { root?: string; verbose?: boolean }) | undefined {
  const o: Omit<EngineOptions, 'root'> & { root?: string; verbose?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) { process.stderr.write(`${a} needs a value\n`); process.exit(2); }
      return v;
    };
    switch (a) {
      case '--root': o.root = val(); break;
      case '--model': o.model = val(); break;
      case '--ollama-host': o.ollamaHost = val(); break;
      case '--idle-minutes': o.idleMs = Math.max(0.1, Number(val())) * 60_000; break;
      case '--no-servers': o.noServers = true; break;
      case '--verbose': o.verbose = true; break;
      case '--version': process.stdout.write(`${VERSION}\n`); return undefined;
      case '-h': case '--help': process.stdout.write(HELP); return undefined;
      default: process.stderr.write(`Unknown option ${a}\n${HELP}`); process.exit(2);
    }
  }
  o.root = o.root ?? process.env.INGLE_CODE_ROOT;
  return o;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (!o) return;
  const verbose = o.verbose || !!process.env.INGLE_CODE_DEBUG;
  const server = new McpServer(process.stdin, process.stdout, { ...o, log: verbose ? (m) => process.stderr.write(`[ingle-code] ${m}\n`) : undefined });
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await Promise.race([server.close(), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(130));
  process.on('SIGTERM', () => void stop(143));
  process.on('SIGHUP', () => void stop(129));
  process.on('exit', () => server.killNow());
  process.stdout.on('error', () => void stop(0)); // client went away
  await server.run();
  await stop(0);
}

void main();
