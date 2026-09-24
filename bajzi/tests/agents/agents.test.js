'use strict';
// T1 (agents-and-cadence plan, §4.1): the common contract every bajzi/agents/**/*.md must meet,
// proven against fixtures (one passing, one failing per rule) and re-applied to every shipped
// agent; plus T3's per-agent {model, tools} pins and reviewer-body checks.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The harness lives OUTSIDE bajzi/agents/: `--plugin-dir bajzi` registers every *.md under
// agents/ recursively, so a fixture there would ship as a live agent.
const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');
const FORMAT_DOC = path.join(__dirname, '..', '..', '..', 'docs', 'findings-format.md');
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

// Splits an agent .md into {fields, body}, or null when there is no frontmatter block.
function parseAgent(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^([a-z]+):\s*(.*)$/);
    if (f) fields[f[1]] = f[2].trim();
  }
  return { fields, body: m[2] };
}
const toolList = (fields) => fields.tools.split(',').map((t) => t.trim()).filter(Boolean);

// Validates one agent .md's full text against the T1 contract. Never throws.
// Returns {ok:true} or {ok:false, why:<string>}.
function validateAgent(content) {
  const p = parseAgent(content);
  if (!p) return { ok: false, why: 'no frontmatter block (--- ... ---)' };
  const { fields, body } = p;
  for (const key of ['name', 'description', 'model', 'tools']) {
    if (!fields[key]) return { ok: false, why: `missing frontmatter field: ${key}` };
  }

  if (!ALLOWED_MODELS.includes(fields.model)) {
    return { ok: false, why: `model is not an alias (haiku|sonnet|opus): ${fields.model}` };
  }

  const tools = toolList(fields);
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

// Every *.md anywhere under bajzi/agents/ is loaded as a live agent, so every one of them must be
// a real agent that meets the contract -- a README or a fixture there fails here.
const shipped = () => fs.readdirSync(AGENTS_DIR, { recursive: true })
  .filter((f) => f.endsWith('.md'));
const read = (f) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');

test('every shipped bajzi/agents/**/*.md passes the contract', () => {
  for (const f of shipped()) {
    const r = validateAgent(read(f));
    assert.strictEqual(r.ok, true, `${f}: ${r.ok ? '' : r.why}`);
  }
});

// Plan §4.1 table, per agent: exact model and exact tool set. The union allow-list above cannot
// catch a reviewer that gains Write/Edit/Bash (D1: the reviewer is read-only).
const PINS = {
  reviewer: { model: 'opus', tools: ['Read', 'Grep', 'Glob',
    'mcp__code-review-graph__detect_changes_tool', 'mcp__code-review-graph__get_review_context_tool'] },
  fixer: { model: 'sonnet', tools: ['Read', 'Edit', 'Grep', 'Glob', 'Bash'] },
  implementer: { model: 'sonnet', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] },
  'implementer-risk': { model: 'opus', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] },
};

test('every shipped agent matches its pinned {model, tools} (plan §4.1)', () => {
  const names = shipped().map((f) => path.basename(f, '.md'));
  for (const name of Object.keys(PINS)) assert.ok(names.includes(name), `${name}.md missing`);
  for (const f of shipped()) {
    const name = path.basename(f, '.md');
    assert.ok(PINS[name], `${f}: no PINS entry -- add its §4.1 model/tools here`);
    const { fields } = parseAgent(read(f));
    assert.deepStrictEqual({ model: fields.model, tools: [...toolList(fields)].sort() },
      { model: PINS[name].model, tools: [...PINS[name].tools].sort() }, name);
  }
});

// The final message IS the findings file: a trailing `VERDICT:` line parses as a continuation of
// the last field (findings.js FIELD_RE is lower-case) and reaches the fixer.
test('reviewer output contract has no trailing VERDICT: line', () => {
  assert.doesNotMatch(read('reviewer.md'), /VERDICT:/);
});

// docs/findings-format.md is canonical; the reviewer embeds a copy because it runs in the target
// repo, where the doc does not exist. Each rubric line must appear verbatim.
test('reviewer rubric lines match docs/findings-format.md verbatim', () => {
  const doc = fs.readFileSync(FORMAT_DOC, 'utf8');
  const lines = doc.split(/\r?\n/).filter((l) => /^- \*\*(blocker|major|minor|nit)\*\* - /.test(l)
    || /^Changed logic without a test is at least major\.$/.test(l));
  assert.strictEqual(lines.length, 5, `rubric lines found in the doc: ${lines.length}`);
  const body = read('reviewer.md');
  for (const l of lines) assert.ok(body.includes(l), `reviewer.md lacks: ${l}`);
});

// T4: implementer-risk is implementer plus exactly one inserted block (the Tier-1 rule) and a
// different model. Any other divergence (wording drift, a second edit) fails this.
test('implementer.md and implementer-risk.md bodies differ only in the Tier-1 block + model', () => {
  const a = parseAgent(read('implementer.md'));
  const b = parseAgent(read('implementer-risk.md'));
  assert.strictEqual(a.fields.model, 'sonnet');
  assert.strictEqual(b.fields.model, 'opus');
  assert.strictEqual(a.fields.tools, b.fields.tools, 'tools must match between the two agents');

  const aLines = a.body.trim().split(/\r?\n/);
  const bLines = b.body.trim().split(/\r?\n/);
  let prefix = 0;
  while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < aLines.length - prefix && suffix < bLines.length - prefix
    && aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]) suffix++;
  // If implementer.md has any line outside the common prefix/suffix, the two bodies diverge
  // somewhere other than a pure insertion into implementer-risk.md.
  assert.strictEqual(prefix + suffix, aLines.length,
    'implementer.md has content not present in implementer-risk.md (bodies diverge, not a pure insertion)');
  const inserted = bLines.slice(prefix, bLines.length - suffix);
  assert.ok(inserted.length > 0, 'implementer-risk.md has no inserted Tier-1 block');
  assert.ok(inserted.some((l) => /Tier 1/.test(l)), `inserted block does not mention Tier 1: ${inserted.join(' / ')}`);
});
