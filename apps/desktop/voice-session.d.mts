export interface VoiceDetector {
  start(): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}
export interface DetectorOptions {
  silenceSeconds: number;
  isActive(): boolean;
  onSpeechRealStart(): void;
  onSpeechEnd(samples: Float32Array): void;
  onVADMisfire(): void;
  onError(error: unknown): void;
}
export interface VoiceState { mode: 'draft' | 'call'; active: boolean; speaking: boolean; phase: 'idle' | 'loading' | 'listening' | 'transcribing' }
export class VoiceSession {
  constructor(options: {
    createDetector(options: DetectorOptions): Promise<VoiceDetector>;
    silenceSeconds(): number;
    transcribe(samples: Float32Array): Promise<string>;
    onState(state: VoiceState): void;
    onInterrupt(): void;
    onTranscript(text: string, mode: 'draft' | 'call'): void;
    onError(error: unknown): void;
  });
  active: boolean;
  mode: 'draft' | 'call';
  start(mode: 'draft' | 'call'): Promise<void>;
  finishDraft(): Promise<void>;
  discardPending(): void;
  stop(): Promise<void>;
}
