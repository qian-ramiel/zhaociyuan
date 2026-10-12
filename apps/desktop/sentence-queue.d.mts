export class SentenceQueue {
  constructor(speak: (text: string) => Promise<void>, onError: (error: unknown) => void);
  readonly controller: AbortController;
  add(delta: string, final?: boolean): void;
  finish(): Promise<void>;
  cancel(): void;
}
