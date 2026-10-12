import type { StreamEvent } from './types';
import { apiError, cleanError, requestHeaders } from '../../errors.mjs';

export async function streamApi(path: string, body: unknown, onEvent: (event: StreamEvent) => void, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const id = crypto.randomUUID();
  if (window.desktop?.stream) {
    const cancel = () => { void window.desktop?.cancelStream?.(id).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try { await window.desktop.stream(id, path, body, (event) => { if (!signal.aborted) onEvent(event); }); }
    catch (error) { throw new Error(cleanError(error)); }
    finally { signal.removeEventListener('abort', cancel); }
    return;
  }
  const response = await fetch(path, { method: 'POST', headers: requestHeaders(body), body: JSON.stringify(body), signal });
  if (!response.ok) throw Error(apiError((await response.json()).detail));
  if (!response.body) throw Error('流式响应为空');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000) throw Error('流式消息过大');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line && !signal.aborted) onEvent(JSON.parse(line));
      }
      if (done) { if (buffer.trim() && !signal.aborted) onEvent(JSON.parse(buffer)); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
