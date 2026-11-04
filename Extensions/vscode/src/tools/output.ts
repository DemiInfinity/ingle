// Output trimming for run_command. Pure (no vscode import) so it can be tested.

export const MAX_OUT = 20_000;

/** Keep the start and (mostly) the end — build errors are usually at the bottom. */
export function capOutput(s: string, max = MAX_OUT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4), tail = max - head;
  return s.slice(0, head) + '\n…(trimmed)…\n' + s.slice(s.length - tail);
}
