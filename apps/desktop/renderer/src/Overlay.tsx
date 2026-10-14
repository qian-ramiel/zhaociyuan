import { t, useLanguage, setLanguage, modeLabel } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, GripHorizontal, GripVertical, MessageCircle, Phone, PhoneOff, Settings, Sparkles, UserRound, UserRoundX, Volume2, VolumeX, X } from 'lucide-react';
import { cleanError } from '../../errors.mjs';
import { companionText } from '../../companion-text.mjs';
import { api } from './api';
import type { Bootstrap, DesktopPreferences, OverlayState } from './types';
import { Avatar } from './components/Avatar';
import { IconButton } from './components/Ui';

export function useCompanionState() {
  const [state, setState] = useState<OverlayState | null>(null);
  useEffect(() => {
    let active = true;
    api<Bootstrap>('/api/bootstrap').then((data) => { if (!active) return; setLanguage(data.desktop.language); if (active) setState((current) => current || { persona: data.settings.persona, appearance: data.appearances.find((a) => a.id === data.settings.companion.activeAppearanceId), emotion: 'neutral', status: 'idle', message: '', muted: false, motions: data.settings.motions, appearances: data.appearances, modes: data.modes, companion: data.settings.companion, messages: data.messages, desktopPreferences: data.desktop, roles: data.roles }); }).catch(() => {});
    const unsubscribe = window.desktop?.onState(setState);
    return () => { active = false; unsubscribe?.(); };
  }, []);
  return state;
}

export default function Overlay() {
  useLanguage();
  const state = useCompanionState();
  const [visible, setVisible] = useState(false);
  const [popover, setPopover] = useState<'appearance' | 'mode' | null>(null);
  const [bubbleVisible, setBubbleVisible] = useState(false);
  const [preferences, setPreferences] = useState<DesktopPreferences | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [draftHeight, setDraftHeight] = useState<number | null>(null);
  const [avatarBounds, setAvatarBounds] = useState({ top: 0, bottom: 0, height: 0 });
  const [interacting, setInteracting] = useState(false);
  const resizing = useRef<{ y: number; height: number; next: number } | null>(null);
  const prefs = preferences ?? state?.desktopPreferences;
  const savedHeight = prefs?.bubbleHeight ?? 72;
  const bubbleHeight = draftHeight ?? savedHeight;
  const bubbleShown = prefs?.showBubble !== false && !!state?.message && bubbleVisible;
  const shown = visible || prefs?.menu === 'always';
  useEffect(() => { setPreferences(state?.desktopPreferences); }, [state?.desktopPreferences]);
  const save = async (patch: Partial<DesktopPreferences>) => {
    if (!window.desktop) return;
    setPending(true); setError('');
    try { const next = await window.desktop.overlay(patch); setPreferences(next); return next; }
    catch (error) { setError(cleanError(error)); }
    finally { setPending(false); }
  };
  const previewHeight = (height: number) => {
    const next = Math.max(56, Math.min(280, Math.round(height)));
    setDraftHeight(next);
    if (resizing.current) resizing.current.next = next;
    void window.desktop?.overlay({ bubbleHeightPreview: next }).catch((error) => setError(cleanError(error)));
  };
  const finishResize = async (cancel = false) => {
    const drag = resizing.current;
    if (!drag) return;
    resizing.current = null;
    const next = await save({ bubbleHeight: cancel ? drag.height : drag.next });
    // Roll back transient window geometry without retrying a failed settings write.
    if (!next) await window.desktop?.overlay({ bubbleHeightPreview: null }).catch(() => {});
    setDraftHeight(null);
    const bubble = area.current?.querySelector('.speech-bubble');
    setInteracting(!!bubble && (bubble.matches(':hover') || bubble.contains(document.activeElement)));
  };
  const replyId = state?.messages && [...state.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.id;
  const roleId = state?.companion?.characterId;
  const hideAfter = prefs?.bubbleAutoHide ?? 8;
  useEffect(() => { setBubbleVisible(!!state?.message); }, [replyId, roleId, state?.message]);
  useEffect(() => {
    if (!bubbleVisible || !hideAfter || state?.status === 'speaking' || state?.busy || interacting || draftHeight !== null) return;
    const timeout = setTimeout(() => setBubbleVisible(false), hideAfter * 1000);
    return () => clearTimeout(timeout);
  }, [bubbleVisible, replyId, roleId, hideAfter, state?.status === 'speaking', state?.busy, state?.message, interacting, draftHeight]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const entered = useRef(false);
  useEffect(() => {
    const root = area.current;
    if (!root) { window.desktop?.pointerRegions?.([], false); return; }
    const publish = () => {
      const regions: { x: number; y: number; width: number; height: number }[] = [];
      const add = (element: Element | null) => {
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      };
      const avatar = root.querySelector('.avatar-viewport');
      if (avatar && avatarBounds.bottom > avatarBounds.top) {
        const rect = avatar.getBoundingClientRect();
        regions.push({ x: rect.x, y: rect.y + avatarBounds.top, width: rect.width, height: avatarBounds.bottom - avatarBounds.top });
      }
      if (bubbleShown) { add(root.querySelector('.speech-bubble')); add(root.querySelector('.bubble-resize')); }
      if (shown) { add(root.querySelector('.overlay-controls')); add(root.querySelector('.overlay-popover')); }
      add(root.querySelector('.overlay-error'));
      window.desktop?.pointerRegions?.(regions, draftHeight !== null);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(root);
    const frame = requestAnimationFrame(publish);
    window.addEventListener('resize', publish);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', publish); };
  }, [state?.appearance, avatarBounds, bubbleShown, shown, popover, error, draftHeight, prefs?.bubbleWidth, prefs?.showGrip]);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const show = () => { entered.current = true; clear(); setVisible(true); };
  const leave = () => {
    entered.current = false; clear();
    timer.current = setTimeout(() => {
      if (!entered.current && !area.current?.contains(document.activeElement)) { setVisible(false); setPopover(null); }
    }, 5000);
  };
  useEffect(() => { document.documentElement.classList.add('overlay-root'); return () => { clear(); document.documentElement.classList.remove('overlay-root'); }; }, []);
  if (!state?.appearance) return null;
  const mode = state.modes?.find((m) => m.id === state.companion?.mode);
  const appearance = state.desktopPreferences?.gazeEnabled === false ? { ...state.appearance, gaze: { enabled: false, head: false, strength: 0, trigger: 'hover' as const } } : state.appearance;
  const bubbleBottom = bubbleHeight + 16 + avatarBounds.top - 8;
  return <div className="desktop-companion" style={{ paddingTop: bubbleHeight + 16 }} ref={area} onPointerEnter={show} onPointerMove={show} onPointerLeave={leave} onFocus={show} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && !entered.current) leave(); }}>
    {state.message && bubbleShown && <div className="speech-bubble" style={{ width: `${prefs?.bubbleWidth ?? 90}%`, fontSize: prefs?.bubbleFontSize ?? 13, height: bubbleHeight, top: bubbleBottom - bubbleHeight }} onPointerEnter={() => setInteracting(true)} onPointerLeave={() => { if (!resizing.current) setInteracting(false); }} onFocus={() => setInteracting(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && !resizing.current) setInteracting(false); }}>
      <button className="bubble-resize" type="button" role="slider" aria-label={t("气泡高度")} aria-valuemin={56} aria-valuemax={280} aria-valuenow={bubbleHeight} aria-orientation="vertical" title={t("拖动调整气泡高度")} disabled={pending} onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); resizing.current = { y: e.screenY, height: bubbleHeight, next: bubbleHeight }; setDraftHeight(bubbleHeight); setInteracting(true); }} onPointerMove={(e) => { const drag = resizing.current; if (drag) previewHeight(drag.height + drag.y - e.screenY); }} onPointerUp={() => { void finishResize(); }} onPointerCancel={() => { void finishResize(true); }} onLostPointerCapture={() => { if (resizing.current) void finishResize(true); }} onKeyDown={(e) => { if (e.key === 'Escape' && resizing.current) { e.preventDefault(); void finishResize(true); return; } const height = e.key === 'Home' ? 56 : e.key === 'End' ? 280 : e.key === 'ArrowUp' ? savedHeight + 10 : e.key === 'ArrowDown' ? savedHeight - 10 : null; if (height === null) return; e.preventDefault(); void save({ bubbleHeight: Math.max(56, Math.min(280, height)) }); }}><GripHorizontal size={14} /></button>
      <div className="speech-bubble-heading"><span>{state.persona.characterName}</span><IconButton title={t("隐藏气泡")} onClick={() => { setBubbleVisible(false); setInteracting(false); }}><X size={12} /></IconButton></div><p>{companionText(state.message)}</p></div>}
    <div className="overlay-avatar"><Avatar appearance={appearance} emotion={state.emotion} status={state.status} motions={state.motions} onBoundsChange={setAvatarBounds} /></div>
    <div className={'overlay-menu ' + (shown ? 'shown' : '')} style={{ bottom: 18 + Math.max(0, avatarBounds.height - avatarBounds.bottom) }} aria-hidden={!shown} inert={!shown} onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.overlay-drag')) e.preventDefault(); }}>
      {popover && <div className="overlay-popover"><strong>{popover === 'appearance' ? t("角色形象") : t("陪伴模式")}</strong>{popover === 'appearance' ? state.appearances?.map((a) => <button key={a.id} className={a.id === state.appearance?.id ? 'selected' : ''} onClick={() => { window.desktop?.command({ type: 'appearance', value: a.id }); setPopover(null); }}>{a.name}{a.id === state.appearance?.id && <Check size={13} />}</button>) : state.modes?.map((m) => <button key={m.id} className={m.id === mode?.id ? 'selected' : ''} onClick={() => { window.desktop?.command({ type: 'mode', value: m.id }); setPopover(null); }}>{modeLabel(m)}{m.id === mode?.id && <Check size={13} />}</button>)}</div>}
      <div className="overlay-toolbar"><div className="overlay-controls">
        {prefs?.showGrip !== false && <div className="overlay-drag" title={t("拖动角色")}><GripVertical size={16} /></div>}
        <IconButton title={t("打开聊天")} onClick={() => window.desktop?.openChat()}><MessageCircle size={16} /></IconButton>
        <IconButton label={t("通话开关")} checked={!!state.continuous} title={state.continuous ? t("挂断通话") : prefs?.hearingEnabled === false ? t("请先开启听觉") : t("开始通话")} active={!!state.continuous} disabled={pending || (prefs?.hearingEnabled === false && !state.continuous)} onClick={() => window.desktop?.command('continuous')}>{state.continuous ? <Phone size={16} /> : <PhoneOff size={16} />}</IconButton>
        <IconButton label={t("屏幕感知总开关")} title={prefs?.visionEnabled !== false ? t("关闭屏幕感知") : t("开启屏幕感知")} checked={prefs?.visionEnabled !== false} active={prefs?.visionEnabled !== false} disabled={pending} onClick={() => { void save({ visionEnabled: prefs?.visionEnabled === false }); }}>{prefs?.visionEnabled !== false ? <Eye size={16} /> : <EyeOff size={16} />}</IconButton>
        <IconButton label={t("语音播放总开关")} checked={!state.muted && prefs?.speechEnabled !== false} active={!state.muted && prefs?.speechEnabled !== false} title={state.muted || prefs?.speechEnabled === false ? t("取消静音") : t("静音")} onClick={() => window.desktop?.command('mute')}>{state.muted || prefs?.speechEnabled === false ? <VolumeX size={16} /> : <Volume2 size={16} />}</IconButton>
        <IconButton title={t("更换形象")} active={popover === 'appearance'} onClick={() => setPopover(popover === 'appearance' ? null : 'appearance')}><UserRound size={16} /></IconButton>
        <IconButton title={t("切换陪伴模式")} active={popover === 'mode'} onClick={() => setPopover(popover === 'mode' ? null : 'mode')}><Sparkles size={16} /></IconButton>
        <IconButton title={t("角色设置")} onClick={() => { window.desktop?.command({ type: 'settings', value: '' }); void window.desktop?.openConsole(); }}><Settings size={16} /></IconButton>
        <IconButton title={t("隐藏角色")} disabled={pending} onClick={() => { void save({ visible: false }); }}><UserRoundX size={16} /></IconButton>
      </div></div>
    </div>
    {error && <div className="overlay-error" role="alert">{t(error)}</div>}
  </div>;
}
