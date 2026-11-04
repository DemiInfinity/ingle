// Port of SemanticMatcher.swift: embeddings via nomic-embed-text when installed, keyword overlap otherwise.
import { OllamaClient } from './ollama';

export interface Candidate {
  id: string;
  text: string;
}

const EMBED_MODEL = 'nomic-embed-text';

const stopWords = new Set([
  'this', 'that', 'with', 'from', 'what', 'when', 'where', 'which', 'about', 'into', 'your', 'have',
  'will', 'would', 'could', 'should', 'there', 'their', 'them', 'then', 'than', 'also', 'just', 'like',
  'make', 'need', 'want', 'please', 'help', 'using', 'user', 'file', 'code', 'some', 'more', 'does',
]);

export function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3 && !stopWords.has(w)),
  );
}

export function keywordMatches(query: string, candidates: Candidate[], limit = 3): string[] {
  const q = words(query);
  return candidates
    .map((c) => {
      let overlap = 0;
      for (const w of words(c.text)) if (q.has(w)) overlap++;
      let nameHit = 0;
      for (const w of words(c.id)) if (q.has(w)) { nameHit = 2; break; }
      return { id: c.id, score: overlap + nameHit };
    })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class Matcher {
  private cache = new Map<string, number[]>();

  clearCache(): void { this.cache.clear(); }

  /** IDs of candidates that match the query, best first. */
  async matches(client: OllamaClient, installed: string[], query: string, candidates: Candidate[], limit = 3): Promise<string[]> {
    if (!candidates.length || !query.trim()) return [];
    const hasModel = installed.some((n) => n === EMBED_MODEL || n.startsWith(EMBED_MODEL + ':'));
    if (hasModel) {
      const semantic = await this.semantic(client, query, candidates, limit);
      if (semantic) return semantic;
    }
    return keywordMatches(query, candidates, limit);
  }

  private async semantic(client: OllamaClient, query: string, candidates: Candidate[], limit: number): Promise<string[] | null> {
    const missing = candidates.filter((c) => !this.cache.has(c.text));
    if (missing.length) {
      const vectors = await client.embed(EMBED_MODEL, missing.map((c) => 'search_document: ' + c.text));
      if (!vectors || vectors.length !== missing.length) return null;
      missing.forEach((c, i) => this.cache.set(c.text, vectors[i]));
      if (this.cache.size > 2000) this.cache.clear();
    }
    const q = (await client.embed(EMBED_MODEL, ['search_query: ' + query.slice(0, 2000)]))?.[0];
    if (!q) return null;
    return candidates
      .map((c) => ({ id: c.id, score: this.cache.has(c.text) ? cosine(q, this.cache.get(c.text)!) : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .filter((s) => s.score >= 0.58)
      .map((s) => s.id);
  }
}
