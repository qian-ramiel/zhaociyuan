export function normalizeTtsSettings<T extends { provider: string; baseUrl: string }>(settings: T): T | (Omit<T, 'provider'> & { provider: 'minimax' });
