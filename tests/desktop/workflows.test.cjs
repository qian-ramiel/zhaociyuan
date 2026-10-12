const test = require('node:test');
const assert = require('node:assert/strict');
const { workflowsForMode, mergeModeWorkflows } = require('../../apps/desktop/workflows.mjs');

const items = [
  { id: 'shared', mode: 'all', prompt: 'shared' },
  { id: 'daily', mode: 'daily', prompt: 'daily' },
  { id: 'game', mode: 'game', prompt: 'game' },
];

test('mode workflow editor includes its own and explicitly shared flows only', () => {
  assert.deepEqual(workflowsForMode(items, 'game').map((w) => w.id), ['shared', 'game']);
  assert.equal(items.length, 3);
});

test('saving, creating or removing flows in one mode preserves other modes', () => {
  const edited = mergeModeWorkflows(items, [{ ...items[0], prompt: 'shared edit' }, { id: 'new-game', mode: 'game', prompt: 'new' }], 'game');
  assert.deepEqual(edited[0], items[1]);
  assert.deepEqual(edited.map((w) => w.id), ['daily', 'shared', 'new-game']);
  assert.equal(items[0].prompt, 'shared');
  assert.equal(items[2].id, 'game');
});

test('scoped workflow editor cannot silently overwrite a different mode', () => {
  assert.throws(() => mergeModeWorkflows(items, [{ id: 'invalid', mode: 'daily' }], 'game'), /当前模式/);
});
