'use strict';
// Prompt-injection patterns for tool output. Own patterns, written for bajzi. A hit is a
// WARNING only (the scanner never blocks), so the rules favour recall over precision.
const REGEX_RULES = [
  ['ignore-previous', /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your)\s+)*(?:previous|prior|above|earlier|preceding)\s+(?:instructions|prompts?|rules|messages|directions)/i],
  ['new-instructions', /\b(?:your\s+new\s+(?:instructions|task|role)\s+(?:is|are)|new\s+system\s+prompt|from\s+now\s+on,?\s+you\s+(?:will|must|are|should))/i],
  ['role-reassign', /\byou\s+are\s+now\s+(?:a|an|the|in)\s+\w+/i],
  ['pretend-role', /\b(?:pretend|imagine)\s+(?:to\s+be|you\s+are|that\s+you\s+are)\b/i],
  ['jailbreak-mode', /\b(?:developer\s+mode\s+(?:enabled|on|activated)|do\s+anything\s+now|jailbreak(?:ed)?\s+mode)\b/i],
  ['fake-system-tag', /<\s*\/?\s*(?:system|system-reminder|system_prompt|sys)\s*>/i],
  ['fake-chat-template', /\[\/?INST\]|<<\/?SYS>>|<\|im_(?:start|end)\|>|<\|(?:system|assistant|user)\|>/],
  ['fake-role-header', /^[ \t]*(?:#{1,3}[ \t]*)?(?:SYSTEM|ASSISTANT)(?:[ \t]+PROMPT)?[ \t]*:/m],
  ['prompt-exfil', /\b(?:reveal|print|show|repeat|output|leak|dump)\s+(?:me\s+)?(?:your|the)\s+(?:(?:full|entire|original)\s+)?(?:system\s+prompt|initial\s+instructions|hidden\s+instructions|instructions\s+above)/i],
  ['secret-exfil', /\b(?:send|post|upload|exfiltrate|forward|email)\b[^\n]{0,60}?(?:\b(?:api[\s_-]?keys?|credentials|secrets?|tokens?|passwords?|ssh\s+keys?)\b|\.env\b)[^\n]{0,60}?\b(?:to|at)\s+(?:https?:\/\/|[\w.+-]+@[\w-]+\.)/i],
  ['hide-from-user', /\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to)\s+the\s+user\b/i],
  ['tool-coercion', /\b(?:run|execute)\s+(?:the\s+following|this)\s+(?:command|code|script)s?\s*:?\s*(?:immediately|now|right\s+away|without\s+(?:asking|confirmation|approval))/i],
  ['ai-directed', /\b(?:attention|note\s+to|message\s+(?:to|for)|instructions?\s+for)\s+(?:the\s+)?(?:claude|ai\s+assistant|ai|llm|language\s+model)\b/i],
  ['javascript-link', /(?:\]\(\s*|\bhref\s*=\s*["']?\s*)javascript:/i],
  ['data-link', /(?:\]\(\s*|\b(?:href|src)\s*=\s*["']?\s*)data:(?:text\/html|application\/(?:x-)?javascript|image\/svg\+xml)/i],
];

// ZWJ (U+200D) is deliberately excluded: emoji sequences use it legitimately.
const ZERO_WIDTH = /[​‌‎‏⁠-⁤]/g;
const BIDI = /[‪-‮⁦-⁩]/g;
const TAG_BLOCK = /[\u{E0000}-\u{E007F}]/gu;

const RULE_IDS = [...REGEX_RULES.map(r => r[0]), 'invisible-unicode', 'unicode-tag-block'];

function count(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function excerptAt(text, index, len) {
  const s = text.slice(Math.max(0, index - 20), index + Math.max(len, 40) + 20).replace(/\s+/g, ' ').trim();
  return s.length > 100 ? s.slice(0, 100) : s;
}

function scan(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  for (const [rule, re] of REGEX_RULES) {
    const m = re.exec(text);
    if (m) hits.push({ rule, excerpt: excerptAt(text, m.index, m[0].length) });
  }
  const zw = count(text, ZERO_WIDTH);
  const bidi = count(text, BIDI);
  if (zw >= 3 || bidi >= 1) hits.push({ rule: 'invisible-unicode', excerpt: `${zw} zero-width and ${bidi} bidi control code point(s)` });
  const tags = count(text, TAG_BLOCK);
  if (tags >= 1) hits.push({ rule: 'unicode-tag-block', excerpt: `${tags} Unicode tag-block code point(s)` });
  return hits;
}

module.exports = { scan, RULE_IDS };
