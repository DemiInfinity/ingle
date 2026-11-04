// use_skill, use_rule, report_search / report_read / report_save, skill_create, rule_create —
// Extensions.swift (SkillStore, RuleStore) and Knowledge.swift (ReportStore, Builder).
import * as fs from 'fs';
import * as path from 'path';
import { DENIED } from './paths';
import {
  createRule, createSkill, listReports, listRules, listSkills, readRule, readSkill, reportRead, reportSave, reportSearch,
  ruleFile, ruleText, skillFile, skillText,
} from './stores';
import { str, type ToolArgs, type ToolDef } from './types';

const p = (description: string) => ({ type: 'string', description });
const truthy = (a: ToolArgs, k: string) => a[k] === true || ['true', '1', 'yes'].includes(str(a, k).trim().toLowerCase());

/** Tool names the Mac app only offers when the user's message mentions "skill" or "rule". */
export const BUILDER_TOOLS = ['skill_create', 'rule_create', 'command_create'];

export const knowledgeTools: ToolDef[] = [
  {
    // What's new: the CHANGELOG.md shipped with the extension (copied by install.sh), or the Mac app's copy.
    // Same content as ingle_help("changes") in the Mac app.
    name: 'ingle_changes',
    description: "What's new in Ingle, newest first. Use it when the user asks what's changed, what's new or about updates.",
    parameters: { type: 'object', properties: {}, required: [] },
    readOnly: true,
    available: () => true,
    describe: () => ({ title: "Check what's new", detail: 'Ingle changelog', icon: 'book' }),
    run: async () => {
      const candidates = [
        path.join(__dirname, '..', '..', 'legal', 'CHANGELOG.md'),
        path.join(__dirname, '..', '..', 'CHANGELOG.md'),
        '/Applications/Ingle.app/Contents/Resources/Legal/CHANGELOG.md',
      ];
      for (const f of candidates) {
        try {
          const log = fs.readFileSync(f, 'utf8');
          const trimmed = log.length > 6000 ? log.slice(0, 6000) + '\n…(older changes: Ingle: About → What\'s new)' : log;
          return "What's new in Ingle (newest first; summarise what matters to the user, in plain words):\n\n" + trimmed;
        } catch { /* try the next place */ }
      }
      return "The list of changes isn't available in this install. It's CHANGELOG.md in Ingle's project folder.";
    },
  },
  {
    name: 'use_skill',
    description: 'Load the full instructions of one of the user\'s skills. Do this before any task a skill covers.',
    parameters: { type: 'object', properties: { name: p('The skill\'s name, exactly as listed') }, required: ['name'] },
    readOnly: true,
    available: (ctx) => listSkills(ctx.settings).length > 0,
    describe: (a) => ({ title: 'Use a skill', detail: str(a, 'name'), icon: 'book' }),
    run: async (a, ctx) => readSkill(str(a, 'name'), ctx.settings),
  },
  {
    name: 'use_rule',
    description: 'Load one of the user\'s rules from the rules index when it applies to what you\'re doing.',
    parameters: { type: 'object', properties: { name: p('The rule\'s name, exactly as listed') }, required: ['name'] },
    readOnly: true,
    available: (ctx) => listRules(ctx.workspaceRoot).some((r) => !r.always),
    describe: (a) => ({ title: 'Check a rule', detail: str(a, 'name'), icon: 'book' }),
    run: async (a, ctx) => readRule(str(a, 'name'), ctx.workspaceRoot),
  },
  {
    name: 'report_search',
    description: 'Search saved research reports.',
    parameters: { type: 'object', properties: { query: p('Words to look for') }, required: ['query'] },
    readOnly: true,
    available: () => listReports().length > 0,
    describe: (a) => ({ title: 'Search research reports', detail: str(a, 'query'), icon: 'book' }),
    run: async (a) => reportSearch(str(a, 'query')),
  },
  {
    name: 'report_read',
    description: 'Read a saved research report.',
    parameters: { type: 'object', properties: { name: p('The report\'s name from the research index') }, required: ['name'] },
    readOnly: true,
    available: () => listReports().length > 0,
    describe: (a) => ({ title: 'Read a research report', detail: str(a, 'name'), icon: 'book' }),
    run: async (a) => reportRead(str(a, 'name')),
  },
  {
    name: 'report_save',
    description: 'Save a short research report after researching on the web, so it can be recalled later.',
    parameters: {
      type: 'object',
      properties: {
        title: p('Report title'), summary: p('One line saying what it found'),
        report: p('Key findings in Markdown: short sections or bullet points'), sources: p('The URLs used, one per line'),
      },
      required: ['title', 'summary', 'report'],
    },
    readOnly: false,
    available: (ctx) => ctx.web,
    describe: (a) => ({ title: 'Save a research report', detail: str(a, 'title'), icon: 'book' }),
    run: async (a) => reportSave(str(a, 'title'), str(a, 'summary'), str(a, 'report'), str(a, 'sources')),
  },
  {
    name: 'skill_create',
    description: 'Create a new skill for the user (they approve it). A skill is step-by-step instructions for a kind of task.',
    parameters: {
      type: 'object',
      properties: {
        name: p('Short name, e.g. code-review'), description: p('One line saying when to use it'),
        instructions: p('The skill itself in Markdown: steps, checklists, examples'),
        replace: { type: 'boolean', description: 'Overwrite an existing skill with this name' },
      },
      required: ['name', 'description', 'instructions'],
    },
    readOnly: false,
    available: () => true,
    describe: (a) => ({ title: 'Create a skill', detail: `${str(a, 'name')} — ${str(a, 'description')}`, icon: 'book' }),
    async run(a, ctx) {
      const name = str(a, 'name'), description = str(a, 'description'), instructions = str(a, 'instructions');
      if (!name.trim() || !instructions.trim()) return 'A skill needs a name and instructions.';
      const { slug, file } = skillFile(name);
      const replace = truthy(a, 'replace');
      if (fs.existsSync(file) && !replace) return `A skill called ${slug} already exists. Call skill_create again with replace set to true to overwrite it.`;
      const answer = await ctx.requestApproval({
        kind: 'skill', title: fs.existsSync(file) ? 'Wants to replace a skill' : 'Wants to create a skill', detail: file,
        preview: skillText(name, description, instructions).slice(0, 6000),
      });
      if (answer !== 'allow') return DENIED;
      return createSkill(name, description, instructions, replace);
    },
  },
  {
    name: 'rule_create',
    description: 'Create a new rule for the user (they approve it).',
    parameters: {
      type: 'object',
      properties: {
        name: p('Short name, e.g. react-components'), description: p('One line saying when it applies'),
        always: { type: 'boolean', description: 'True if it applies to every chat' },
        text: p('The rule in plain words'),
        replace: { type: 'boolean', description: 'Overwrite an existing rule with this name' },
      },
      required: ['name', 'description', 'text'],
    },
    readOnly: false,
    available: () => true,
    describe: (a) => ({ title: 'Create a rule', detail: `${str(a, 'name')} (${truthy(a, 'always') ? 'always' : 'when relevant'}) — ${str(a, 'description')}`, icon: 'book' }),
    async run(a, ctx) {
      const name = str(a, 'name'), description = str(a, 'description'), text = str(a, 'text');
      if (!name.trim() || !text.trim()) return 'A rule needs a name and some text.';
      const always = truthy(a, 'always');
      const { slug, file } = ruleFile(name);
      const replace = truthy(a, 'replace');
      if (fs.existsSync(file) && !replace) return `A rule called ${slug} already exists. Call rule_create again with replace set to true to overwrite it.`;
      const answer = await ctx.requestApproval({
        kind: 'rule', title: fs.existsSync(file) ? 'Wants to replace a rule' : 'Wants to create a rule', detail: file,
        preview: ruleText(description, always, text).slice(0, 6000),
      });
      if (answer !== 'allow') return DENIED;
      return createRule(name, description, always, text, replace);
    },
  },
];
