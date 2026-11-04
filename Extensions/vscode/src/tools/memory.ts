// memory_search / memory_read / memory_save / memory_rewrite / memory_forget — Memory.swift.
import { DENIED } from './paths';
import { memoryForget, memoryRead, memoryRewrite, memorySave, memorySearch } from './stores';
import { str, type ToolArgs, type ToolContext, type ToolDef } from './types';

const p = (description: string) => ({ type: 'string', description });
const on = (ctx: ToolContext) => ctx.settings.memory.enabled;
const optional = (a: ToolArgs, k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string) : undefined);

async function maybeAsk(ctx: ToolContext, title: string, detail: string, preview?: string): Promise<boolean> {
  if (!ctx.settings.memory.askFirst) return true;
  return (await ctx.requestApproval({ kind: 'memory', title, detail, preview })) === 'allow';
}

export const memoryTools: ToolDef[] = [
  {
    name: 'memory_search',
    description: 'Search long-term memory about the user for a detail.',
    parameters: { type: 'object', properties: { query: p("Words to look for, e.g. 'work hours' or 'cat names'") }, required: ['query'] },
    readOnly: true, available: on,
    describe: (a) => ({ title: 'Search memory', detail: str(a, 'query'), icon: 'person' }),
    run: async (a) => memorySearch(str(a, 'query')),
  },
  {
    name: 'memory_read',
    description: 'Read one memory file in full.',
    parameters: { type: 'object', properties: { file: p('File name from the memory index') }, required: ['file'] },
    readOnly: true, available: on,
    describe: (a) => ({ title: 'Read memory', detail: str(a, 'file'), icon: 'person' }),
    run: async (a) => memoryRead(str(a, 'file')),
  },
  {
    name: 'memory_save',
    description: 'Remember one lasting fact about the user.',
    parameters: {
      type: 'object',
      properties: {
        file: p('Which file: about-me, preferences, work, projects, people, or a new subject'),
        fact: p('The fact, short and in plain words'),
        description: p('Only for a new file: one line saying what it holds'),
      },
      required: ['file', 'fact'],
    },
    readOnly: false, available: on,
    describe: (a) => ({ title: 'Save to memory', detail: `${str(a, 'file')}: ${str(a, 'fact')}`, icon: 'person' }),
    async run(a, ctx) {
      if (!(await maybeAsk(ctx, 'Wants to save to memory', `${str(a, 'file')}: ${str(a, 'fact')}`))) return DENIED;
      return memorySave(str(a, 'file'), str(a, 'fact'), optional(a, 'description'));
    },
  },
  {
    name: 'memory_rewrite',
    description: 'Replace a whole memory file, to correct or tidy it.',
    parameters: {
      type: 'object',
      properties: { file: p('File name'), content: p('The full new contents, one fact per line'), description: p('Optional new one-line description') },
      required: ['file', 'content'],
    },
    readOnly: false, available: on,
    describe: (a) => ({ title: 'Rewrite memory', detail: str(a, 'file'), icon: 'person' }),
    async run(a, ctx) {
      if (!(await maybeAsk(ctx, 'Wants to rewrite a memory file', str(a, 'file'), str(a, 'content').slice(0, 3000)))) return DENIED;
      return memoryRewrite(str(a, 'file'), str(a, 'content'), optional(a, 'description'));
    },
  },
  {
    name: 'memory_forget',
    description: 'Remove lines from a memory file that mention some text.',
    parameters: { type: 'object', properties: { file: p('File name'), text: p('Text the lines to remove contain') }, required: ['file', 'text'] },
    readOnly: false, available: on,
    describe: (a) => ({ title: 'Forget from memory', detail: `${str(a, 'file')}: ${str(a, 'text')}`, icon: 'person' }),
    async run(a, ctx) {
      if (!(await maybeAsk(ctx, 'Wants to forget something', `${str(a, 'file')}: ${str(a, 'text')}`))) return DENIED;
      return memoryForget(str(a, 'file'), str(a, 'text'));
    },
  },
];
