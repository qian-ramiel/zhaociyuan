import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, UserRound } from 'lucide-react';
import type { Appearance, Binding, Emotion, Status } from '../types';
import { api } from '../api';

export function Avatar({ appearance, emotion = 'neutral', status = 'idle', motions = [], onError, onBoundsChange }: { appearance?: Appearance; emotion?: Emotion; status?: Status; motions?: Binding[]; onError?: (error: string) => void; onBoundsChange?: (bounds: { top: number; bottom: number; height: number }) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const callback = useRef(onError);
  const gaze = appearance?.gaze;
  const look = (event: React.PointerEvent<HTMLElement>) => {
    if (!ready || appearance?.kind !== 'live2d' || gaze?.enabled === false) return;
    const bounds = (event.currentTarget.closest('.avatar-viewport') || event.currentTarget).getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height * 2));
    void import('../live2d/main').then((m) => m.lookAtLive2D(x * (gaze?.strength ?? .7), y * (gaze?.strength ?? .7), gaze?.head !== false));
  };
  callback.current = onError;
  useEffect(() => {
    if (!ready || appearance?.kind !== 'live2d') return;
    let active = true;
    const mouth = (event: Event) => {
      const level = (event as CustomEvent<number>).detail;
      if (Number.isFinite(level)) void import('../live2d/main').then((module) => { if (active) module.setLive2DVoiceMouth(level); });
    };
    window.addEventListener('companion-mouth', mouth);
    return () => { active = false; window.removeEventListener('companion-mouth', mouth); };
  }, [ready, appearance?.kind]);
  useEffect(() => {
    if (!onBoundsChange || !viewport.current || !ready) return;
    const element = viewport.current;
    let frame = 0;
    const measure = () => {
      const content = element.querySelector('img,canvas');
      if (!content) return;
      const outer = element.getBoundingClientRect(), inner = content.getBoundingClientRect();
      let top = inner.top, bottom = inner.bottom, left = inner.left, width = inner.width;
      if (content instanceof HTMLImageElement && content.naturalWidth) {
        const height = Math.min(inner.width / content.naturalWidth, inner.height / content.naturalHeight) * content.naturalHeight;
        top += (inner.height - height) * (appearance?.framing === 'half' ? 0 : 1);
        bottom = top + height;
        width = height * content.naturalWidth / content.naturalHeight;
        left += (inner.width - width) / 2;
      }
      const fallback = { top: Math.max(0, top - outer.top), bottom: Math.min(outer.height, bottom - outer.top), height: outer.height };
      onBoundsChange(fallback);
      cancelAnimationFrame(frame);
      // Sample only the rendered character asset, not the desktop. Ignore transparent model margins.
      frame = requestAnimationFrame(() => {
        if (!outer.width || !outer.height) return;
        const sample = document.createElement('canvas'); sample.width = 96; sample.height = Math.min(256, Math.max(1, Math.round(96 * outer.height / outer.width)));
        const context = sample.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        try {
          context.drawImage(content as HTMLImageElement | HTMLCanvasElement, (left - outer.left) * sample.width / outer.width, (top - outer.top) * sample.height / outer.height, width * sample.width / outer.width, (bottom - top) * sample.height / outer.height);
          const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
          let first = sample.height, last = -1;
          for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) if (pixels[(y * sample.width + x) * 4 + 3] > 16) { first = Math.min(first, y); last = y; break; }
          if (last >= first) onBoundsChange({ top: first * outer.height / sample.height, bottom: (last + 1) * outer.height / sample.height, height: outer.height });
        } catch { /* Geometry remains available if an asset cannot be sampled. */ }
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ready, appearance?.framing, appearance?.scale, onBoundsChange]);
  useEffect(() => {
    let active = true;
    setError(''); setReady(false);
    if (!appearance || appearance.kind === 'static' || !canvas.current) return;
    const target = canvas.current;
    import('../live2d/main').then(async (module) => {
      if (!active || !canvas.current) return;
      try {
        await module.initializeLive2D(target, '/assets/characters/' + appearance.modelPath);
        if (active) setReady(true);
      } catch {
        if (active) { setError(t("形象加载失败")); callback.current?.(t("形象加载失败，请检查资源包")); }
      }
    });
    return () => { active = false; import('../live2d/main').then((m) => m.disposeLive2D(target)); };
  }, [appearance?.modelPath, appearance?.kind]);
  useEffect(() => {
    if (!ready || !appearance) return;
    void import('../live2d/main').then((m) => m.configureLive2DGaze(gaze?.enabled !== false, gaze?.head !== false));
  }, [ready, appearance?.id, gaze?.enabled, gaze?.head]);
  useEffect(() => {
    if (!ready || !canvas.current || !appearance || appearance.previewUrl || appearance.id === 'preview') return;
    const target = canvas.current;
    const frame = requestAnimationFrame(() => {
      try { void api('/api/characters/' + appearance.assetId + '/preview', 'POST', { image: target.toDataURL('image/png') }).catch(() => {}); } catch { /* Thumbnail failure does not interrupt the character. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, appearance?.assetId, appearance?.previewUrl]);
  useEffect(() => {
    if (!ready || !appearance) return;
    const semantic = status !== 'idle' && status !== 'observing' ? status : emotion === 'neutral' ? 'idle' : emotion;
    const binding = [...appearance.bindings, ...motions].find((item) => item.semantic === semantic);
    import('../live2d/main').then((module) => {
      const group = binding?.motionGroup || (semantic === 'idle' && appearance.motions.Idle ? 'Idle' : '');
      if (group) module.playLive2DMotion(group, binding?.motionIndex || 0, 2);
      if (binding?.expression) module.setLive2DExpression(binding.expression);
    });
  }, [ready, appearance, emotion, status, motions]);
  if (!appearance) return <div className="avatar-empty"><UserRound size={44} /><span>{t("未选择形象")}</span></div>;
  return <div ref={viewport} className={`avatar-viewport ${appearance.framing}`} data-testid="avatar" data-appearance={appearance.id} onPointerMove={(e) => { if (gaze?.trigger !== 'click') look(e); }} onPointerDown={look} onPointerLeave={() => { void import('../live2d/main').then((m) => m.lookAtLive2D(0, 0, gaze?.head !== false)); }} style={{ '--avatar-scale': appearance.scale } as React.CSSProperties}>
    {appearance.kind === 'static' ? <img className="portrait" src={'/assets/characters/' + appearance.modelPath} alt={appearance.name} onLoad={() => setReady(true)} onError={() => { setError(t("立绘加载失败")); callback.current?.(t("立绘加载失败")); }} /> : <canvas ref={canvas} aria-label={appearance.name + ' Live2D'} onPointerUp={look} />}
    {!ready && <div className="avatar-loading">{error ? <AlertCircle size={20} /> : <LoaderCircle size={20} className="spin" />}<span>{error || t("正在加载形象")}</span></div>}
  </div>;
}
