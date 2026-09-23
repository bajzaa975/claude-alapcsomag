'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { peakStatus } = require('../lib/peak');

const at = (h, m = 0, s = 0) => Date.UTC(2026, 8, 23, h, m, s);

test('before the window: minutes to start, rounded up', () => {
  assert.deepStrictEqual(peakStatus(at(5, 0)), { inPeak: false, minsToStart: 60, minsToEnd: null });
  assert.deepStrictEqual(peakStatus(at(5, 59, 30)), { inPeak: false, minsToStart: 1, minsToEnd: null });
});

test('06:00 UTC is inside (= 14:00 UTC+8), 4 h to the end', () => {
  assert.deepStrictEqual(peakStatus(at(6, 0)), { inPeak: true, minsToStart: null, minsToEnd: 240 });
});

test('09:59 UTC is inside with 1 minute left', () => {
  assert.deepStrictEqual(peakStatus(at(9, 59)), { inPeak: true, minsToStart: null, minsToEnd: 1 });
});

test('10:00 UTC is outside; the next start is tomorrow 06:00', () => {
  assert.deepStrictEqual(peakStatus(at(10, 0)), { inPeak: false, minsToStart: 1200, minsToEnd: null });
});

test('late evening UTC counts to the next day', () => {
  assert.deepStrictEqual(peakStatus(at(23, 0)), { inPeak: false, minsToStart: 420, minsToEnd: null });
});
