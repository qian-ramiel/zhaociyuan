export function workflowsForMode<T extends { mode: string }>(items: T[], modeId: string): T[];
export function mergeModeWorkflows<T extends { mode: string }>(items: T[], draft: T[], modeId: string): T[];
