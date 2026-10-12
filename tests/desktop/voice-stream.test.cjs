const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPushToTalk } = require('../../apps/desktop/push-to-talk.cjs');
const { readEvents } = require('../../apps/desktop/stream.cjs');

const keys = { Space: 57, F8: 66, Escape: 1, Ctrl: 29, CtrlRight: 3613, Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676, Alt: 56, AltRight: 3640 };
function fixture(platform = 'darwin') {
  const hook = new EventEmitter(); let starts = 0, stops = 0;
  hook.start = () => starts++; hook.stop = () => stops++;
  const commands = [];
  const controller = createPushToTalk(hook, keys, platform, (value) => commands.push(value));
  return { controller, commands, hook, starts: () => starts, stops: () => stops };
}
test('hold shortcut ignores repeats, sends on release or early modifier release, cancels on Escape', () => {
  const f = fixture(); f.controller.start('CommandOrControl+Shift+Space');
  const press = { keycode: keys.Space, metaKey: true, shiftKey: true };
  f.hook.emit('keydown', press); f.hook.emit('keydown', press);
  assert.deepEqual(f.commands, ['ptt-start']);
  f.hook.emit('keyup', { keycode: keys.Meta }); f.hook.emit('keyup', { keycode: keys.Space });
  assert.deepEqual(f.commands, ['ptt-start', 'ptt-end']);
  f.hook.emit('keydown', press); f.hook.emit('keydown', { keycode: keys.Escape });
  assert.deepEqual(f.commands.slice(-2), ['ptt-start', 'ptt-cancel']);
  f.controller.stop(); assert.equal(f.hook.listenerCount('keydown'), 0); assert.equal(f.stops(), 1);
});
test('shortcut modifiers and platform are exact; turning off held shortcut cancels recording', () => {
  const f = fixture('win32'); f.controller.start('Control+Alt+Space');
  f.hook.emit('keydown', { keycode: keys.Space, ctrlKey: true, altKey: true, shiftKey: true });
  assert.deepEqual(f.commands, []);
  f.hook.emit('keyup', { keycode: keys.Space });
  f.hook.emit('keydown', { keycode: keys.Space, ctrlKey: true, altKey: true });
  f.controller.stop(); assert.deepEqual(f.commands, ['ptt-start', 'ptt-cancel']);
});
test('failed hook startup removes listeners', () => {
  const f = fixture(); f.hook.start = () => { throw Error('permission'); };
  assert.throws(() => f.controller.start('F8'), /permission/);
  assert.equal(f.hook.listenerCount('keydown'), 0); assert.equal(f.hook.listenerCount('keyup'), 0);
});
test('left and right Shift start only together, accept either order and end on either release', () => {
  for (const order of [[keys.Shift, keys.ShiftRight], [keys.ShiftRight, keys.Shift]]) {
    const f = fixture(); f.controller.start('ShiftLeft+ShiftRight');
    f.hook.emit('keydown', { keycode: order[0], shiftKey: true });
    f.hook.emit('keydown', { keycode: order[0], shiftKey: true });
    assert.deepEqual(f.commands, []);
    f.hook.emit('keydown', { keycode: order[1], shiftKey: true });
    f.hook.emit('keydown', { keycode: order[1], shiftKey: true });
    assert.deepEqual(f.commands, ['ptt-start']);
    f.hook.emit('keyup', { keycode: order[0] });
    f.hook.emit('keyup', { keycode: order[1] });
    assert.deepEqual(f.commands, ['ptt-start', 'ptt-end']);
    f.controller.stop();
  }
});
test('double Shift ignores Space and extra modifiers; Escape cancels without repeat restart', () => {
  const f = fixture(); f.controller.start('ShiftLeft+ShiftRight');
  f.hook.emit('keydown', { keycode: keys.Shift });
  f.hook.emit('keydown', { keycode: keys.Space });
  f.hook.emit('keydown', { keycode: keys.ShiftRight, ctrlKey: true });
  assert.deepEqual(f.commands, []);
  f.hook.emit('keyup', { keycode: keys.ShiftRight });
  f.hook.emit('keydown', { keycode: keys.ShiftRight });
  f.hook.emit('keydown', { keycode: keys.Escape });
  f.hook.emit('keydown', { keycode: keys.ShiftRight });
  assert.deepEqual(f.commands, ['ptt-start', 'ptt-cancel']);
  f.controller.stop();
});
test('stream reader preserves split UTF-8 and NDJSON and releases the reader', async () => {
  const data = new TextEncoder().encode('{"type":"text","delta":"你好"}\n{"type":"done"}\n');
  const events = [];
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < data.length; i++) controller.enqueue(data.slice(i, i + 1)); controller.close(); } });
  await readEvents({ body }, (event) => events.push(event));
  assert.deepEqual(events, [{ type: 'text', delta: '你好' }, { type: 'done' }]);
  assert.equal(body.locked, false);
});
test('malformed stream fails and still releases the reader', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('not-json\n')); controller.close(); } });
  await assert.rejects(readEvents({ body }, () => {})); assert.equal(body.locked, false);
});
