export type RuntimeIssue = {
  code: string; requestId: string; roleId: string; phase?: string; errorType?: string; durationMs?: number;
};
export function createRuntimeReporter(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, send: (issue: RuntimeIssue) => Promise<unknown>): {
  report(issue: RuntimeIssue): Promise<void>; flush(roleId: string): Promise<void>;
};
