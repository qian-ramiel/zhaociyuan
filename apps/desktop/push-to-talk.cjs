function createPushToTalk(hook, keys, platform, command) {
  let held = false, timer;
  let accelerator = 'ShiftLeft+ShiftRight';
  const pressed = new Set();
  const target = () => accelerator === 'F8' ? keys.F8 : keys.Space;
  const matches = (event) => accelerator === 'F8' ? !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    : accelerator === 'Control+Alt+Space' ? event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey
      : event.shiftKey && !event.altKey && (platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
  const release = (cancel = false) => {
    if (!held) return;
    held = false; clearTimeout(timer);
    command(cancel ? 'ptt-cancel' : 'ptt-end');
  };
  const down = (event) => {
    const repeated = pressed.has(event.keycode);
    pressed.add(event.keycode);
    if (event.keycode === keys.Escape) { release(true); return; }
    if (held || repeated) return;
    if (accelerator === 'ShiftLeft+ShiftRight') {
      if (![keys.Shift, keys.ShiftRight].includes(event.keycode) || !pressed.has(keys.Shift) || !pressed.has(keys.ShiftRight) || event.ctrlKey || event.altKey || event.metaKey) return;
    } else if (event.keycode !== target() || !matches(event)) return;
    held = true; command('ptt-start');
    timer = setTimeout(() => release(true), 60000); timer.unref?.();
  };
  const up = (event) => {
    pressed.delete(event.keycode);
    if (accelerator === 'ShiftLeft+ShiftRight') { if ([keys.Shift, keys.ShiftRight].includes(event.keycode)) release(); return; }
    const modifiers = accelerator === 'Control+Alt+Space' ? [keys.Ctrl, keys.CtrlRight, keys.Alt, keys.AltRight]
      : accelerator === 'F8' ? [] : [keys.Shift, keys.ShiftRight, ...(platform === 'darwin' ? [keys.Meta, keys.MetaRight] : [keys.Ctrl, keys.CtrlRight])];
    if (event.keycode === target() || modifiers.includes(event.keycode)) release();
  };
  return {
    start(value) { accelerator = value; pressed.clear(); hook.on('keydown', down); hook.on('keyup', up); try { hook.start(); } catch (error) { hook.removeListener('keydown', down); hook.removeListener('keyup', up); throw error; } },
    stop() { release(true); pressed.clear(); hook.removeListener('keydown', down); hook.removeListener('keyup', up); hook.stop(); },
  };
}
module.exports = { createPushToTalk };
