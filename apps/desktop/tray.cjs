function trayTemplate(state, preferences, actions) {
  const roles = state?.roles || [];
  const appearances = state?.appearances || [];
  const submenu = (items, selected, change, empty) => items.length ? items.map((item) => ({
    label: item.name, type: 'radio', checked: item.id === selected, click: () => change(item.id),
  })) : [{ label: empty, enabled: false }];
  return [
    { label: '配置面板', click: actions.configure },
    { type: 'separator' },
    { label: '更换角色', submenu: submenu(roles, state?.companion?.characterId, actions.role, '尚未创建角色') },
    { type: 'separator' },
    { label: '更改形象', submenu: submenu(appearances, state?.appearance?.id, actions.appearance, '当前角色尚未配置形象') },
    { type: 'separator' },
    ...[['visionEnabled', '屏幕感知总开关'], ['hearingEnabled', '听觉总开关'], ['speechEnabled', '语音播放总开关']].map(([key, label]) => ({
      label, type: 'checkbox', checked: preferences[key] !== false, click: (item) => actions.preference(key, item.checked),
    })),
    { label: preferences.visible ? '隐藏' : '显示', click: () => actions.preference('visible', !preferences.visible) },
    ...(preferences.clickThrough ? [{ label: '恢复角色交互', click: () => actions.preference('clickThrough', false) }] : []),
    { label: '退出', click: actions.quit },
  ];
}

module.exports = { trayTemplate };
