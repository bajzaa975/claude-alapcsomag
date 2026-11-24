'use strict';
// Owner questions rule, SessionStart: with env ORCH_BUS_PANE non-empty (an orchestrator pane) prints RULE
// as additionalContext; silent otherwise. Touches no files. Fail-open via runHook.
const { runHook, addContext } = require('./lib/hook-io');

const RULE = [
  'OWNER QUESTIONS PANEL (orchestrator pane session).',
  'If the orch-bus tool `ask_owner` (`mcp__orch-bus__ask_owner`) is available, EVERY question, decision or manual step for the owner goes through it, never as chat text or a question dialog. It may show only as a deferred tool name: load it with ToolSearch `select:mcp__orch-bus__ask_owner` before deciding it is absent. While available it replaces every other channel your instructions name for owner questions and steps (chat, question dialogs, an Artifact checklist).',
  '- Fields: kind "question", "step" or "info" (info: no options, never blocking); title (at most 80 characters); question in plain words (step: where, exact command, how success looks); why it matters; options, recommendation first, also in `recommended`; `default_taken`; `blocking`.',
  "- Then write only the one line the tool reply gives after \"Now write only:\"; if none: question -> 'Question for you in the panel: <title>', step -> 'Step for you in the panel (Your steps): <title>', info -> 'Info for you in the panel: <title>'.",
  '- If the owner answers in the chat instead and the orch-bus tool `owner_answered` (`mcp__orch-bus__owner_answered`, loaded like ask_owner) is available, call it with the returned id and the answer, so the panel card closes.',
  '- If undoable, set default_taken, carry on with it and do not wait. Only for risky or irreversible ones set blocking=true and end your turn; the answer arrives as your next message.',
  '- No person at the keyboard (claude -p, autopilot, night run): never set blocking=true. Post blocking=false (no default if risky), park it, go on; under autopilot a hook refuses blocking=true and AskUserQuestion.',
  '- Plain words: no internal labels, IDs, finding numbers or file:line pins.',
  '- Never put a password, token, key or other secret in any field or ask the owner to send one; a step needing a secret says where the owner enters it.',
  'If the tool is absent or errors, ask the way your other instructions say.',
].join('\n');

function main() {
  if (process.env.ORCH_BUS_PANE) addContext('SessionStart', RULE);
}

if (require.main === module) runHook('ask-owner', main);
else module.exports = { RULE };
