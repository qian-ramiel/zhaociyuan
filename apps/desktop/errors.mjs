const labels = { llm: '对话模型', vision: '视觉模型', tts: 'TTS', image: '图片服务', temperature: 'Temperature', maxTokens: 'Token 上限', speed: '语速', baseUrl: 'API 地址', model: '模型名称', name: '名称' };

export function requestHeaders(body) {
  const id = body?.requestId;
  return { 'Content-Type': 'application/json', ...(typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id) ? { 'X-Request-ID': id } : {}) };
}

export function runtimeErrorType(error) {
  const message = cleanError(error);
  if (/timeout|timed out|超时/i.test(message)) return 'timeout';
  if (/fetch failed|failed to fetch|network|ECONN|连接.*失败/i.test(message)) return 'connection';
  if (/JSON|格式|流式.*(?:无效|结束|为空)|解码/i.test(message)) return 'protocol';
  return 'unknown';
}

export function cleanError(error) {
  let message = error instanceof Error ? error.message : String(error || '操作失败');
  while (/^(Error invoking remote method '[^']+':\s*|Error:\s*)/.test(message)) message = message.replace(/^(Error invoking remote method '[^']+':\s*|Error:\s*)/, '');
  return message;
}

export function apiError(detail, fallback = '请求失败') {
  if (typeof detail === 'string') return cleanError(detail);
  if (!Array.isArray(detail)) return fallback;
  return detail.slice(0, 5).map((error) => {
    const path = (error.loc || []).filter((part) => !['body', 'query', 'path'].includes(part));
    const field = path.at(-1);
    const label = path.map((part) => labels[part] || part).join(' / ');
    if (field === 'temperature') return `${label} 应为 0–2`;
    if (field === 'maxTokens') return `${label} 应为 128–32768 的整数`;
    if (field === 'speed') return `${label} 应为 0.5–1.5`;
    const ctx = error.ctx || {};
    if (error.type === 'missing') return `请填写${label}`;
    if (ctx.ge !== undefined) return `${label} 不能小于 ${ctx.ge}`;
    if (ctx.le !== undefined) return `${label} 不能大于 ${ctx.le}`;
    return `${label || '配置'}格式或范围无效`;
  }).join('；') || fallback;
}

export function providerNumberError(value) {
  for (const kind of ['llm', 'vision']) {
    const model = value[kind];
    if (!Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2) return { kind, field: 'Temperature', message: `${labels[kind]} Temperature 应为 0–2`, messageKey: '{{v0}} Temperature 应为 0–2', label: labels[kind] };
    if (!Number.isInteger(model.maxTokens) || model.maxTokens < 128 || model.maxTokens > 32768) return { kind, field: '回复 Token 上限', message: `${labels[kind]} Token 上限应为 128–32768 的整数`, messageKey: '{{v0}} Token 上限应为 128–32768 的整数', label: labels[kind] };
  }
  return null;
}
