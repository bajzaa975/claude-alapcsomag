'use strict';
// Shared stdin/stdout plumbing for the bajzi node hooks.
// Every hook FAILS OPEN: any internal error = exit 0 with no stdout (= allow), plus one line
// in ~/.claude/bajzi/hook-errors.log (capped at LOG_CAP). Never prints a stack trace.
// At most ONE JSON object is written per process: a second emit is ignored.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_CAP = 256 * 1024;
let emitted = false;

function parseInput(raw) {
  if (typeof raw !== 'string') return null;
  const s = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function readInput() {
  try {
    return parseInput(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// Writes the whole buffer to stdout, looping on short writes. A write failure (EPIPE when the
// reader went away, EAGAIN on a non-blocking pipe, ...) is swallowed: fail open even outside runHook.
function writeAll(text) {
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    let stalls = 0;
    while (off < buf.length) {
      const n = fs.writeSync(1, buf, off, buf.length - off);
      if (n > 0) { off += n; stalls = 0; } else if (++stalls > 100) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function write(obj) {
  if (emitted) return;
  emitted = true;
  writeAll(JSON.stringify(obj));
}

function allow() {
  // No output and exit 0 = allow. Kept as a function so call sites read as a decision.
}

function denyPayload(reason, rule) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[bajzi:${rule}] ${reason}`,
    },
  };
}

function contextPayload(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function deny(reason, rule) { write(denyPayload(reason, rule)); }
function addContext(event, text) { write(contextPayload(event, text)); }

function logError(name, err, home = os.homedir()) {
  try {
    const dir = path.join(home, '.claude', 'bajzi');
    const file = path.join(dir, 'hook-errors.log');
    fs.mkdirSync(dir, { recursive: true });
    const msg = String((err && err.message) || err).replace(/[\r\n]+/g, ' ').slice(0, 300);
    const line = `${new Date().toISOString()} ${name} ${msg}\n`;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size + Buffer.byteLength(line) > LOG_CAP) {
      const buf = fs.readFileSync(file);
      let keep = buf.subarray(Math.max(0, buf.length - LOG_CAP / 2));
      const nl = keep.indexOf(0x0a);
      keep = nl >= 0 ? keep.subarray(nl + 1) : Buffer.alloc(0);
      fs.writeFileSync(file, Buffer.concat([keep, Buffer.from(line)]));
    } else {
      fs.appendFileSync(file, line);
    }
  } catch {
    // The error log must never break a hook.
  }
}

let handlersInstalled = false;

// fn MUST be synchronous: runHook awaits nothing and sets exitCode as soon as fn returns.
// As a safety net it also installs process-level uncaughtException / unhandledRejection handlers,
// so a stray async failure (a rejected promise, a throw in a timer) still exits 0 with no
// stdout/stderr and one log line -- but whatever that async work meant to emit is lost.
function runHook(name, fn) {
  if (!handlersInstalled) {
    handlersInstalled = true;
    const bail = err => {
      logError(name, err);
      process.exit(0);
    };
    process.on('uncaughtException', bail);
    process.on('unhandledRejection', bail);
  }
  try {
    fn();
  } catch (err) {
    logError(name, err);
  }
  process.exitCode = 0;
}

module.exports = {
  parseInput, readInput, allow, deny, addContext, denyPayload, contextPayload, logError, runHook, writeAll, LOG_CAP,
};
