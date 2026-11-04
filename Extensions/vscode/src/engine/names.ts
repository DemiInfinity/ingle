// Readable names for Ollama tags and assistant roles.

const special: [RegExp, string][] = [
  [/gpt-oss[:-]?(\d+)b/i, 'gpt-oss $1B'],
  [/glm-4\.7-flash/i, 'GLM-4.7 Flash'],
];

/** "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS" → "Qwen3.6 35B A3B"; "qwen3.8:27b-mlx" → "Qwen3.8 27B". */
export function prettyModel(tag: string): string {
  if (!tag) return '';
  for (const [re, out] of special) {
    const m = tag.match(re);
    if (m) return out.replace('$1', m[1] ?? '');
  }
  let name = tag.trim();
  if (name.startsWith('hf.co/') || name.includes('/')) name = name.split('/').pop() ?? name;
  const [base, variant = ''] = name.split(':');
  const drop = /^(gguf|mlx|instruct|it|chat|latest|q\d.*|iq\d.*|ud|fp16|bf16|f16)$/i;
  const size = /^[a-z]?\d+(\.\d+)?[bkm]$/i;
  const words = base.split(/[-_\s]+/).filter((w) => w && !drop.test(w));
  const hasSize = words.some((w) => size.test(w));
  if (!hasSize) {
    const fromTag = variant.split(/[-_]/).find((w) => size.test(w));
    if (fromTag) words.push(fromTag);
  }
  const pretty = words.map((w) => {
    if (size.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return pretty.join(' ') || tag;
}

export function roleName(id: string): string {
  return id === 'hard' ? 'Hard jobs' : 'Daily coding';
}
