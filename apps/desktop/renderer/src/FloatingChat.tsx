import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Eye, EyeOff, MessageCircle, Mic, Phone, PhoneOff, Square, Volume2, VolumeX } from 'lucide-react';
import { cleanError } from '../../errors.mjs';
import { screenState } from '../../observation.mjs';
import { useCompanionState } from './Overlay';
import { IconButton } from './components/Ui';
import { ScreenAttachment } from './components/ScreenAttachment';

export default function FloatingChat() {
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
  return <section className="floating-chat chat-panel"><div className="floating-chat-titlebar" title="拖动聊天窗口"><span>兆次元</span></div><header><div><MessageCircle size={18} /><strong>{state.persona.characterName}</strong><select className="floating-mode" aria-label="陪伴模式" value={state.companion?.mode || ''} onChange={(e) => window.desktop?.command({ type: 'mode', value: e.target.value })}>{state.modes?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><IconButton title={state.muted ? '取消静音' : '静音'} onClick={() => window.desktop?.command('mute')}>{state.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</IconButton></header><div className="messages" ref={scroll}>{!state.messages?.length && <div className="chat-empty"><MessageCircle size={28} /><p>今天想聊些什么？</p></div>}{state.messages?.map((m) => <article className={'message ' + m.role} key={m.id}><div className="message-meta">{m.role === 'user' ? '你' : state.persona.characterName}<time>{new Date(m.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>{m.screen_context && <ScreenAttachment metadata={m.screen_context} preview={state.screenPreviews?.[m.id]} />}<p>{m.content}</p>{m.image_url && <img className="message-image" src={m.image_url} alt="生成图片" />}</article>)}{state.busy && <div className="thinking">{state.messages?.some((message) => message.role === 'assistant' && message.id < 0) ? '正在回复…' : '正在思考…'}</div>}</div>{state.error && <div className="floating-error" role="alert">{state.error}</div>}<div className={'composer ' + (state.continuous ? 'in-call' : state.recording ? 'recording' : '')}><textarea aria-label="聊天输入" placeholder="和角色说点什么…" rows={2} value={input} onChange={(e) => { setInput(e.target.value); window.desktop?.command({ type: 'draft', value: e.target.value }); }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} /><div className="composer-toolbar"><div><IconButton title={state.recording ? "结束本次录音" : "语音输入"} active={!!state.recording} disabled={!state.continuous && state.voicePhase === "transcribing"} onClick={() => window.desktop?.command("voice")}>{state.recording ? <Square size={18} /> : <Mic size={18} />}</IconButton><IconButton title={state.continuous ? "挂断通话" : "开始通话"} active={!!state.continuous} onClick={() => window.desktop?.command("continuous")}>{state.continuous ? <PhoneOff size={18} /> : <Phone size={18} />}</IconButton><IconButton label="屏幕感知总开关" title={state.desktopPreferences?.visionEnabled !== false ? "关闭屏幕感知" : "开启屏幕感知"} checked={state.desktopPreferences?.visionEnabled !== false} active={state.desktopPreferences?.visionEnabled !== false} disabled={visionBusy} onClick={() => { void toggleVision(); }}>{state.desktopPreferences?.visionEnabled !== false ? <Eye size={18} /> : <EyeOff size={18} />}</IconButton></div><div><IconButton title="停止生成或播放" onClick={() => window.desktop?.command('stop')}><Square size={16} /></IconButton><button title="发送" aria-label="发送" className="send-button" disabled={!input.trim() || (state.busy && !state.continuous) || !state.companion?.characterId} onClick={send}><ArrowUp size={18} /></button></div></div></div><div className="chat-context"><span className={'status-dot ' + (!perception.allowed ? 'off' : '')} />{state.continuous ? (state.voicePhase === 'loading' ? '正在连接…' : state.voicePhase === 'transcribing' ? '正在转写…' : state.status === 'speaking' ? '正在播报…' : state.busy ? '等待模型回复…' : '正在倾听…') : state.recording ? '正在录音' : state.voicePhase === 'transcribing' ? '正在转写…' : state.status === 'listening' ? '正在倾听' : perception.reason || (state.companion?.screen.onMessage ? '下次发送尝试附图' : '本轮不附带屏幕')}</div></section>;
}
