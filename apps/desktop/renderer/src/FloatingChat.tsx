import { t, useLanguage, dateLocale, modeLabel } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Eye, EyeOff, MessageCircle, Mic, Phone, PhoneOff, Square, Volume2, VolumeX } from 'lucide-react';
import { cleanError } from '../../errors.mjs';
import { screenState } from '../../observation.mjs';
import { useCompanionState } from './Overlay';
import { IconButton } from './components/Ui';
import { ScreenAttachment } from './components/ScreenAttachment';

export default function FloatingChat() {
  useLanguage();
  const state = useCompanionState();
  const [input, setInput] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [state?.messages]);
  useEffect(() => { if (state?.draft !== undefined) setInput(state.draft); }, [state?.draft]);
  if (!state) return null;
  const send = () => { if (!input.trim() || (state.busy && !state.continuous)) return; window.desktop?.command({ type: 'send', value: input.trim() }); setInput(''); };
  const toggleVision = async () => {
    setVisionBusy(true);
    try { await window.desktop?.overlay({ visionEnabled: state.desktopPreferences?.visionEnabled === false }); }
    catch (error) { window.desktop?.command({ type: 'error', value: cleanError(error) }); }
    finally { setVisionBusy(false); }
  };
  const mode = state.modes?.find((m) => m.id === state.companion?.mode);
  const perception = screenState(state.desktopPreferences, state.companion?.screen, mode, !!state.captureError);
  return <section className="floating-chat chat-panel"><div className="floating-chat-titlebar" title={t("拖动聊天窗口")}><span>兆次元</span></div><header><div><MessageCircle size={18} /><strong>{state.persona.characterName}</strong><select className="floating-mode" aria-label={t("陪伴模式")} value={state.companion?.mode || ''} onChange={(e) => window.desktop?.command({ type: 'mode', value: e.target.value })}>{state.modes?.map((item) => <option key={item.id} value={item.id}>{modeLabel(item)}</option>)}</select></div><IconButton title={state.muted ? t("取消静音") : t("静音")} onClick={() => window.desktop?.command('mute')}>{state.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</IconButton></header><div className="messages" ref={scroll}>{!state.messages?.length && <div className="chat-empty"><MessageCircle size={28} /><p>{t("今天想聊些什么？")}</p></div>}{state.messages?.map((m) => <article className={'message ' + m.role} key={m.id}><div className="message-meta">{m.role === 'user' ? t("你") : state.persona.characterName}<time>{new Date(m.created_at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}</time></div>{m.screen_context && <ScreenAttachment metadata={m.screen_context} preview={state.screenPreviews?.[m.id]} />}<p>{m.content}</p>{m.image_url && <img className="message-image" src={m.image_url} alt={t("生成图片")} />}</article>)}{state.busy && <div className="thinking">{state.messages?.some((message) => message.role === 'assistant' && message.id < 0) ? t("正在回复…") : t("正在思考…")}</div>}</div>{state.error && <div className="floating-error" role="alert">{t(state.error)}</div>}<div className={'composer ' + (state.continuous ? 'in-call' : state.recording ? 'recording' : '')}><textarea aria-label={t("聊天输入")} placeholder={t("和角色说点什么…")} rows={2} value={input} onChange={(e) => { setInput(e.target.value); window.desktop?.command({ type: 'draft', value: e.target.value }); }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} /><div className="composer-toolbar"><div><IconButton title={state.recording ? t("结束本次录音") : t("语音输入")} active={!!state.recording} disabled={!state.continuous && state.voicePhase === "transcribing"} onClick={() => window.desktop?.command("voice")}>{state.recording ? <Square size={18} /> : <Mic size={18} />}</IconButton><IconButton action={state.continuous ? "end-call" : undefined} title={state.continuous ? t("挂断通话") : t("开始通话")} active={!!state.continuous} onClick={() => window.desktop?.command("continuous")}>{state.continuous ? <PhoneOff size={18} /> : <Phone size={18} />}</IconButton><IconButton label={t("屏幕感知总开关")} title={state.desktopPreferences?.visionEnabled !== false ? t("关闭屏幕感知") : t("开启屏幕感知")} checked={state.desktopPreferences?.visionEnabled !== false} active={state.desktopPreferences?.visionEnabled !== false} disabled={visionBusy} onClick={() => { void toggleVision(); }}>{state.desktopPreferences?.visionEnabled !== false ? <Eye size={18} /> : <EyeOff size={18} />}</IconButton></div><div><IconButton title={t("停止生成或播放")} onClick={() => window.desktop?.command('stop')}><Square size={16} /></IconButton><button title={t("发送")} aria-label={t("发送")} className="send-button" disabled={!input.trim() || (state.busy && !state.continuous) || !state.companion?.characterId} onClick={send}><ArrowUp size={18} /></button></div></div></div><div className="chat-context"><span className={'status-dot ' + (!perception.allowed ? 'off' : '')} />{state.continuous ? (state.voicePhase === 'loading' ? t("正在连接…") : state.voicePhase === 'transcribing' ? t("正在转写…") : state.status === 'speaking' ? t("正在播报…") : state.busy ? t("等待模型回复…") : t("正在倾听…")) : state.recording ? t("正在录音") : state.voicePhase === 'transcribing' ? t("正在转写…") : state.status === 'listening' ? t("正在倾听") : t(perception.reason) || (state.companion?.screen.onMessage ? t("下次发送尝试附图") : t("本轮不附带屏幕"))}</div></section>;
}
