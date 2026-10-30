'use strict';
// Owner questions rule, SessionStart: with env ORCH_BUS_PANE non-empty (an orchestrator pane) prints RULE
// as additionalContext; silent otherwise. Touches no files. Fail-open via runHook.
const { runHook, addContext } = require('./lib/hook-io');

const RULE = [
  'OWNER QUESTIONS PANEL (this session runs in an orchestrator pane).',
  'If the orch-bus tool `ask_owner` (`mcp__orch-bus__ask_owner`) is available, EVERY question or decision for the owner and EVERY manual step only the owner can do goes through it, never as chat text or a question dialog. It may show only as a deferred tool name: load it with ToolSearch `select:mcp__orch-bus__ask_owner` before deciding it is absent. While it is available it replaces every other channel your instructions name for owner questions and owner steps (chat, question dialogs, an Artifact checklist).',
  '- Fields: kind "question" or "step"; title (at most 80 characters); question in plain words (for a step: where, the exact command, how success looks); why it matters; options with your recommendation first, also named in `recommended`; `default_taken`; `blocking`.',
  "- Then write only one line in the chat: 'Question for you in the panel: <title>'.",
  '- If the owner answers a panel question in the chat instead and the orch-bus tool `owner_answered` (`mcp__orch-bus__owner_answered`, loaded like ask_owner) is available, call it with the id ask_owner returned and the answer, so the panel card closes.',
  '- If the decision can be undone, set default_taken, carry on with it and do not wait. Only for risky or irreversible decisions set blocking=true and end your turn; the owner\'s answer arrives as your next message.',
  '- No person at the keyboard (claude -p / print mode, autopilot, night run): never set blocking=true. Post it with blocking=false (no default for a risky one), park that item and continue with the rest.',
  '- Plain words: no internal labels, IDs, finding numbers or file:line pins in owner text.',
  '- Never put a password, token, key or any other secret or credential value in any field, and never ask the owner to send one; a step that needs a secret says where the owner enters it themselves.',
  'If the tool is absent or the call returns an error, ask the way your other instructions say.',
].join('\n');

function main() {
  if (process.env.ORCH_BUS_PANE) addContext('SessionStart', RULE);
}

if (require.main === module) runHook('ask-owner', main);
else module.exports = { RULE };
