import { t, setLanguage, useLanguage, dateLocale, modeLabel } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { companionText } from '../../companion-text.mjs';
import { proactiveState, screenState } from '../../observation.mjs';
import { Activity, ArrowUp, Brain, Check, ChevronDown, CircleHelp, Eye, EyeOff, Images, LoaderCircle, MessageCircle, Mic, Monitor, Pause, Phone, PhoneOff, Play, Plus, Trash2, RefreshCw, Settings, SlidersHorizontal, Sparkles, Square, UserRound, Users, Volume2, VolumeX, Workflow, X } from 'lucide-react';
import { api, pixelDifference, screenPixels, upload, runtimeReporter } from './api';
import { cleanError, runtimeErrorType } from '../../errors.mjs';
import { VoiceSession } from '../../voice-session.mjs';
import type { Bootstrap, ChatResult, Companion, ConfigurationTab, DesktopPreferences, Emotion, Message, Mode, Page, ScreenContext, Status } from './types';
import { ConfigurationPage } from './components/ConfigurationPage';
import { ScreenAttachment } from './components/ScreenAttachment';
import { emotionNames, statusNames } from './types';
import { Avatar } from './components/Avatar';
import { streamApi } from './stream-api';
import { emitMouth, StreamSpeaker, trackMouth } from './voice-playback';
import { Empty, IconButton, Modal, Toggle } from './components/Ui';
import { ProvidersPage, ScreenPage } from './components/SettingsPages';
import { ProfilesPage, RolesPage } from './components/RolePages';
import { RoleSettingsPage } from './components/RoleSettingsPage';
import { AppearancesPage, EventsPage, GeneralPage, MemoryPage } from './components/ManagementPages';

const pages: { id: Page; label: string; icon: typeof MessageCircle }[] = [
  { id: 'companion', label: '陪伴', icon: MessageCircle },
  { id: 'roles', label: '角色库', icon: Users },
  { id: 'persona', label: '角色设定', icon: UserRound },
  { id: 'appearances', label: '角色形象', icon: Users },
  { id: 'configuration', label: '角色配置', icon: SlidersHorizontal },
  { id: 'events', label: '运行记录', icon: Activity },
  { id: 'profiles', label: '服务方案库', icon: SlidersHorizontal },
  { id: 'settings', label: '全局设置', icon: Settings },
];

export default function App() {
  const language = useLanguage();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [page, setPage] = useState<Page>('companion');
  const [configTab, setConfigTab] = useState<ConfigurationTab>('llm');
  const [loadingError, setLoadingError] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [emotion, setEmotion] = useState<Emotion>('neutral');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [voicePhase, setVoicePhase] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [preferences, setPreferences] = useState<DesktopPreferences>({ visible: true, clickThrough: false, alwaysOnTop: true, menu: 'hover', showGrip: true, gazeEnabled: true, visionEnabled: true, hearingEnabled: true, speechEnabled: true, characterScale: 1, bubbleWidth: 90, bubbleHeight: 72, bubbleFontSize: 13, bubbleAutoHide: 8, showBubble: true, pushToTalk: true, pushToTalkKey: 'ShiftLeft+ShiftRight' });
  const prefsRef = useRef(preferences); prefsRef.current = preferences;
  const [captureError, setCaptureError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [latest, setLatest] = useState<ScreenContext | null>(null);
  const [screenPreviews, setScreenPreviews] = useState<Record<number, ScreenContext>>({});
  const previewRole = useRef('');
  const [input, setInput] = useState('');
  const [imageSuggestion, setImageSuggestion] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => setToast(null), [language]);
  const dataRef = useRef(data); dataRef.current = data;
  const busyRef = useRef(busy); busyRef.current = busy;
  const latestRequest = useRef<string | null>(null);
  const continuousRef = useRef(false);
  const pendingMessage = useRef<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioResolve = useRef<(() => void) | null>(null);
  const audioEpoch = useRef(0);
  const chatStream = useRef<AbortController | null>(null);
  const streamSpeaker = useRef<StreamSpeaker | null>(null);
  const mouthStop = useRef<(() => void) | null>(null);
  const ptt = useRef({ held: false, autoSend: false, generation: 0, ready: Promise.resolve() });
  const mutedRef = useRef(false); mutedRef.current = muted;
  const observationBusy = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const saveQueue = useRef(Promise.resolve());
  const roleEpoch = useRef(0);
  const commandHandlers = useRef<Record<string, () => void>>({});

  const notify = useCallback((text: string, error = false) => {
    text = cleanError(text);
    setToast({ text, error });
    window.setTimeout(() => setToast((value) => value?.text === text ? null : value), error ? 6000 : 3000);
  }, []);

  const reload = useCallback(async () => {
    const next = await api<Bootstrap>('/api/bootstrap');
    setData(next); setLoadingError('');
    const desktop = next.desktop || prefsRef.current;
    setLanguage(desktop.language);
    setPreferences(desktop); prefsRef.current = desktop;
    setOverlayVisible(desktop.visible); setMuted(!desktop.speechEnabled);
    setPage((current) => !next.activeRoleId && !['profiles', 'settings'].includes(current) ? 'roles' : current);
  }, []);
  const refreshEvents = useCallback(async () => {
    const roleId = dataRef.current?.activeRoleId;
    if (roleId) await runtimeReporter.flush(roleId);
    const events = await api<Bootstrap['events']>('/api/events');
    setData((old) => old && old.activeRoleId === roleId ? { ...old, events } : old);
  }, []);
  const reportIssue = useCallback(async (code: string, requestId = crypto.randomUUID(), roleId = dataRef.current?.activeRoleId, diagnostics: { phase?: string; errorType?: string; durationMs?: number } = {}) => {
    if (!roleId) return;
    try { await runtimeReporter.report({ code, requestId, roleId, ...diagnostics }); await refreshEvents(); } catch { /* Reporting must not block the next interaction. */ }
  }, [refreshEvents]);
  useEffect(() => {
    const roleId = data?.activeRoleId;
    if (!roleId) return;
    void runtimeReporter.flush(roleId);
    const timer = setInterval(() => void runtimeReporter.flush(roleId), 30000);
    return () => clearInterval(timer);
  }, [data?.activeRoleId]);
  useEffect(() => {
    if (page !== 'events') return;
    void refreshEvents().catch(() => {});
    const timer = setInterval(() => void refreshEvents().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [page, refreshEvents]);
  useEffect(() => { reload().catch((e) => setLoadingError(e.message)); }, [reload]);
  useEffect(() => { window.desktop?.overlay({}).then((v) => setOverlayVisible(v.visible)); }, []);
  const action = useCallback(async (operation: () => Promise<unknown>, message?: string) => {
    try { await operation(); if (message) notify(message); } catch (error) { notify(error instanceof Error ? error.message : t("操作失败"), true); }
  }, [notify]);

  const stopAudio = useCallback(() => {
    audioEpoch.current++;
    audio.current?.pause(); audio.current = null;
    audioResolve.current?.(); audioResolve.current = null;
    streamSpeaker.current?.cancel(); streamSpeaker.current = null;
    mouthStop.current?.(); mouthStop.current = null; emitMouth(0);
    setStatus('idle');
  }, []);

  const playAudio = useCallback(async (url: string | HTMLAudioElement) => {
    if (mutedRef.current || !prefsRef.current.speechEnabled) return;
    audio.current?.pause(); audioResolve.current?.();
    const current = typeof url === 'string' ? new Audio(url) : url;
    audio.current = current;
    mouthStop.current?.();
    const stopMouth = trackMouth(current); mouthStop.current = stopMouth;
    setStatus('speaking');
    try { await new Promise<void>((resolve, reject) => {
      audioResolve.current = resolve;
      current.onended = () => { if (audio.current === current) { audio.current = null; setStatus('idle'); } resolve(); };
      current.onerror = () => { if (audio.current === current) setStatus('idle'); reject(new Error(t("音频播放失败"))); };
      current.onpause = () => resolve();
      current.play().catch(reject);
    }); } finally { current.onended = null; current.onerror = null; current.onpause = null; stopMouth(); if (audio.current === current) { audio.current = null; setStatus('idle'); } if (mouthStop.current === stopMouth) mouthStop.current = null; }
    if (!audio.current) audioResolve.current = null;
  }, []);

  const speak = useCallback(async (text: string, manual = false) => {
    text = companionText(text);
    if (!text.trim()) return;
    if (mutedRef.current || !prefsRef.current.speechEnabled) {
      if (manual) notify(t("语音已关闭，请打开语音开关后重试"), true);
      return;
    }
    if (!manual && !continuousRef.current && !dataRef.current?.settings.providers.tts.autoplay) return;
    const epoch = audioEpoch.current;
    try {
      const result = await api<{ audio_url: string }>('/api/tts/synthesize', 'POST', { text });
      if (epoch === audioEpoch.current && !mutedRef.current && prefsRef.current.speechEnabled) await playAudio(result.audio_url);
    } catch (error) { notify(error instanceof Error ? error.message : t("语音生成失败"), true); void reportIssue('playback'); }
  }, [notify, playAudio, reportIssue]);

  const saveCompanion = async (value: Companion) => {
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      const next = await api<Companion>('/api/settings/companion', 'PUT', value);
      const modes = await api<Bootstrap['modes']>('/api/modes');
      setData((old) => old ? { ...old, modes, settings: { ...old.settings, companion: next } } : old);
    });
    await saveQueue.current;
  };

  const capture = async () => {
    if (!prefsRef.current.visionEnabled) throw new Error(t("视觉开关已关闭"));
    if (!window.desktop) throw new Error(t("屏幕观察需要桌面程序"));
    try {
      const result = await window.desktop.capture();
      if (!prefsRef.current.visionEnabled) throw new Error(t("视觉开关已关闭"));
      setCaptureError(''); setLatest(result);
      return result;
    } catch (error) { setLatest(null); setCaptureError(cleanError(error)); void reportIssue('capture'); throw new Error(cleanError(error)); }
  };

  const generateImage = async (prompt: string) => {
    if (imageBusy) throw new Error(t("上一张图片仍在生成"));
    setImageBusy(true);
    const epoch = roleEpoch.current;
    try {
      const result = await api<{ image_url: string }>('/api/images/generate', 'POST', { prompt });
      if (epoch !== roleEpoch.current) return;
      setData((old) => old ? { ...old, messages: [...old.messages, { id: -Date.now(), role: 'assistant', content: '', image_url: result.image_url, created_at: new Date().toISOString() }] } : old);
      setImageSuggestion('');
      notify(t("图片已生成"));
    } finally { setImageBusy(false); }
  };

  const acceptReply = async (result: ChatResult, optimisticId?: number, screen?: ScreenContext, requestId?: string, streamed = false) => {
    if (result.companion.characterId !== dataRef.current?.activeRoleId) return;
    const roleId = result.companion.characterId;
    if (screen && result.user_message.screen_context) {
      previewRole.current = roleId;
      setScreenPreviews((old) => {
        // Session-only preview cache: cap both entry count and retained payload size.
        const entries = [...Object.entries(old), [String(result.user_message.id), screen] as const];
        let bytes = 0;
        return Object.fromEntries(entries.reverse().filter(([, value], index) => {
          bytes += value.imageData.length;
          return index < 8 && bytes <= 16_000_000;
        }));
      });
    }
    setData((old) => old ? { ...old, settings: { ...old.settings, companion: result.companion }, messages: [...old.messages.filter((m) => m.id !== optimisticId), result.user_message, result.assistant_message] } : old);
    setEmotion(result.reply.emotion); setStatus(audio.current ? 'speaking' : 'idle');
    if (result.reply.memoryCandidates.length) {
      const memories = await api<Bootstrap['memories']>('/api/memories');
      setData((old) => old?.activeRoleId === roleId ? { ...old, memories } : old);
    }
    if (requestId && latestRequest.current !== requestId) return;
    if (result.reply.imagePrompt) {
      const mode = dataRef.current?.settings.providers.image.mode;
      if (mode === 'auto') void action(() => generateImage(result.reply.imagePrompt!));
      else if (mode === 'suggest') setImageSuggestion(result.reply.imagePrompt);
    }
    void api<Bootstrap['events']>('/api/events').then((events) => setData((old) => old?.activeRoleId === roleId ? { ...old, events } : old));
    if (!streamed && dataRef.current?.activeRoleId === roleId) await speak(result.reply.speech || (continuousRef.current ? result.reply.text : ''));
  };

  const sendMessage = async (content: string, source: 'text' | 'voice' = 'text') => {
    if (!content.trim() || !dataRef.current) return;
    if (source === 'text') voiceSession.current?.discardPending();
    stopGeneration();
    const requestId = crypto.randomUUID();
    const requestRole = dataRef.current.activeRoleId;
    const started = performance.now();
    let failurePhase = 'request', providerFailure = false;
    latestRequest.current = requestId;
    busyRef.current = true; setBusy(true); setStatus('thinking');
    const optimisticId = -Date.now();
    const partialId = optimisticId - 1;
    pendingMessage.current = optimisticId;
    setData((old) => old ? { ...old, messages: [...old.messages, { id: optimisticId, role: 'user', content, created_at: new Date().toISOString() }] } : old);
    let screen: ScreenContext | undefined;
    const settings = dataRef.current.settings.companion.screen;
    const allowed = dataRef.current.modes.find((m) => m.id === dataRef.current?.settings.companion.mode)?.screenAllowed;
    if (prefsRef.current.visionEnabled && settings.enabled && !settings.paused && settings.onMessage && allowed) {
      try { screen = await capture(); } catch (e) { notify(t("本次未附带画面：") + (e instanceof Error ? e.message : t("捕获失败")), true); }
    }
    if (latestRequest.current !== requestId) return;
    try {
      const body = { content, screen, requestId, source };
      let result: ChatResult;
      const useStream = dataRef.current.settings.providers.llm.streaming && (!window.desktop || !!window.desktop.stream);
      if (useStream) {
        const controller = new AbortController(); chatStream.current = controller;
        let completed: ChatResult | undefined, failure: Error | undefined, text = '';
        const shouldSpeak = !mutedRef.current && prefsRef.current.speechEnabled && (continuousRef.current || dataRef.current.settings.providers.tts.autoplay);
        const speaker = shouldSpeak ? new StreamSpeaker(playAudio, (error) => { notify(cleanError(error), true); void reportIssue('playback', requestId, requestRole); }, requestId) : null;
        streamSpeaker.current = speaker;
        await streamApi('/api/chat/stream', body, (event) => {
          if (latestRequest.current !== requestId) return;
          if (event.type === 'text') {
            failurePhase = 'generation';
            text += event.delta || '';
            setData((old) => old ? { ...old, messages: [...old.messages.filter((message) => message.id !== partialId), { id: partialId, role: 'assistant', content: text, created_at: new Date().toISOString() }] } : old);
            speaker?.add(event.delta || '');
          } else if (event.type === 'done') completed = event.result;
          else if (event.type === 'error') { providerFailure = true; failure = Error(event.message || t("生成失败")); }
          else if (event.type === 'cancelled') failure = Error(t("本次生成已停止"));
        }, controller.signal);
        if (failure) throw failure;
        if (!completed) throw Error(t("模型流式连接提前结束"));
        result = completed;
        if (latestRequest.current !== requestId) return;
        setData((old) => old ? { ...old, messages: old.messages.filter((message) => message.id !== partialId) } : old);
        await acceptReply(result, optimisticId, screen, requestId, true);
        setBusy(false); busyRef.current = false; pendingMessage.current = null;
        failurePhase = 'playback';
        await speaker?.finish();
      } else result = await api<ChatResult>('/api/chat', 'POST', body);
      if (latestRequest.current !== requestId) return;
      setBusy(false); busyRef.current = false;
      pendingMessage.current = null;
      if (!useStream) await acceptReply(result, optimisticId, screen, requestId);
    } catch (error) {
      if (latestRequest.current === requestId) {
        notify(error instanceof Error ? error.message : t("发送失败"), true);
        void reportIssue('client-stream', requestId, requestRole, { phase: failurePhase, errorType: providerFailure ? 'provider' : runtimeErrorType(error), durationMs: Math.min(3600000, Math.round(performance.now() - started)) });
        streamSpeaker.current?.cancel(); stopAudio();
        setData((old) => old ? { ...old, messages: old.messages.filter((m) => m.id !== optimisticId && m.id !== partialId) } : old);
        if (source === 'text') setInput(content);
      }
    } finally {
      if (latestRequest.current === requestId) { latestRequest.current = null; pendingMessage.current = null; setBusy(false); busyRef.current = false; if (!audio.current) setStatus('idle'); }
      void refreshEvents().catch(() => {});
    }
  };

  const observe = async (trigger: 'manual' | 'periodic' | 'change' = 'manual', workflowId?: string, provided?: ScreenContext) => {
    if (!prefsRef.current.visionEnabled) throw new Error(t("视觉开关已关闭"));
    if (observationBusy.current || busyRef.current) return;
    observationBusy.current = true;
    if (trigger === 'manual') setStatus('observing');
    try {
      const screen = provided || await capture();
      const result = await api<ChatResult & { shouldSpeak: boolean; reason?: string }>('/api/observe', 'POST', { screen, trigger, workflowId });
      if (prefsRef.current.visionEnabled && result.shouldSpeak && !busyRef.current) await acceptReply(result, undefined, screen);
      else if (trigger === 'manual') notify(result.reason || t("本次没有回复"));
    } finally { observationBusy.current = false; if (!busyRef.current) setStatus('idle'); }
  };

  const voiceSession = useRef<VoiceSession | null>(null);
  const voiceCallbacks = useRef({ sendMessage, stopGeneration: () => {}, notify });
  voiceCallbacks.current = { sendMessage, stopGeneration: () => stopGeneration(), notify };
  if (!voiceSession.current) voiceSession.current = new VoiceSession({
    createDetector: async (options) => (await import('./voice-vad')).createVoiceDetector(options),
    silenceSeconds: () => dataRef.current?.settings.providers.asr.silenceSeconds || 1.2,
    transcribe: async (samples) => {
      const { voiceWav } = await import('./voice-vad');
      return (await upload<{ text: string }>('/api/asr/transcribe', voiceWav(samples), 'voice.wav')).text;
    },
    onState: (voice) => {
      continuousRef.current = voice.active && voice.mode === 'call';
      setContinuous(continuousRef.current); setRecording(voice.active && voice.mode === 'draft');
      setVoicePhase(voice.phase);
      if (voice.speaking || (voice.mode === 'draft' && voice.active)) setStatus('listening');
      else if (!busyRef.current && !audio.current) setStatus('idle');
    },
    onInterrupt: () => voiceCallbacks.current.stopGeneration(),
    onTranscript: (text, mode) => {
      if (mode === 'call') { void voiceCallbacks.current.sendMessage(text, 'voice'); return; }
      if (!text) { ptt.current.autoSend = false; voiceCallbacks.current.notify(t("没有检测到清晰人声，请重试")); return; }
      if (ptt.current.autoSend || dataRef.current?.settings.providers.asr.autoSend) {
        ptt.current.autoSend = false;
        void voiceCallbacks.current.sendMessage(text, 'voice');
      } else setInput((draft) => draft ? draft + '\n' + text : text);
    },
    onError: (error) => { ptt.current.autoSend = false; voiceCallbacks.current.notify(cleanError(error), true); void reportIssue('voice-input'); },
  });
  const stopVoice = () => { ptt.current.held = false; ptt.current.autoSend = false; ptt.current.generation++; void voiceSession.current?.stop(); };
  const startVoice = async (mode: 'draft' | 'call') => {
    if (!prefsRef.current.hearingEnabled) throw new Error(t("听觉开关已关闭"));
    if (!dataRef.current?.activeRoleId) throw new Error(t("请先选择角色"));
    stopGeneration();
    await voiceSession.current?.start(mode);
  };
  const toggleVoice = () => action(async () => {
    if (voiceSession.current?.active && voiceSession.current.mode === 'draft') { if (voicePhase === 'loading') stopVoice(); else await voiceSession.current.finishDraft(); }
    else { stopVoice(); await startVoice('draft'); }
  });
  const toggleContinuous = () => action(async () => {
    if (continuousRef.current) { stopVoice(); stopGeneration(); }
    else { stopVoice(); await startVoice('call'); }
  });
  const toggleSound = () => action(async () => {
    const patch = { speechEnabled: mutedRef.current };
    const next = window.desktop ? await window.desktop.overlay(patch) : await api<DesktopPreferences>('/api/desktop', 'PUT', { ...prefsRef.current, ...patch });
    prefsRef.current = next; setPreferences(next); setMuted(!next.speechEnabled); stopAudio();
  });
  const toggleVision = () => action(async () => {
    const patch = { visionEnabled: !prefsRef.current.visionEnabled };
    const next = window.desktop ? await window.desktop.overlay(patch) : await api<DesktopPreferences>('/api/desktop', 'PUT', { ...prefsRef.current, ...patch });
    prefsRef.current = next; setPreferences(next);
    if (!next.visionEnabled) { setLatest(null); setCaptureError(''); }
  });
  const pttStart = () => {
    if (ptt.current.held) return;
    if (voicePhase === 'transcribing' && !voiceSession.current?.active) { notify(t("上一段语音正在转写，请稍后再按住说话")); return; }
    stopVoice(); ptt.current.held = true; ptt.current.autoSend = true;
    const generation = ptt.current.generation;
    ptt.current.ready = action(async () => {
      await startVoice('draft');
      if (ptt.current.generation === generation && !ptt.current.held) await voiceSession.current?.finishDraft();
    });
  };
  const pttEnd = () => {
    if (!ptt.current.held) return;
    ptt.current.held = false;
    const generation = ptt.current.generation;
    void ptt.current.ready.then(async () => { if (ptt.current.generation === generation && voiceSession.current?.active) await voiceSession.current.finishDraft(); });
  };
  commandHandlers.current = { voice: toggleVoice, continuous: toggleContinuous, 'ptt-start': pttStart, 'ptt-end': pttEnd, 'ptt-cancel': stopVoice, stop: () => stopGeneration(), observe: () => void action(() => observe()), mute: toggleSound, refresh: () => void action(reload) };
  const structuredCommand = useRef<(type: string, value: string) => void>(() => {});
  structuredCommand.current = (type, value) => {
    const current = dataRef.current;
    if (type === 'error') { notify(value, true); return; }
    if (type === 'settings') { setPage(current?.activeRoleId ? 'persona' : 'roles'); return; }
    if (type === 'role') { void action(() => selectRole(value)); return; }
    if (!current?.activeRoleId) return;
    if (type === 'draft') { setInput(value); return; }
    if (type === 'send') { setInput(''); void sendMessage(value); }
    if (type === 'mode') void action(() => saveCompanion({ ...current.settings.companion, mode: value }));
    if (type === 'appearance') void action(() => activate(value));
  };
  useEffect(() => window.desktop?.onCommand((command) => typeof command === 'string' ? commandHandlers.current[command]?.() : structuredCommand.current(command.type, command.value)), []);

  const currentAppearance = data?.appearances.find((a) => a.id === data.settings.companion.activeAppearanceId);
  useEffect(() => {
    if (!data || !window.desktop) return;
    window.desktop.notifyState({ appearance: currentAppearance, persona: data.settings.persona, emotion, status, message: [...data.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '', muted, motions: data.settings.motions, messages: data.messages, screenPreviews: previewRole.current === data.activeRoleId ? screenPreviews : {}, appearances: data.appearances, modes: data.modes, companion: data.settings.companion, busy, continuous, recording, voicePhase, draft: input, error: toast?.error ? toast.text : '', captureError, roles: data.roles });
    void window.desktop.overlay({ framing: currentAppearance?.framing || 'half' });
  }, [currentAppearance, data, emotion, status, muted, busy, continuous, recording, voicePhase, input, toast, captureError, screenPreviews]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: busy ? 'auto' : 'smooth' }); }, [data?.messages, busy]);
  useEffect(() => () => { void voiceSession.current?.stop(); chatStream.current?.abort(); streamSpeaker.current?.cancel(); audio.current?.pause(); mouthStop.current?.(); }, []);

  useEffect(() => {
    if (!window.desktop || !data) return;
    const mode = data.modes.find((m) => m.id === data.settings.companion.mode);
    if (!mode || !mode.proactive || (!mode.observation.periodic && !mode.observation.onChange)) return;
    const settings = mode.observation;
    let active = true;
    let lastPixels: Uint8ClampedArray | null = null;
    const timer = window.setInterval(() => {
      if (!active || busyRef.current || observationBusy.current) return;
      const current = dataRef.current;
      if (!current || !proactiveState(prefsRef.current, current.settings.companion, mode).allowed) { lastPixels = null; return; }
      void action(async () => {
        observationBusy.current = true;
        try {
          const permitted = await api<{ allowed: boolean }>('/api/observe/status');
          if (!active || !permitted.allowed || busyRef.current) { lastPixels = null; return; }
          const picture = await capture();
          if (!active || busyRef.current) return;
          const pixels = await screenPixels(picture.imageData);
          const changed = lastPixels ? pixelDifference(lastPixels, pixels) >= settings.changeThreshold : false;
          lastPixels = pixels;
          observationBusy.current = false;
          if (settings.periodic || (settings.onChange && changed)) await observe(settings.onChange && changed ? 'change' : 'periodic', undefined, picture);
        } finally { observationBusy.current = false; }
      });
    }, settings.interval * 1000);
    return () => { active = false; clearInterval(timer); };
  }, [preferences.visionEnabled, data?.settings.companion.screen, data?.settings.companion.mode, data?.settings.companion.focus, data?.modes]);

  useEffect(() => window.desktop?.onState((state) => {
    if (!state.desktopPreferences) return;
    const next = state.desktopPreferences;
    setLanguage(next.language);
    prefsRef.current = next; setPreferences(next); setOverlayVisible(next.visible); setMuted(!next.speechEnabled);
    if (!next.speechEnabled) stopAudio();
    if (!next.hearingEnabled) stopVoice();
    if (!next.visionEnabled) { setLatest(null); setCaptureError(''); }
  }), [stopAudio]);

  const activate = async (id: string) => {
    await api('/api/appearances/' + id + '/activate', 'POST');
    setData((old) => old ? { ...old, settings: { ...old.settings, companion: { ...old.settings.companion, activeAppearanceId: id } } } : old);
  };
  const toggleOverlay = () => action(async () => {
    if (!window.desktop) throw new Error(t("请从桌面程序打开悬浮角色"));
    const next = await window.desktop.overlay({ visible: !overlayVisible, framing: currentAppearance?.framing });
    setOverlayVisible(next.visible);
  });
  const stopGeneration = () => {
    const requestId = latestRequest.current;
    chatStream.current?.abort(); chatStream.current = null;
    latestRequest.current = null; setBusy(false); busyRef.current = false; stopAudio();
    const id = pendingMessage.current; pendingMessage.current = null;
    if (id !== null) setData((old) => old ? { ...old, messages: old.messages.filter((message) => message.id !== id && message.id !== id - 1) } : old);
    if (requestId) void api('/api/chat/' + requestId + '/cancel', 'POST').catch(() => {});
  };
  const selectRole = async (id: string, nextPage: Page = 'companion') => {
    roleEpoch.current++;
    stopVoice(); stopGeneration();
    await saveQueue.current.catch(() => {});
    await api('/api/roles/' + id + '/activate', 'POST');
    setScreenPreviews({});
    setLatest(null); setCaptureError(''); setClearing(false); setInput(''); setImageSuggestion(''); setEmotion('neutral');
    await reload(); setPage(nextPage);
  };
  const previousRole = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousRole.current !== undefined && previousRole.current !== data?.activeRoleId) {
      setScreenPreviews({});
      roleEpoch.current++; stopVoice(); stopGeneration();
      setLatest(null); setCaptureError(''); setClearing(false); setInput(''); setImageSuggestion(''); setEmotion('neutral');
    }
    previousRole.current = data?.activeRoleId;
  }, [data?.activeRoleId]);

  if (!data) return <div className="loading-screen"><img className="brand-mark" src="/brand/logo.png" alt={t("兆次元 Logo")} /><h1>兆次元</h1>{loadingError ? <><p>{t(loadingError)}</p><button className="secondary" onClick={() => action(reload)}><RefreshCw size={16} />{t("重试连接")}</button></> : <LoaderCircle className="spin" size={22} />}</div>;
  const companion = data.settings.companion;
  const modeNames = Object.fromEntries(data.modes.map((m) => [m.id, modeLabel(m)]));
  const submit = () => { const content = input.trim(); if (!content || (busy && !continuousRef.current)) return; setInput(''); void sendMessage(content); };
  const shared = { action, reload };
  const content = () => {
    if (!data.activeRoleId && page !== 'profiles' && page !== 'settings') return <RolesPage data={data} {...shared} select={selectRole} />;
    switch (page) {
      case 'roles': return <RolesPage data={data} {...shared} select={selectRole} />;
      case 'profiles': return <ProfilesPage data={data} {...shared} onBack={() => setPage('configuration')} />;
      case 'appearances': return <AppearancesPage {...shared} items={data.appearances} assets={data.assets} current={companion.activeAppearanceId} motions={data.settings.motions} activate={activate} value={companion} save={saveCompanion} />;
      case 'persona': return <RoleSettingsPage key={data.activeRoleId} data={data} {...shared} save={saveCompanion} trial={sendMessage} runWorkflow={async (id, mode) => { await saveCompanion({ ...dataRef.current!.settings.companion, mode }); await observe('manual', id); }} />;
      case 'configuration': return <ConfigurationPage tab={configTab} setTab={setConfigTab}>
        {configTab === 'llm' || configTab === 'tts' ? <ProvidersPage {...shared} section={configTab} value={data.settings.providers} onAudio={playAudio} profiles={data.profiles} onProfiles={() => setPage('profiles')} /> : configTab === 'vision' ? <>
          <ScreenPage value={companion} desktop={preferences} mode={data.modes.find((m) => m.id === companion.mode)} action={action} save={saveCompanion} latest={latest} onPreview={async () => { await capture(); }} />
          <details className="vision-model-settings"><summary>{t("视觉模型")}</summary><ProvidersPage {...shared} section="vision" value={data.settings.providers} onAudio={playAudio} profiles={data.profiles} /></details>
        </> : <MemoryPage {...shared} items={data.memories} documents={data.documents} value={companion} save={saveCompanion} />}
      </ConfigurationPage>;
      case 'events': return <EventsPage items={data.events} refresh={() => action(refreshEvents)} />;
      case 'settings': return <GeneralPage {...shared} data={data} />;
      default: return <div className="companion-layout">
        <section className="companion-scene"><header><div><span className="overline">{t("当前角色")}</span><h1>{data.settings.persona.characterName}</h1></div><button className="secondary compact" onClick={toggleOverlay}><Monitor size={15} />{overlayVisible ? t("隐藏桌面角色") : t("桌面角色")}</button></header>
          <div className="mode-bar segmented">{(Object.keys(modeNames) as Mode[]).map((mode) => <button key={mode} className={companion.mode === mode ? 'selected' : ''} onClick={() => action(() => saveCompanion({ ...companion, mode }))}>{modeNames[mode]}</button>)}</div>
          <div className="scene-avatar"><Avatar appearance={currentAppearance} emotion={emotion} status={status} motions={data.settings.motions} onError={(error) => notify(error, true)} /></div>
          <div className="scene-footer"><label className="appearance-selector"><UserRound size={16} /><select aria-label={t("当前形象")} value={companion.activeAppearanceId} onChange={(e) => action(() => activate(e.target.value))}>{!data.appearances.length && <option value="">{t("未配置形象")}</option>}{data.appearances.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><ChevronDown size={14} /></label><span className="emotion-label">{t(emotionNames[emotion])}</span></div>
          <div className="presence-controls"><RowControl label={t("主动发言")}><Toggle label={t("主动发言")} checked={companion.proactive} onChange={(v) => action(async () => { await api('/api/modes/' + companion.mode + '/proactive', 'PATCH', { enabled: v }); await reload(); })} /></RowControl><RowControl label={t("专注")}><Toggle label={t("专注")} checked={companion.focus} onChange={(v) => action(() => saveCompanion({ ...companion, focus: v }))} /></RowControl><IconButton title={companion.screen.paused ? t("恢复屏幕感知") : t("暂停屏幕感知")} active={companion.screen.paused} onClick={() => action(() => saveCompanion({ ...companion, screen: { ...companion.screen, paused: !companion.screen.paused } }))}>{companion.screen.paused ? <Play size={17} /> : <Pause size={17} />}</IconButton></div>
        </section>
        <section className="chat-panel"><header><div><MessageCircle size={17} /><strong>{t("陪伴对话")}</strong><span className="badge">{modeNames[companion.mode]}</span></div><div><IconButton title={muted ? t("取消静音") : t("静音")} active={muted} onClick={toggleSound}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</IconButton><IconButton title={t("清空当前对话")} disabled={!data.messages.length || busy} onClick={() => setClearing(true)}><Trash2 size={17} /></IconButton></div></header>
          {!data.health.modelConfigured && <button className="connection-notice" onClick={() => { setConfigTab('llm'); setPage('configuration'); }}><span className="status-dot amber" />{t("对话模型待配置")}<SlidersHorizontal size={14} /></button>}
          <div className="messages" ref={scroll}>{!data.messages.length && <div className="chat-empty"><MessageCircle size={29} /><p>{t("今天想聊些什么？")}</p><span>{data.settings.persona.characterName} · {currentAppearance?.name || t("未选择形象")}</span></div>}{data.messages.map((message) => <article className={'message ' + message.role} key={message.id}><div className="message-meta"><span>{message.role === 'user' ? t("你") : data.settings.persona.characterName}</span><time>{new Date(message.created_at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}</time>{message.role === 'assistant' && message.content && <IconButton title={t("朗读这条消息")} onClick={() => { stopAudio(); void action(() => speak(message.content, true)); }}><Volume2 size={12} /></IconButton>}</div>{message.screen_context && <ScreenAttachment metadata={message.screen_context} preview={previewRole.current === data.activeRoleId ? screenPreviews[message.id] : undefined} />}{message.content && <p>{message.content}</p>}{message.image_url && <img className="message-image" src={message.image_url} alt={t("生成图片")} />}</article>)}{busy && <div className="thinking"><LoaderCircle size={14} className="spin" />{data.messages.some((message) => message.role === 'assistant' && message.id < 0) ? t("正在回复…") : t("正在思考")}</div>}{imageBusy && <div className="thinking"><Images size={14} />{t("正在画图")}</div>}</div>
          {imageSuggestion && <div className="image-suggestion"><Images size={16} /><span>{t("要把这个场景画出来吗？")}</span><button onClick={() => action(() => generateImage(imageSuggestion))}>{t("生成")}</button><IconButton title={t("忽略图片建议")} onClick={() => setImageSuggestion('')}><X size={14} /></IconButton></div>}
          <div className={'composer ' + (continuous ? 'in-call' : recording ? 'recording' : '')}>{(recording || continuous || voicePhase === 'transcribing') && <span className="recording-status"><span className="status-dot" />{voicePhase === 'loading' ? t("正在连接…") : voicePhase === 'transcribing' ? t("正在转写…") : continuous ? (status === 'speaking' ? t("正在播报…") : busy ? t("等待模型回复…") : t("正在倾听…")) : t("正在录音")}</span>}<textarea aria-label={t("聊天输入")} placeholder={t("和角色说点什么…")} rows={3} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} /><div className="composer-toolbar"><div><IconButton title={recording ? t("结束本次录音") : t("语音输入")} active={recording} disabled={!continuous && voicePhase === 'transcribing'} onClick={toggleVoice}>{recording ? <Square size={17} /> : <Mic size={18} />}</IconButton><IconButton action={continuous ? "end-call" : undefined} title={continuous ? t("挂断通话") : t("开始通话")} active={continuous} onClick={toggleContinuous}>{continuous ? <PhoneOff size={18} /> : <Phone size={18} />}</IconButton><IconButton label={t("屏幕感知总开关")} title={preferences.visionEnabled ? t("关闭屏幕感知") : t("开启屏幕感知")} checked={preferences.visionEnabled} active={preferences.visionEnabled} onClick={toggleVision}>{preferences.visionEnabled ? <Eye size={18} /> : <EyeOff size={18} />}</IconButton></div><div>{(busy || status === 'speaking') && <IconButton title={t("停止生成或播放")} onClick={stopGeneration}><Square size={17} /></IconButton>}<button className="send-button" title={t("发送")} aria-label={t("发送")} disabled={!input.trim() || (busy && !continuous)} onClick={submit}><ArrowUp size={18} /></button></div></div></div>
<div className="chat-context"><span className={'status-dot ' + (!screenState(preferences, companion.screen, data.modes.find((m) => m.id === companion.mode), !!captureError).allowed ? 'off' : '')} />{t(screenState(preferences, companion.screen, data.modes.find((m) => m.id === companion.mode), !!captureError).reason) || (companion.screen.onMessage ? t("下次发送尝试附图") : t("屏幕感知已就绪"))}<span>{t("记忆") + ' '}{data.memories.filter((m) => m.enabled).length}</span></div>
        </section>
      </div>;
    }
  };

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><img className="brand-mark" src="/brand/logo.png" alt={t("兆次元 Logo")} /><div><strong>兆次元</strong><small>{t("AI 伴侣") + ' '}<span>1.0</span></small></div></div><nav>{pages.filter((item) => ['companion', 'roles'].includes(item.id)).map((item) => <button key={item.id} className={page === item.id ? 'selected' : ''} title={t(item.label)} onClick={() => setPage(item.id)}><item.icon size={17} />{t(item.label)}</button>)}{data.activeRoleId && <><div className="nav-role">{data.roles.find((role) => role.id === data.activeRoleId)?.previewUrl ? <img className="nav-role-avatar" src={data.roles.find((role) => role.id === data.activeRoleId)!.previewUrl!} alt="" /> : <UserRound size={17} />}<select aria-label={t("当前角色")} value={data.activeRoleId} onChange={(e) => action(() => selectRole(e.target.value, 'persona'))}>{data.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></div>{pages.filter((item) => !['companion', 'roles', 'profiles', 'settings'].includes(item.id)).map((item) => <button key={item.id} title={t(item.label)} className={((page === item.id || (page === 'profiles' && item.id === 'configuration')) ? 'selected' : '') + ' nav-owned'} onClick={() => setPage(item.id)}><item.icon size={16} />{t(item.label)}{page === item.id && <span className="nav-current" />}</button>)}</>}</nav><div className="sidebar-bottom"><span className="status-dot" /><span>{t("本地服务已连接")}</span><IconButton title={t("全局设置")} active={page === 'settings'} onClick={() => setPage('settings')}><Settings size={14} /></IconButton><IconButton title={t("刷新数据")} onClick={() => action(reload)}><RefreshCw size={14} /></IconButton></div></aside><main className="workspace"><header className="workspace-header"><div><span>{t(pages.find((p) => p.id === page)?.label || '')}</span>{data.activeRoleId && <><span className="breadcrumb">/</span><span>{data.settings.persona.characterName}</span></>}</div><div className="runtime-status"><span className={'status-dot ' + (status === 'thinking' ? 'amber' : '')} />{t(statusNames[status])}<span className="header-divider" /><span>{window.desktop ? t("桌面端") : t("浏览器预览")}</span></div></header><div className={'page-content ' + (page === 'companion' && data.activeRoleId ? 'companion-content' : '')} key={page + data.activeRoleId}>{content()}</div><footer className="workspace-footer"><span>{currentAppearance?.name || t("未配置形象")} · {modeNames[companion.mode]}{t("模式")}</span><span>{t(screenState(preferences, companion.screen, data.modes.find((m) => m.id === companion.mode), !!captureError).reason) || companion.screen.sourceName || t("屏幕感知已就绪")}<span className="footer-divider">·</span>{t("原始截图不保存")}</span></footer></main>{clearing && <Modal title={t("清空当前对话？")} onClose={() => { if (!clearBusy) setClearing(false); }}><div className="modal-body"><p>{t("将永久删除「")}{data.settings.persona.characterName}{t("」的聊天记录，无法撤销。角色设定、长期记忆及其他角色不受影响。")}</p><div className="modal-footer"><button className="secondary" disabled={clearBusy} onClick={() => setClearing(false)}>{t("取消")}</button><button className="primary danger" disabled={clearBusy || busy} onClick={() => action(async () => { const roleId = data.activeRoleId; setClearBusy(true); try { stopAudio(); await api('/api/chat/history', 'DELETE'); setData((old) => old?.activeRoleId === roleId ? { ...old, messages: [] } : old); if (dataRef.current?.activeRoleId === roleId) setScreenPreviews({}); setClearing(false); } finally { setClearBusy(false); } }, t("当前角色对话已清空"))}><Trash2 size={16} />{t("确认清空")}</button></div></div></Modal>}{toast && <div className={'toast ' + (toast.error ? 'error' : '')} role="status">{toast.error ? <CircleHelp size={17} /> : <Check size={17} />}<span>{t(toast.text)}</span><IconButton title={t("关闭通知")} onClick={() => setToast(null)}><X size={15} /></IconButton></div>}</div>;
}

function RowControl({ label, children }: { label: string; children: React.ReactNode }) { return <div className="presence-control"><span>{label}</span>{children}</div>; }
