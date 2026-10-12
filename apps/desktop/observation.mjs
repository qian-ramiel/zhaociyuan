export function screenState(desktop, screen, mode, unavailable = false) {
  const reason = !desktop?.visionEnabled ? '屏幕感知总开关已关闭'
    : !screen?.enabled ? '角色未允许屏幕感知'
    : screen.paused ? '屏幕感知已暂停'
    : !mode?.screenAllowed ? '当前模式未允许屏幕感知'
    : !screen.sourceId ? '尚未选择观察来源'
    : unavailable ? '观察来源不可用' : '';
  return { allowed: !reason, reason };
}

export function proactiveState(desktop, companion, mode, now = new Date(), unavailable = false) {
  const state = screenState(desktop, companion?.screen, mode, unavailable);
  if (!state.allowed) return state;
  const start = mode.quietStart, end = mode.quietEnd;
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const quiet = start !== end && (start < end ? start <= clock && clock < end : clock >= start || clock < end);
  const reason = !mode.proactive ? '当前模式主动发言已关闭'
    : !mode.observation?.periodic && !mode.observation?.onChange ? '未设置自动观察触发'
    : companion.focus ? '专注中' : quiet ? '安静时段' : '';
  return { allowed: !reason, reason };
}

export function gazeState(desktop, appearance) {
  return !desktop?.gazeEnabled ? '视线跟随总开关已关闭'
    : appearance?.gaze?.enabled === false ? '当前形象未启用视线跟随'
    : appearance?.kind !== 'live2d' ? '当前形象不支持视线跟随' : '视线跟随已开启';
}
