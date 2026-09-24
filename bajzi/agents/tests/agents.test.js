'use strict';
// T1 (agents-and-cadence plan, §4.1): the common contract every bajzi/agents/*.md must meet.
// bajzi/agents/ ships EMPTY of agent bodies in T1 (T3 adds reviewer/fixer, T4 adds
// implementer/implementer-risk) -- so the rules below are proven against fixtures, not against
// real files, and are re-applied automatically to every *.md a later task adds.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const ALLOWED_MODELS = ['haiku', 'sonnet', 'opus'];
// The union of every "tools" column in plan §4.1's agent table.
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash',
  'mcp__code-review-graph__detect_changes_tool',
  'mcp__code-review-graph__get_review_context_tool',
];
const REQUIRED_HEADINGS = ['# Input', '# Output', '# Rules', '# Never'];
const MAX_BODY_LINES = 60;

// Validates one agent .md's full text against the T1 contract. Never throws.
// Returns {ok:true} or {ok:false, why:<string>}.
function validateAgent(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { ok: false, why: 'no frontmatter block (--- ... ---)' };
  const [, fm, body] = m;

  const fields = {};
  for (const line of fm.split(/\r?\n/)) {
    const f = line.match(/^([a-z]+):\s*(.*)$/);
    if (f) fields[f[1]] = f[2].trim();
  }
  for (const key of ['name', 'description', 'model', 'tools']) {
    if (!fields[key]) return { ok: false, why: `missing frontmatter field: ${key}` };
  }

  if (!ALLOWED_MODELS.includes(fields.model)) {
    return { ok: false, why: `model is not an alias (haiku|sonnet|opus): ${fields.model}` };
  }

  const tools = fields.tools.split(',').map((t) => t.trim()).filter(Boolean);
  if (tools.includes('Agent') || tools.includes('Task')) {
    return { ok: false, why: 'tools may not include Agent or Task (no dispatching another agent)' };
  }
  for (const t of tools) {
    if (!ALLOWED_TOOLS.includes(t)) return { ok: false, why: `tool not on the allow-list: ${t}` };
  }

  const trimmedBody = body.replace(/^\r?\n+/, '').replace(/\r?\n+$/, '');
  const bodyLines = trimmedBody === '' ? [] : trimmedBody.split(/\r?\n/);
  if (bodyLines.length > MAX_BODY_LINES) {
    return { ok: false, why: `body is ${bodyLines.length} lines, max ${MAX_BODY_LINES}` };
  }
  for (const h of REQUIRED_HEADINGS) {
    if (!bodyLines.includes(h)) return { ok: false, why: `missing required heading: ${h}` };
  }

  return { ok: true };
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

test('bajzi/agents/ exists (scaffold; bodies land in T3/T4)', () => {
  assert.ok(fs.existsSync(AGENTS_DIR) && fs.statSync(AGENTS_DIR).isDirectory());
});

test('fixture: a conforming agent file passes', () => {
  assert.deepStrictEqual(validateAgent(fixture('good.md')), { ok: true });
});

for (const [name, reWhy] of [
  ['bad-no-frontmatter.md', /no frontmatter/],
  ['bad-missing-field.md', /missing frontmatter field: tools/],
  ['bad-model-versioned.md', /model is not an alias/],
  ['bad-tool-not-allowed.md', /not on the allow-list: WebFetch/],
  ['bad-tool-agent.md', /may not include Agent or Task/],
  ['bad-missing-heading.md', /missing required heading: # Never/],
  ['bad-body-too-long.md', /body is \d+ lines, max 60/],
]) {
  test(`fixture: ${name} is rejected (${reWhy})`, () => {
    const r = validateAgent(fixture(name));
    assert.strictEqual(r.ok, false);
    assert.match(r.why, reWhy);
  });
}

// Re-applies the same contract to every real agent file once T3/T4 add one, so this suite keeps
// covering them without edits. Empty today -- deliberately not the only test in this file.
test('every shipped bajzi/agents/*.md passes the contract', () => {
  const mdFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  for (const f of mdFiles) {
    const r = validateAgent(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
    assert.strictEqual(r.ok, true, `${f}: ${r.ok ? '' : r.why}`);
  }
});
