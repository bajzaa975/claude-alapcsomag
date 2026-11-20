'use strict';
// PreToolUse autopilot guard: while autopilot is on, AskUserQuestion and blocking ask_owner calls are denied.
// Non-blocking ask_owner and every other tool pass. Off -> allow. A throw is logged and allowed by pre-tool.
const path = require('node:path');
const RULE = 'autopilot-guard';
const REASON = 'Autopilot: no blocking owner questions. Take the default / least risky reversible choice, log it in the decision log, continue; a risky item goes to the panel with blocking=false and is parked. The owner ends autopilot by typing `autopilot off`.';
const OFF_CMD = `node ${path.resolve(__dirname, '../../skills/autopilot/autopilot-state.js')} off`;

function check(input) {
  if (!input) return null;
  const t = input.tool_name;
  const blocking = t === 'AskUserQuestion' || (typeof t === 'string' && /ask_owner$/.test(t) && !!input.tool_input && input.tool_input.blocking === true);
  if (!blocking) return null;
  if (!require('./lib/autopilot').isOn({ env: process.env, sessionId: input.session_id })) return null;
  return { kind: 'deny', rule: RULE, reason: `${REASON} A stale marker is cleared with: ${OFF_CMD}` };
}

module.exports = { check };
