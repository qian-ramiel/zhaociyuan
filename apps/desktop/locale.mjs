import messages from './locales/messages.json' with { type: 'json' };

export const languages = ['zh', 'en', 'ja'];
export function resolveLanguage(locale) {
  const code = String(locale || '').toLowerCase().split(/[-_]/)[0];
  return languages.includes(code) ? code : 'en';
}
export function initialLanguage(saved, systemLocale) {
  return languages.includes(saved) ? saved : resolveLanguage(systemLocale);
}
export function translate(source, language, values = {}) {
  const index = language === 'ja' ? 1 : 0;
  const template = language === 'zh' ? source : messages[source]?.[index] ?? source;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
export function localeTag(language) {
  return { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' }[language] || 'en-US';
}
export function createLanguageStore(initial) {
  // Updates notify renderers without remounting active chats or recorders.
  let value = resolveLanguage(initial);
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => {
      if (!languages.includes(next) || next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
export function builtinModeLabel(mode, language) {
  const defaults = { daily: '日常闲聊', work: '工作陪聊', game: '游戏陪玩', movie: '电影陪看' };
  return mode.name === defaults[mode.id] ? translate(mode.name, language) : mode.name;
}
