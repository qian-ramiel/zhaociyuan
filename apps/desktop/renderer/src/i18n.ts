import { useEffect, useSyncExternalStore } from 'react';
import { createLanguageStore, initialLanguage, localeTag, translate, builtinModeLabel } from '../../locale.mjs';
import type { Language } from '../../locale.mjs';
import { api } from './api';
import type { DesktopPreferences } from './types';

const store = createLanguageStore(initialLanguage(window.desktop?.initialLanguage, navigator.language));
export function t(source: string | undefined, values?: Record<string, unknown>) { return translate(source || '', store.get(), values); }
export function setLanguage(language: unknown) { store.set(language); }
export function dateLocale() { return localeTag(store.get()); }
export function modeLabel(mode: { id: string; name: string }) { return builtinModeLabel(mode, store.get()); }
export function useLanguage() {
  const language = useSyncExternalStore(store.subscribe, store.get);
  useEffect(() => { document.documentElement.lang = localeTag(language); document.title = '兆次元 · ' + t('AI 伴侣'); }, [language]);
  useEffect(() => window.desktop?.onState((state) => setLanguage(state.desktopPreferences?.language)), []);
  return language;
}
let queue = Promise.resolve<unknown>(undefined);
export function changeLanguage(language: Language) {
  const operation = queue.catch(() => {}).then(async () => {
    const saved = window.desktop
      ? await window.desktop.overlay({ language })
      : await api<DesktopPreferences>('/api/desktop', 'PUT', { ...(await api<DesktopPreferences>('/api/desktop')), language });
    setLanguage(saved.language);
    return saved;
  });
  queue = operation;
  return operation;
}
