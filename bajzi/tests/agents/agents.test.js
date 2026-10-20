'use strict';
// The common contract every bajzi/agents/**/*.md must meet,
// proven against fixtures (one passing, one failing per rule) and re-applied to every shipped
// agent; plus the per-agent {model, tools} pins and reviewer-body checks.
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
// The union of every "tools" column in the agent table.
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash',
  'mcp__code-review-graph__detect_changes_tool',
  'mcp__code-review-graph__get_review_context_tool',
];
const REQUIRED_HEADINGS = ['# Input', '# Output', '# Rules', '# Never'];
const MAX_BODY_LINES = 60;
const MAX_BODY_LINES_BY_AGENT = { reviewer: 140 }; // the reviewer carries the review checklist
// The mandatory frontmatter keys; optional keys are listed below, any other key is refused.
const ALLOWED_KEYS = ['name', 'description', 'model', 'tools'];
const OPTIONAL_KEYS = ['effort']; // optional, values low|medium|high|xhigh|max
const ALLOWED_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

// Splits an agent .md into {fields, body}, or null when there is no frontmatter block.
function parseAgent(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (f) fields[f[1]] = f[2].trim();
  }
  return { fields, body: m[2] };
}
const toolList = (fields) => fields.tools.split(',').map((t) => t.trim()).filter(Boolean);

// Validates one agent .md's full text against the common contract; `name`, when given, is the file
// basename the `name:` field must equal. Never throws.
// Returns {ok:true} or {ok:false, why:<string>}.
function validateAgent(content, name) {
  const p = parseAgent(content);
  if (!p) return { ok: false, why: 'no frontmatter block (--- ... ---)' };
  const { fields, body } = p;
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) return { ok: false, why: `unknown frontmatter key: ${key}` };
  }
  if ('effort' in fields && !ALLOWED_EFFORT.includes(fields.effort)) {
    return { ok: false, why: `effort is not low|medium|high|xhigh|max: ${fields.effort}` };
  }
  for (const key of ALLOWED_KEYS) {
    if (!fields[key]) return { ok: false, why: `missing frontmatter field: ${key}` };
  }
  if (name !== undefined && fields.name !== name) {
    return { ok: false, why: `name "${fields.name}" does not match the file basename "${name}"` };
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
  const maxLines = Object.hasOwn(MAX_BODY_LINES_BY_AGENT, name) ? MAX_BODY_LINES_BY_AGENT[name] : MAX_BODY_LINES;
  if (bodyLines.length > maxLines) {
    return { ok: false, why: `body is ${bodyLines.length} lines, max ${maxLines}` };
  }
  for (const h of REQUIRED_HEADINGS) {
    if (!bodyLines.includes(h)) return { ok: false, why: `missing required heading: ${h}` };
  }

  return { ok: true };
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

test('bajzi/agents/ exists (scaffold)', () => {
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
  ['bad-effort.md', /effort is not low\|medium\|high\|xhigh\|max: ludicrous/],
]) {
  test(`fixture: ${name} is rejected (${reWhy})`, () => {
    const r = validateAgent(fixture(name));
    assert.strictEqual(r.ok, false);
    assert.match(r.why, reWhy);
  });
}

// The guard, dispatch.md and the skills route on `bajzi:<name>`, so a name that drifts from the
// file basename breaks routing; a frontmatter key outside the shipped set (permissionMode,
// mcpServers, disallowedTools, ...) would change what the agent may do with every test green.
test('fixture: name must equal the file basename when one is given', () => {
  assert.deepStrictEqual(validateAgent(fixture('good.md'), 'fixture-good'), { ok: true });
  const r = validateAgent(fixture('good.md'), 'fixer');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /name "fixture-good" does not match the file basename "fixer"/);
});

for (const key of ['permissionMode: bypassPermissions', 'mcpServers: x', 'disallowedTools: Write', 'color: red']) {
  test(`fixture: unknown frontmatter key is rejected (${key})`, () => {
    const r = validateAgent(fixture('good.md').replace(/^(---\r?\n)/, `$1${key}\n`));
    assert.strictEqual(r.ok, false);
    assert.match(r.why, new RegExp(`unknown frontmatter key: ${key.split(':')[0]}`));
  });
}

// Every *.md anywhere under bajzi/agents/ is loaded as a live agent, so every one of them must be
// a real agent that meets the contract -- a README or a fixture there fails here.
const shipped = () => fs.readdirSync(AGENTS_DIR, { recursive: true })
  .filter((f) => f.endsWith('.md'));
const read = (f) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');

test('every shipped bajzi/agents/**/*.md passes the contract', () => {
  for (const f of shipped()) {
    const r = validateAgent(read(f), path.basename(f, '.md'));
    assert.strictEqual(r.ok, true, `${f}: ${r.ok ? '' : r.why}`);
  }
});

// Per agent: exact model and exact tool set. The union allow-list above cannot
// catch a reviewer that gains Write/Edit/Bash (D1: the reviewer is read-only).
const PINS = {
  reviewer: { model: 'opus', tools: ['Read', 'Grep', 'Glob',
    'mcp__code-review-graph__detect_changes_tool', 'mcp__code-review-graph__get_review_context_tool'] },
  fixer: { model: 'sonnet', tools: ['Read', 'Edit', 'Grep', 'Glob', 'Bash'] },
  implementer: { model: 'sonnet', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] },
  'implementer-risk': { model: 'opus', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] },
};

test('every shipped agent matches its pinned {model, tools}', () => {
  const names = shipped().map((f) => path.basename(f, '.md'));
  for (const name of Object.keys(PINS)) assert.ok(names.includes(name), `${name}.md missing`);
  for (const f of shipped()) {
    const name = path.basename(f, '.md');
    assert.ok(PINS[name], `${f}: no PINS entry -- add its model/tools here`);
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

// Checks the Checklist section of a reviewer body; returns an error string or null.
function checkChecklist(body) {
  const lines = body.split(/\r?\n/);
  const i = lines.indexOf('# Checklist');
  if (i < 0) return 'missing # Checklist heading';
  let end = lines.findIndex((l, k) => k > i && /^# /.test(l));
  if (end < 0) end = lines.length;
  if (end - i > 40) return `Checklist is ${end - i} lines, max 40`;
  const sec = lines.slice(i, end);
  const s = sec.indexOf('Security:'), f = sec.indexOf('Silent failures:'), d = sec.indexOf('Do NOT flag:');
  if (s < 0 || f <= s || d <= f) return 'Checklist needs Security:, Silent failures:, Do NOT flag: in that order';
  const parts = [
    [sec.slice(s, f), [/Injection/, /Secrets/, /deserialization/, /authorization/, /Temp files/, /TLS verification/, /weak hashing/, /CSRF/, /substring or unanchored/, /sibling/, /exposes more fields/]],
    [sec.slice(f, d), [/swallowed exception/, /\|\| true/, /fallback or default/, /Optional chaining/, /retry loop/]],
    [sec.slice(sec.indexOf('Tests, comments, data shapes:'), d), [/^Tests, comments, data shapes:$/m, /cannot fail.*is minor, unless it is the only test of changed logic/, /regression/, /contradicts.*is a nit/, /TODO.*is a nit/, /invalid instance.*major.*else minor/]],
    [sec.slice(d), [/Denial of service/, /Trusted inputs/, /Parameterized SQL/, /already existed outside the diff/, /Theoretical issues/, /serves no HTTP/, /telemetry keys/, /intended feature/, /internal-only/, /workflow_dispatch/]],
  ];
  for (const [part, res] of parts) {
    for (const re of res) if (!re.test(part.join('\n'))) return `${re} not in its own sub-list`;
  }
  return null;
}

// The review checklist is inline in the reviewer (a separate file is unreachable from other cwds).
test('reviewer body pins the Checklist, the source/sink/path rule and the DO-NOT-flag list', () => {
  const body = read('reviewer.md');
  assert.strictEqual(checkChecklist(body), null);
  assert.match(body, /security finding names the source .*, the sink .*and the path between them/s);
});

test('fixture: checklist check rejects a last-heading overlong section and a misplaced exclusion', () => {
  const body = read('reviewer.md').replace(/\r\n/g, '\n');
  const lines = body.split(/\r?\n/);
  const i = lines.indexOf('# Checklist');
  const checklistLast = lines.slice(0, i).concat(lines.slice(i, lines.indexOf('# Never')),
    Array(45).fill('- filler'));
  assert.match(checkChecklist(checklistLast.join('\n')), /max 40/);
  const moved = body.replace('- Parameterized SQL.\n', '').replace('Silent failures:\n', '- Parameterized SQL.\nSilent failures:\n');
  assert.notStrictEqual(moved, body);
  assert.match(checkChecklist(moved), /Parameterized SQL/);
  const noHeading = body.replace('Tests, comments, data shapes:\n', '');
  assert.notStrictEqual(noHeading, body);
  assert.match(checkChecklist(noHeading), /not in its own sub-list/);
  const noSeverity = body.replace('is minor, unless', 'unless');
  assert.notStrictEqual(noSeverity, body);
  assert.match(checkChecklist(noSeverity), /cannot fail/);
});

// Per-agent body-length cap: reviewer 140, every other name (incl. built-in property names) 60.
function agentWith(name, n) {
  const filler = Array(Math.max(0, n - 4)).fill('x');
  return `---\nname: ${name}\ndescription: d\nmodel: sonnet\ntools: Read\n---\n${['# Input', '# Output', '# Rules', '# Never', ...filler].join('\n')}\n`;
}
test('fixture: per-agent body-length cap', () => {
  assert.match(validateAgent(agentWith('reviewer', 141), 'reviewer').why, /max 140/);
  assert.deepStrictEqual(validateAgent(agentWith('reviewer', 80), 'reviewer'), { ok: true });
  assert.match(validateAgent(agentWith('fixer', 61), 'fixer').why, /max 60/);
  assert.match(validateAgent(agentWith('toString', 61), 'toString').why, /max 60/);
});

// implementer-risk is implementer plus exactly one inserted block (the Tier-1 rule) and a
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

test('reviewer judges the slice acceptance items (slice: line, major finding)', () => {
  const body = read('reviewer.md');
  assert.match(body, /`slice:` line/);
  assert.match(body, /acceptance item the diff does not meet is a major finding \(contract/);
});

test('reviewer pins the review-policy rules', () => {
  const body = read('reviewer.md').replace(/\s+/g, ' ');
  assert.match(body, /`policy:` line/);
  assert.match(body, /suppresses only a finding it names specifically/);
  assert.match(body, /never suppresses a blocker/);
  assert.match(body, /generic entry/);
  assert.match(body, /`policy-changed: yes` is a major finding/);
  assert.match(body, /unless the slice acceptance explicitly names that policy change/);
  assert.match(body, /base version/);
});
