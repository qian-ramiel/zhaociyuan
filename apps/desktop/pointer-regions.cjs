function validRegions(value) {
  if (!Array.isArray(value) || value.length > 20) return null;
  if (value.some((rect) => !rect || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) || rect.width <= 0 || rect.height <= 0 || Object.values(rect).some((number) => Math.abs(number) > 10000))) return null;
  return value.map(({ x, y, width, height }) => ({ x, y, width, height }));
}

function ignoresPointer(point, bounds, regions, clickThrough, capturing = false) {
  if (clickThrough) return true;
  if (capturing) return false;
  const x = point.x - bounds.x, y = point.y - bounds.y;
  return !regions.some((rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
}

module.exports = { validRegions, ignoresPointer };
