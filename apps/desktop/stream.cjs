async function readEvents(response, onEvent) {
  if (!response.body) throw Error('流式响应为空');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000) throw Error('流式消息过大');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line) onEvent(JSON.parse(line));
      }
      if (done) { if (buffer.trim()) onEvent(JSON.parse(buffer)); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
module.exports = { readEvents };
