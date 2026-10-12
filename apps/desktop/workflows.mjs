export function workflowsForMode(items, modeId) {
  return items.filter((item) => item.mode === modeId || item.mode === 'all');
}

export function mergeModeWorkflows(items, draft, modeId) {
  if (draft.some((item) => item.mode !== modeId && item.mode !== 'all')) throw new Error('工作流只能属于当前模式或所有模式');
  return [...items.filter((item) => item.mode !== modeId && item.mode !== 'all'), ...draft];
}
