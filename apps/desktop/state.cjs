const MODES = new Set(['daily', 'work', 'game', 'movie']);

function safeSource(sourceId) {
  return typeof sourceId === 'string' && /^(screen|window):[\w:.-]+$/.test(sourceId);
}

function cropBounds(region, size) {
  if (!region) return { x: 0, y: 0, width: size.width, height: size.height };
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error('捕获区域无效，请重新选取');
  }
  return { x: Math.floor(x * size.width), y: Math.floor(y * size.height), width: Math.max(1, Math.floor(width * size.width)), height: Math.max(1, Math.floor(height * size.height)) };
}

function overlaySize(framing, scale = 1, bubbleHeight = 72) {
  const base = framing === 'mini' ? { width: 260, height: 340 } : framing === 'half' ? { width: 350, height: 450 } : { width: 370, height: 660 };
  const factor = Number.isFinite(scale) ? Math.max(.65, Math.min(1.6, scale)) : 1;
  // Keep bubble space independent of character scale so replies never move the avatar.
  const reserve = Math.max(56, Math.min(280, Number.isFinite(bubbleHeight) ? bubbleHeight : 72)) + 24;
  return { width: Math.max(260, Math.round(base.width * factor)), height: Math.round(base.height * factor) + reserve };
}

module.exports = { MODES, safeSource, cropBounds, overlaySize };
