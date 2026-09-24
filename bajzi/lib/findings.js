'use strict';
// Findings files (agents-and-cadence plan §4.2, D4-D6). Format: docs/findings-format.md.
// Two kinds share one grammar: a review round `# Findings · <slice> · round <n>` and the
// debt ledger `# Debt`. Every function that emits or routes findings validates first and
// throws on an invalid file, so a malformed file never reaches the fixer, debt.md or the owner.

const SEVERITIES = ['nit', 'minor', 'major', 'blocker']; // ascending
const MAX_BYTES = 24 * 1024;
const MAX_FINDINGS = 40;
const DEBT_MAX_TOTAL = 15;
const DEBT_MAX_PER_FILE = 3;

const HEADER_FIELDS = ['range', 'reviewer', 'verdict', 'files_reviewed'];
const FINDING_FIELDS = ['finding', 'if_unfixed', 'why_severity', 'test'];
const DEBT_FIELDS = [...FINDING_FIELDS, 'origin', 'parked'];
// Enumerated values may carry a trailing "  # comment"; free-text fields never lose a '#'.
const COMMENTABLE = new Set([...HEADER_FIELDS, 'status']);

const TITLE_RE = /^# Findings · (\S+) · round (\d+)\s*$/;
const DEBT_TITLE_RE = /^# Debt\s*$/;
const FIELD_RE = /^([a-z_]+):[ \t]*(.*)$/;

function fileOf(location) { return location.replace(/:\d+(-\d+)?$/, ''); }

// Structural parse. Never throws; `validate` judges the result.
function parse(text) {
  const doc = { kind: null, slice: null, round: null, header: {}, findings: [], problems: [] };
  let cur = null; // the field map being filled: doc.header, then each finding
  let last = null; // last field name, for wrapped continuation lines
  const lines = String(text || '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const title = lines[i] || '';
  let m;
  if ((m = title.match(TITLE_RE))) {
    Object.assign(doc, { kind: 'findings', slice: m[1], round: Number(m[2]) });
    i++;
  } else if (DEBT_TITLE_RE.test(title)) {
    doc.kind = 'debt';
    i++;
  }
  cur = doc.header;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      const parts = line.slice(3).split(' · ').map((s) => s.trim());
      const f = { id: parts[0], heading: line };
      if (parts.length === 3 && parts.every(Boolean)) {
        [, f.severity, f.location] = parts;
        f.file = fileOf(f.location);
      } else {
        doc.problems.push(`${parts[0]}: heading must be "## <id> · <severity> · <path[:line]>"`);
      }
      doc.findings.push(f);
      cur = f;
      last = null;
    } else if ((m = line.match(FIELD_RE))) {
      last = m[1];
      let v = m[2];
      if (COMMENTABLE.has(last)) v = v.replace(/\s+#.*$/, '');
      cur[last] = v.trim();
    } else if (line.trim() && last) {
      cur[last] = `${cur[last]} ${line.trim()}`.trim();
    }
  }
  return doc;
}

// validate(text) -> {ok, errors: [string], doc}. Each error names its subject and field,
// e.g. "F1: missing field: if_unfixed", "header: missing field: range".
function validate(text) {
  const errors = [];
  const bytes = Buffer.byteLength(String(text || ''), 'utf8');
  if (bytes > MAX_BYTES) errors.push(`size: ${bytes} bytes > ${MAX_BYTES}`);
  const doc = parse(text);
  errors.push(...doc.problems);
  if (!doc.kind) errors.push('title: first line must be "# Findings · <slice-id> · round <n>" or "# Debt"');
  if (doc.kind === 'findings') {
    if (doc.round !== 1 && doc.round !== 2) errors.push(`title: round must be 1 or 2, got ${doc.round}`);
    for (const k of HEADER_FIELDS) if (!doc.header[k]) errors.push(`header: missing field: ${k}`);
    if (doc.findings.length > MAX_FINDINGS) errors.push(`count: ${doc.findings.length} findings > ${MAX_FINDINGS}`);
  }
  const required = doc.kind === 'debt' ? DEBT_FIELDS : FINDING_FIELDS;
  const seen = new Set();
  for (const f of doc.findings) {
    if (seen.has(f.id)) errors.push(`${f.id}: duplicate id`);
    seen.add(f.id);
    if (f.severity && !SEVERITIES.includes(f.severity)) errors.push(`${f.id}: bad severity: ${f.severity}`);
    for (const k of required) if (!f[k]) errors.push(`${f.id}: missing field: ${k}`);
    if (doc.round === 2) {
      if (!f.status) errors.push(`${f.id}: missing field: status`);
      else if (f.status !== 'resolved' && f.status !== 'open') errors.push(`${f.id}: bad status: ${f.status}`);
    }
  }
  const verdict = doc.header.verdict;
  if (doc.kind === 'findings' && verdict) {
    // Round 2 counts only findings still open; round 1 counts all.
    const n = doc.findings.filter((f) => f.status !== 'resolved').length;
    const vm = verdict.match(/^(?:CLEAN|FINDINGS (\d+))$/);
    if (!vm) errors.push(`header: verdict must be CLEAN or FINDINGS <n>, got "${verdict}"`);
    else if ((vm[1] === undefined ? 0 : Number(vm[1])) !== n || (vm[1] !== undefined && n === 0)) {
      errors.push(`header: verdict "${verdict}" does not match ${n} ${doc.round === 2 ? 'open ' : ''}finding(s)`);
    }
  }
  return { ok: errors.length === 0, errors, doc };
}

function mustValidate(text) {
  const v = validate(text);
  if (!v.ok) throw new Error(`invalid findings file: ${v.errors.join('; ')}`);
  return v.doc;
}

function renderBlocks(title, findings, keep, withSeverity) {
  const out = [title, ''];
  for (const f of findings) {
    out.push(withSeverity ? `## ${f.id} · ${f.severity} · ${f.location}` : `## ${f.id} · ${f.location}`);
    for (const k of keep) if (f[k] !== undefined) out.push(`${k}: ${f[k]}`);
    out.push('');
  }
  return out.join('\n');
}

// The fixer's copy (D4): ids, locations, findings, tests. No severity, no why_severity, and no
// if_unfixed either -- the consequence line tells the fixer how bad a finding is.
function stripForFixer(text) {
  const doc = mustValidate(text);
  const title = doc.kind === 'debt' ? '# Fixer copy · debt' : `# Fixer copy · ${doc.slice} · round ${doc.round}`;
  return renderBlocks(title, doc.findings, ['finding', 'test'], false);
}

// The blind re-rate copy (D7): severity, why_severity and any earlier blind_severity removed;
// the consequence stays, because it is what the reviewer rates.
function stripSeverity(text) {
  const doc = mustValidate(text);
  const title = doc.kind === 'debt' ? '# Blind re-rate · debt' : `# Blind re-rate · ${doc.slice}`;
  return renderBlocks(title, doc.findings, ['finding', 'if_unfixed', 'test', 'origin'], false);
}

// Fixer final message -> Map(id -> {mark: 'OUT_OF_SLICE'|'ATTEMPTED', why}).
function parseFixerReport(report) {
  const marks = new Map();
  for (const line of String(report || '').split(/\r?\n/)) {
    const m = line.match(/^[\s\-*]*(\S+)\s+(OUT_OF_SLICE|ATTEMPTED)\b:?\s*(.*)$/);
    if (m) marks.set(m[1], { mark: m[2], why: m[3].trim() });
  }
  return marks;
}

function escalate(sev) { return SEVERITIES[Math.min(SEVERITIES.indexOf(sev) + 1, SEVERITIES.length - 1)]; }

// D4, applied after the one re-review. Returns {resolved, owner, debt}; owner entries carry the
// post-escalation `severity`, the `original_severity` and a `reason`.
//   resolved                                  -> closed
//   open, fixer marked OUT_OF_SLICE:
//       blocker/major                         -> owner (as rated)
//       minor/nit                             -> debt
//   open, fixer ATTEMPTED it or claimed fixed -> one level up -> owner
//   open, new in round 2 (only knowable when round1 is given) -> as OUT_OF_SLICE: never attempted
// Without round1 every open finding counts as previous: unknown errs toward the owner.
function applyClosePolicy(round2, fixerReport, round1) {
  const doc = mustValidate(round2);
  if (doc.kind !== 'findings' || doc.round !== 2) throw new Error('applyClosePolicy needs a round 2 findings file');
  const prev = round1 === undefined ? null : new Set(mustValidate(round1).findings.map((f) => f.id));
  const marks = parseFixerReport(fixerReport);
  const out = { resolved: [], owner: [], debt: [] };
  for (const f of doc.findings) {
    if (f.status === 'resolved') { out.resolved.push(f); continue; }
    const mark = marks.get(f.id);
    const isNew = prev !== null && !prev.has(f.id);
    if (isNew || (mark && mark.mark === 'OUT_OF_SLICE')) {
      const why = isNew ? 'new in round 2' : 'OUT_OF_SLICE';
      if (f.severity === 'blocker' || f.severity === 'major') {
        out.owner.push({ ...f, original_severity: f.severity, reason: `open ${f.severity}, ${why}` });
      } else {
        out.debt.push(f);
      }
      continue;
    }
    const reason = mark ? `ATTEMPTED: ${mark.why}` : 'fixer claimed fixed, re-review found it open';
    out.owner.push({ ...f, severity: escalate(f.severity), original_severity: f.severity, reason });
  }
  return out;
}

// Appends parked findings to debt.md text (created when empty). Ids become <origin>/<id>;
// an id already present is skipped, so re-running a close is harmless.
function mergeToDebt(debtText, items, { origin, parked }) {
  const existing = debtText && String(debtText).trim() ? mustValidate(debtText).findings : [];
  const have = new Set(existing.map((f) => f.id));
  const added = items
    .map((f) => ({ ...f, id: f.id.includes('/') ? f.id : `${origin}/${f.id}`, origin: f.origin || origin, parked: f.parked || parked }))
    .filter((f) => !have.has(f.id));
  return renderBlocks('# Debt', [...existing, ...added], [...DEBT_FIELDS, 'blind_severity'], true);
}

// D6: the next sprint must not start when this hits. Fails closed on an invalid debt.md.
function debtCapHit(debtText) {
  if (!debtText || !String(debtText).trim()) return { hit: false, total: 0, reasons: [] };
  const v = validate(debtText);
  if (!v.ok || v.doc.kind !== 'debt') return { hit: true, total: v.doc.findings.length, reasons: [`invalid debt.md: ${v.errors.join('; ') || 'not a debt file'}`] };
  const total = v.doc.findings.length;
  const reasons = [];
  if (total > DEBT_MAX_TOTAL) reasons.push(`${total} items > ${DEBT_MAX_TOTAL}`);
  const perFile = {};
  for (const f of v.doc.findings) perFile[f.file] = (perFile[f.file] || 0) + 1;
  for (const [file, n] of Object.entries(perFile)) if (n > DEBT_MAX_PER_FILE) reasons.push(`${file}: ${n} items > ${DEBT_MAX_PER_FILE}`);
  return { hit: reasons.length > 0, total, reasons };
}

module.exports = {
  parse, validate, stripForFixer, applyClosePolicy, debtCapHit, mergeToDebt, stripSeverity,
  parseFixerReport, SEVERITIES, MAX_BYTES, MAX_FINDINGS, DEBT_MAX_TOTAL, DEBT_MAX_PER_FILE,
};
