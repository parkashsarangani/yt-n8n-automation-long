const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, historyPathFor } = require('../compose.js');

test('audio-first compositor exports an express app', () => {
  assert.equal(typeof app, 'function');
});

test('topic history is isolated and sanitized by niche', () => {
  const p = historyPathFor('History & Mystery');
  assert.equal(path.basename(p), 'topic_history_HistoryMystery.json');
  assert.equal(path.basename(historyPathFor('../')), 'topic_history_default.json');
});
