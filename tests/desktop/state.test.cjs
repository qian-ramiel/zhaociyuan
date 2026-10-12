const test = require('node:test');
const assert = require('node:assert/strict');
const { cropBounds, safeSource, overlaySize } = require('../../apps/desktop/state.cjs');

test('capture region stays inside the selected source', () => {
  assert.deepEqual(cropBounds({ x: .1, y: .2, width: .5, height: .5 }, { width: 1600, height: 1000 }), { x: 160, y: 200, width: 800, height: 500 });
  for (const region of [{ x: -.1, y: 0, width: .5, height: .5 }, { x: .7, y: 0, width: .5, height: .5 }, { x: 0, y: 0, width: NaN, height: .5 }]) assert.throws(() => cropBounds(region, { width: 1600, height: 1000 }));
});
test('only known native capture-source formats are accepted', () => {
  assert.ok(safeSource('window:1234:0'));
  assert.ok(safeSource('screen:0:0'));
  assert.equal(safeSource('file:///etc/passwd'), false);
  assert.equal(safeSource(null), false);
});
test('mini consumes less desktop area than full-body', () => {
  const mini = overlaySize('mini'), full = overlaySize('full');
  assert.ok(mini.width * mini.height < full.width * full.height);
});
test('character scaling retains default sizes and keeps mini toolbar usable', () => {
  assert.deepEqual(overlaySize('half'), { width: 350, height: 546 });
  assert.deepEqual(overlaySize('half', 1.5), { width: 525, height: 771 });
  assert.deepEqual(overlaySize('mini', .65), { width: 260, height: 317 });
  assert.deepEqual(overlaySize('full', Infinity), overlaySize('full'));
  assert.deepEqual(overlaySize('full', 99), overlaySize('full', 1.6));
});
test('bubble height reserves only its own space without changing character dimensions', () => {
  for (const framing of ['half', 'full', 'mini']) {
    const small = overlaySize(framing, 1, 56), large = overlaySize(framing, 1, 280);
    assert.equal(large.width, small.width);
    assert.equal(large.height - small.height, 224);
    assert.deepEqual(overlaySize(framing, 1, NaN), overlaySize(framing));
  }
});
