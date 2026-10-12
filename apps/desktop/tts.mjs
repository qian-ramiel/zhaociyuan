export function normalizeTtsSettings(settings) {
  if (!['openai', 'custom'].includes(settings.provider)) return settings;
  try {
    const url = new URL(settings.baseUrl.trim());
    const path = url.pathname.replace(/\/+$/, '');
    if (['http:', 'https:'].includes(url.protocol) && !path.includes('/ws/') && path.endsWith('/v1/t2a_v2')) {
      return { ...settings, provider: 'minimax' };
    }
  } catch {
    // The backend reports invalid addresses without changing the user's input.
  }
  return settings;
}
