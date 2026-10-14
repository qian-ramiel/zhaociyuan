export type Language = 'zh' | 'en' | 'ja';
export const languages: readonly Language[];
export function resolveLanguage(locale: unknown): Language;
export function initialLanguage(saved: unknown, systemLocale: unknown): Language;
export function translate(source: string, language: Language, values?: Record<string, unknown>): string;
export function localeTag(language: Language): string;
export function builtinModeLabel(mode: { id: string; name: string }, language: Language): string;
export function createLanguageStore(initial: unknown): { get: () => Language; set: (next: unknown) => void; subscribe: (listener: () => void) => () => void };
