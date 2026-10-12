export type Mode = string;
export type Page = 'companion' | 'roles' | 'profiles' | 'appearances' | 'persona' | 'configuration' | 'events' | 'settings';
export type ConfigurationTab = 'llm' | 'tts' | 'vision' | 'memory';
export type Status = 'idle' | 'listening' | 'thinking' | 'speaking' | 'observing';
export type Emotion = 'neutral' | 'happy' | 'angry' | 'sad' | 'joy' | 'surprised';
export const modeNames: Record<Mode, string> = { daily: '日常', work: '工作', game: '游戏', movie: '观影' };
export const emotionNames: Record<Emotion, string> = { neutral: '常规', happy: '喜', angry: '怒', sad: '哀', joy: '乐', surprised: '惊讶' };
export const statusNames: Record<Status, string> = { idle: '待机', listening: '倾听', thinking: '思考', speaking: '说话', observing: '观察' };

export interface ModelService { provider: string; baseUrl: string; apiKey: string; hasApiKey: boolean; model: string; temperature: number; maxTokens: number; jsonMode: boolean; streaming: boolean }
export interface Providers {
  llm: ModelService; vision: ModelService; visionUseChat: boolean;
  tts: { provider: 'local' | 'openai' | 'custom' | 'minimax'; baseUrl: string; apiKey: string; hasApiKey: boolean; model: string; voice: string; speed: number; autoplay: boolean; streaming?: boolean };
  asr: { provider: string; language: string; silenceSeconds: number; continuous: boolean; autoSend?: boolean };
  image: { baseUrl: string; apiKey: string; hasApiKey: boolean; model: string; size: string; mode: 'off' | 'manual' | 'suggest' | 'auto'; style: string; cooldown: number; hourlyLimit: number };
}
export interface Persona { characterName: string; userName: string; background: string; personality: string; relationship: string; speakingStyle: string; likes: string; dislikes: string; boundaries: string; systemPrompt: string; exampleDialogue: string; replyLength: string; initiative: number }
export interface ScreenSettings { enabled: boolean; paused: boolean; sourceId: string; sourceName: string; quality: 'standard' | 'high'; onMessage: boolean; periodic: boolean; interval: number; onChange: boolean; changeThreshold: number; region: { x: number; y: number; width: number; height: number } | null }
export interface Companion { characterId: string; activeAppearanceId: string; mode: Mode; allowAutoAppearance: boolean; modeAppearances: Partial<Record<Mode, string>>; proactive: boolean; cooldown: number; hourlyLimit: number; quietStart: string; quietEnd: string; focus: boolean; autoMemory: boolean; screen: ScreenSettings }
export interface Binding { semantic: string; label: string; motionGroup: string; motionIndex: number; expression: string; priority: number; interruptible: boolean; cooldownMs: number }
export interface Appearance { id: string; characterId: string; name: string; assetId: string; kind: 'live2d' | 'static'; framing: 'full' | 'half' | 'mini'; scale: number; aliases: string[]; bindings: Binding[]; modelPath: string; previewUrl: string | null; motions: Record<string, string[]>; expressions: string[] }
export interface Gaze { enabled: boolean; head: boolean; strength: number; trigger: 'hover' | 'click' }
export interface Appearance { gaze?: Gaze }
export interface Role { id: string; name: string; intro: string; appearanceCount: number; modeCount: number; previewUrl: string | null }
export interface ModeObservation { periodic: boolean; onChange: boolean; interval: number; changeThreshold: number }
export interface CompanionMode { id: string; name: string; prompt: string; screenAllowed: boolean; proactive: boolean; cooldown: number; hourlyLimit: number; quietStart: string; quietEnd: string; replyLength: 'inherit' | 'short' | 'medium' | 'long'; observation: ModeObservation }
export interface ServiceProfile { id: string; name: string; providers: Providers; created_at: string }
export interface Asset { id: string; name: string; model_path: string; preview_url: string | null; motions: Record<string, string[]>; expressions: string[] }
export interface ScreenContext { imageData: string; capturedAt: string; sourceName: string }
export interface Message { id: number; role: 'user' | 'assistant'; content: string; emotion?: Emotion; created_at: string; screen_context?: { sourceName: string; capturedAt: string } | null; image_url?: string }
export interface Reply { text: string; speech: string; emotion: Emotion; actions: { name: string; intensity: number }[]; memoryCandidates: string[]; custom: Record<string, unknown>; switchAppearance: string | null; imagePrompt: string | null }
export interface ChatResult { reply: Reply; user_message: Message; assistant_message: Message; companion: Companion }
export interface Memory { id: string; category: 'profile' | 'relationship' | 'project'; content: string; enabled: boolean; source: string; created_at: string }
export interface Document { id: string; name: string; kind: string; chunks: number; enabled: boolean; size: number }
export interface Workflow { id: string; name: string; enabled: boolean; trigger: 'message' | 'manual' | 'periodic' | 'change'; mode: Mode | 'all'; keyword: string; prompt: string }
export interface EventItem { id: number; kind: string; detail: string; created_at: string }
export interface EventItem { result?: string; duration_ms?: number; service?: string }
export interface Settings { persona: Persona; providers: Providers; companion: Companion; motions: Binding[] }
export interface Bootstrap { health: { status: string; version: string; modelConfigured: boolean; tts_installed: boolean; asr_installed: boolean }; settings: Settings; appearances: Appearance[]; assets: Asset[]; messages: Message[]; memories: Memory[]; documents: Document[]; workflows: Workflow[]; events: EventItem[] }
export interface Bootstrap { roles: Role[]; activeRoleId: string; modes: CompanionMode[]; profiles: ServiceProfile[]; desktop: DesktopPreferences }
export interface Source { id: string; name: string; thumbnail: string }
export interface OverlayState { appearance?: Appearance; persona: Persona; emotion: Emotion; status: Status; message: string; muted: boolean; motions: Binding[] }
export interface OverlayState { messages?: Message[]; screenPreviews?: Record<number, ScreenContext>; appearances?: Appearance[]; modes?: CompanionMode[]; companion?: Companion; busy?: boolean; continuous?: boolean; recording?: boolean; voicePhase?: string; draft?: string; error?: string; captureError?: string; roles?: Role[]; desktopPreferences?: DesktopPreferences }
export interface DesktopPreferences { visible: boolean; clickThrough: boolean; alwaysOnTop: boolean; menu: 'hover' | 'always'; showGrip: boolean; gazeEnabled: boolean; visionEnabled: boolean; hearingEnabled: boolean; speechEnabled: boolean; characterScale: number; bubbleWidth: number; bubbleHeight: number; bubbleFontSize: number; bubbleAutoHide: number; showBubble?: boolean; pushToTalk?: boolean; pushToTalkKey?: 'CommandOrControl+Shift+Space' | 'Control+Alt+Space' | 'F8' | 'ShiftLeft+ShiftRight' }
export interface SystemPermissions { screen: string; microphone: string; accessibility: string; pushToTalk: 'running' | 'permission-required' | 'hearing-disabled' | 'disabled' | 'unavailable' }
export interface DesktopCommand { type: 'send' | 'draft' | 'mode' | 'appearance' | 'settings' | 'role' | 'error'; value: string }
export interface Desktop {
  platform: string;
  api: <T = unknown>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  stream?: (id: string, path: string, body: unknown, callback: (event: StreamEvent) => void) => Promise<void>;
  cancelStream?: (id: string) => Promise<void>;
  lipSync?: (level: number) => void;
  upload: <T = unknown>(path: string, bytes: Uint8Array, name: string, type: string, fields: Record<string, string>) => Promise<T>;
  sources: () => Promise<Source[]>;
  capture: () => Promise<ScreenContext>;
  permission: () => Promise<SystemPermissions>;
  pointerRegions?: (regions: { x: number; y: number; width: number; height: number }[], capturing: boolean) => void;
  overlay: (options: Partial<DesktopPreferences> & { framing?: string; bubbleHeightPreview?: number | null }) => Promise<DesktopPreferences>;
  openConsole: () => Promise<void>; openChat: () => Promise<void>; openData: () => Promise<void>; openPermissions: () => Promise<void>; command: (command: string | DesktopCommand) => void;
  notifyState: (state: OverlayState) => void; onState: (callback: (state: OverlayState) => void) => () => void;
  onCommand: (callback: (command: string | DesktopCommand) => void) => () => void; quit: () => Promise<void>;
}
export interface StreamEvent { type: string; delta?: string; result?: ChatResult; data?: string; mime?: string; url?: string; message?: string }
declare global { interface Window { desktop?: Desktop } }
