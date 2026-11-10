'use strict';
// PreToolUse critic gate for the Skill tool: in an M/L repo (.claude/project-profile.json size) the two superpowers
// execution skills need the plan path in their args and a ready critic file (runtime/critic/<stem>.md, triaged or
// `skipped: <reason>`). Plan path: docs/superpowers/plans/<stem>.md or runtime/plans/<stem>.md. S/XS/no profile,
// other skills and other tools pass. Fs only; a throw is logged and allowed by pre-tool's runChecks.
const SKILLS = /^superpowers:(?:subagent-driven-development|executing-plans)$/;
const PLAN = /(?:docs\/superpowers\/plans|runtime\/plans)\/([a-z0-9][a-z0-9-]{0,63})\.md/;
const RULE = 'critic-gate';

function check(input) {
  if (!input || input.tool_name !== 'Skill') return null;
  const ti = input.tool_input;
  if (!ti || typeof ti.skill !== 'string' || !SKILLS.test(ti.skill)) return null;
  const C = require('../../lib/critic');
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const size = C.projectSize(cwd);
  if (size !== 'M' && size !== 'L') return null;
  const m = String(ti.args || '').replace(/\\/g, '/').match(PLAN);
  if (!m) return { kind: 'deny', rule: RULE, reason: `${ti.skill} in an ${size} repo needs the plan path (docs/superpowers/plans/<stem>.md or runtime/plans/<stem>.md) in its args, so the plan critic can be checked.` };
  const r = C.criticReady(cwd, m[1]);
  if (r.ok) return null;
  return { kind: 'deny', rule: RULE, reason: `critic not ready for ${m[1]}: ${r.why}. Run /bajzi:critic ${m[1]} first.` };
}

module.exports = { check };
