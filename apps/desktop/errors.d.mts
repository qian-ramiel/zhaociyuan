export function cleanError(error: unknown): string;
export function requestHeaders(body: unknown): Record<string, string>;
export function runtimeErrorType(error: unknown): 'timeout' | 'connection' | 'protocol' | 'unknown';
export function apiError(detail: unknown, fallback?: string): string;
export function providerNumberError(value: { llm: { temperature: number; maxTokens: number }; vision: { temperature: number; maxTokens: number } }): { kind: 'llm' | 'vision'; field: string; message: string; messageKey: string; label: string } | null;
