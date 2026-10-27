'use strict';
// The per-size project kit (data + pure helpers) for profile.js. Additive: a bigger size only adds.
const SIZES = ['XS', 'S', 'M', 'L'];
const KIT_BEGIN = '<!-- bajzi:project-setup kit begin -->';
const KIT_END = '<!-- bajzi:project-setup kit end -->';

const RULES = {
  XS: [
    'General repo: mixed small asks and questions, one notes/<topic>/ folder per topic.',
    'No plan and no review unless the change touches a real system (a server, a device, shared config); then plan it first.',
    'No secrets in files: keyring references only.',
    'Done = the question is answered or the change is checked on the real system.',
  ],
  S: [
    'Local git; working state in runtime/handoff/<branch-slug>.md (runtime/ is gitignored).',
    'Tests for every behaviour change.',
    'One written plan per feature before code.',
    "Done = tests green, the plan's items done, handoff updated.",
  ],
  M: [
    'The bajzi pre-commit gate must pass; never --no-verify.',
    'Review: Sonnet writes every slice; the reviewer allow-list model (Opus) reviews each sprint once over its whole commit range, two rounds max; test gaps are listed, never looped on.',
    'UAT checklist per release: docs/uat/<release>.md, ticked on the deployed sandbox.',
    'Deploy description: docs/DEPLOY.md (target, how to deploy, how to check, rollback).',
    'Done = S + gate green + review CLEAN + UAT checklist passed.',
  ],
  L: [
    'CI required: hosting github -> a workflow in .github/workflows runs the tests on every push (`/bajzi:project-setup --check` reports kit-ci until one exists); hosting local -> gate and tests before every push.',
    'Every release: release notes in CHANGELOG.md and a rollback plan in docs/rollback.md.',
    'Features start from a respec-cards spec (/bajzi:respec-cards) before the plan.',
    'Definition of done: docs/definition-of-done.md.',
    'Done = M + CI green + release notes + rollback plan.',
  ],
};
const HOSTING = {
  local: '- Hosting local: never push to GitHub; .githooks/pre-push refuses GitHub remotes.',
  github: '- Hosting github: GitHub pushes allowed.',
};
// [the size a trigger points to, its line]
const TRIGGERS = [
  ['S', '- XS -> S: a topic spans more than 2 sessions, produces lasting code or scripts, needs tests, or outgrows one note: suggest making it a small project.'],
  ['M', '- -> M: a deploy target, another user, or personal data or money.'],
  ['L', '- -> L: production users with a release cycle, more than one developer, or more than one service or repo.'],
];

const rank = size => SIZES.indexOf(size);
const rulesUpTo = size => SIZES.slice(0, rank(size) + 1).flatMap(s => RULES[s]);

function sizeBlock(size, hosting) {
  const lines = [KIT_BEGIN, `## Project size: ${size}   (hosting: ${hosting})`, ...rulesUpTo(size).map(r => '- ' + r), HOSTING[hosting]];
  // XS gets only XS -> S; the others get every trigger above their size; L gets none.
  const trig = TRIGGERS.filter(([to]) => rank(to) > rank(size) && (size !== 'XS' || to === 'S')).map(t => t[1]);
  if (trig.length) {
    lines.push('## Size triggers (check before writing every new plan)', ...trig,
      '- When one fires: propose the upgrade to the owner; after OK set "size" in .claude/project-profile.json (for M/L also add "gate", see /bajzi:project-setup Size upgrade) and run /bajzi:project-setup (it only adds).');
  }
  return [...lines, KIT_END].join('\n');
}

const FILES = {
  M: [
    { rel: 'docs/uat/README.md', text: '# UAT checklists\n\nOne checklist per release: docs/uat/<release>.md, ticked on the deployed sandbox.\n\n- TODO: write the first release checklist.\n' },
    { rel: 'docs/DEPLOY.md', text: '# Deploy\n\n- TODO: target\n- TODO: how to deploy\n- TODO: how to check\n- TODO: rollback\n' },
  ],
  L: [
    { rel: 'CHANGELOG.md', text: '# Changelog\n\n## Unreleased\n- TODO: release notes\n' },
    { rel: 'docs/rollback.md', text: '# Rollback plan\n\n- TODO: how to roll back the current release\n- TODO: how to check the rollback worked\n' },
    { rel: 'docs/definition-of-done.md', text: '# Definition of done\n\n' + rulesUpTo('L').filter(r => r.startsWith('Done =')).map(r => '- ' + r).join('\n') + '\n- TODO: project-specific additions\n' },
  ],
};

const scaffold = size => SIZES.slice(0, rank(size) + 1).flatMap(s => FILES[s] || []);

module.exports = { SIZES, KIT_BEGIN, KIT_END, rank, sizeBlock, scaffold };
