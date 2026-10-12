const test = require('node:test');
const assert = require('node:assert/strict');
const { validRegions, ignoresPointer } = require('../../apps/desktop/pointer-regions.cjs');

test('pointer regions reject malformed or excessive geometry without changing a valid map', () => {
  assert.deepEqual(validRegions([]), []);
  assert.deepEqual(validRegions([{ x: 1.5, y: -4, width: 32, height: 28, extra: 1 }]), [{ x: 1.5, y: -4, width: 32, height: 28 }]);
  for (const value of [null, {}, [{ x: 0, y: 0, width: 0, height: 1 }], [{ x: 0, y: NaN, width: 1, height: 1 }], [{ x: '0', y: 0, width: 1, height: 1 }], Array(21).fill({ x: 0, y: 0, width: 1, height: 1 })]) assert.equal(validRegions(value), null);
});

test('screen-to-window hit testing works on a moved negative-origin secondary display', () => {
  const regions = [{ x: 20, y: 100, width: 200, height: 300 }];
  const bounds = { x: -1400, y: -600, width: 350, height: 546 };
  assert.equal(ignoresPointer({ x: -1300, y: -595 }, bounds, regions, false), true);
  assert.equal(ignoresPointer({ x: -1380, y: -500 }, bounds, regions, false), false);
  assert.equal(ignoresPointer({ x: -1180, y: -200 }, bounds, regions, false), true);
  assert.equal(ignoresPointer({ x: -1300, y: -400 }, bounds, [], false), true);
});

test('explicit click-through wins over captured resize; capture ends without intercepting blank space', () => {
  const bounds = { x: 0, y: 0 }, point = { x: 5, y: 5 };
  assert.equal(ignoresPointer(point, bounds, [], false, true), false);
  assert.equal(ignoresPointer(point, bounds, [], true, true), true);
  assert.equal(ignoresPointer(point, bounds, [], false, false), true);
});
