const key = 'zhaociyuan-runtime-issues-v1';
const codes = ['playback', 'voice-input', 'client-stream', 'capture'];
const phases = ['request', 'generation', 'playback', 'capture', 'unknown'];
const types = ['connection', 'timeout', 'protocol', 'provider', 'unknown'];

function normalize(value) {
  if (!value || !codes.includes(value.code) || ![value.requestId, value.roleId].every((id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id))) return null;
  return { code: value.code, requestId: value.requestId, roleId: value.roleId,
    phase: phases.includes(value.phase) ? value.phase : 'unknown',
    errorType: types.includes(value.errorType) ? value.errorType : 'unknown',
    ...(Number.isInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 3600000 ? { durationMs: value.durationMs } : {}) };
}

export function createRuntimeReporter(storage, send) {
  let pending = [], flushing = null;
  try {
    const saved = JSON.parse(storage?.getItem(key) || '[]');
    if (Array.isArray(saved)) pending = saved.map(normalize).filter(Boolean).slice(-100);
  } catch { /* Storage may be unavailable; retain an in-memory queue. */ }
  const persist = () => { try { storage?.setItem(key, JSON.stringify(pending)); } catch {} };
  const identity = (issue) => [issue.roleId, issue.requestId, issue.code, issue.phase].join(':');
  async function flush(roleId) {
    if (flushing) { await flushing; return flush(roleId); }
    flushing = (async () => {
      for (const issue of pending.filter((item) => item.roleId === roleId)) {
        try { await send(issue); } catch { break; }
        pending = pending.filter((item) => identity(item) !== identity(issue));
        persist();
      }
    })();
    try { await flushing; } finally { flushing = null; }
  }
  return { flush, async report(value) {
    const issue = normalize(value);
    if (!issue) return;
    if (!pending.some((item) => identity(item) === identity(issue))) pending.push(issue);
    pending = pending.slice(-100); persist();
    await flush(issue.roleId);
  } };
}
