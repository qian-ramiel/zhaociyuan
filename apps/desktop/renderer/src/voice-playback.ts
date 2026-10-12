import { streamApi } from './stream-api';
import { SentenceQueue } from '../../sentence-queue.mjs';

export function emitMouth(level: number) {
  window.dispatchEvent(new CustomEvent('companion-mouth', { detail: level }));
  window.desktop?.lipSync?.(level);
}

export function trackMouth(audio: HTMLAudioElement) {
  let context: AudioContext | undefined, timer: ReturnType<typeof setInterval> | undefined;
  try {
    context = new AudioContext();
    const source = context.createMediaElementSource(audio), analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser); analyser.connect(context.destination);
    void context.resume().catch(() => {});
    const samples = new Float32Array(analyser.fftSize);
    let value = 0;
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
      const target = audio.paused || audio.ended ? 0 : Math.min(1, Math.max(0, (rms - .005) * 8));
      value += (target - value) * (target > value ? .7 : .4);
      emitMouth(value);
    }, 50);
  } catch { /* Playback still works if audio analysis is unavailable. */ }
  return () => { clearInterval(timer); if (context && context.state !== 'closed') void context.close().catch(() => {}); emitMouth(0); };
}

export class StreamSpeaker {
  private queue: SentenceQueue;
  get controller() { return this.queue.controller; }
  private sequence = 0;
  constructor(private play: (audio: HTMLAudioElement | string) => Promise<void>, onError: (error: unknown) => void, private requestId = crypto.randomUUID()) {
    this.queue = new SentenceQueue((text) => this.sentence(text), onError);
  }
  add(delta: string, final = false) { this.queue.add(delta, final); }
  finish() { return this.queue.finish(); }
  cancel() { this.queue.cancel(); }

  private async sentence(text: string) {
    const request = new AbortController(), signal = request.signal;
    const cancelRequest = () => request.abort();
    this.controller.signal.addEventListener('abort', cancelRequest, { once: true });
    const audio = new Audio();
    let media: MediaSource | undefined, source: SourceBuffer | undefined;
    const chunks: Uint8Array[] = [], pending: ArrayBuffer[] = [];
    let finished = false, url = '', playback: Promise<void> | undefined, terminal = false, failure: Error | undefined;
    let received = false, resolveReady: (() => void) | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined, playbackTimer: ReturnType<typeof setTimeout> | undefined;
    let ready: Promise<void> = Promise.resolve();
    const fail = (message: string) => { failure = Error(message); audio.dispatchEvent(new Event('error')); request.abort(); audio.pause(); };
    const pump = () => {
      if (!source || source.updating || signal.aborted) return;
      try {
        const chunk = pending.shift();
        if (chunk) source.appendBuffer(chunk);
        else if (finished && media?.readyState === 'open') media.endOfStream();
      } catch { fail('流式音频解码失败'); }
    };
    const begin = () => {
      if (!playback) {
        playback = this.play(audio);
        playbackTimer = setTimeout(() => fail('音频播放超时，请检查输出设备'), 120000);
        // Observe rejection immediately while network chunks are still arriving.
        void playback.catch((error) => { failure = error instanceof Error ? error : Error('音频播放失败'); });
      }
    };
    const abort = () => { resolveReady?.(); audio.pause(); audio.removeAttribute('src'); audio.load(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const setupMedia = () => {
        media = new MediaSource(); url = URL.createObjectURL(media); audio.src = url;
        ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
          readyTimer = setTimeout(() => { fail('流式音频连接超时'); resolve(); }, 10000);
          media!.addEventListener('sourceopen', () => {
            clearTimeout(readyTimer);
            if (signal.aborted) { resolve(); return; }
            try { source = media!.addSourceBuffer('audio/mpeg'); source.addEventListener('updateend', pump); source.addEventListener('error', () => fail('流式音频格式无法播放')); }
            catch { failure = Error('此浏览器不支持流式 MP3'); }
            resolve();
          }, { once: true });
        });
      };
      await streamApi('/api/tts/stream', { text, requestId: `${this.requestId}-${++this.sequence}` }, (event) => {
        if (event.type === 'error') fail(event.message || '语音生成失败');
        else if (event.type === 'done') terminal = true;
        else if (event.type === 'audio-url') {
          received = true;
          audio.src = event.url!; begin();
        } else if (event.type === 'audio') {
          received = true;
          const binary = atob(event.data!); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          if (!media && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')) setupMedia();
          if (media) { pending.push(bytes.buffer); void ready.then(() => { pump(); if (!failure && !signal.aborted) begin(); }); }
          else chunks.push(bytes);
        }
      }, signal);
      if (failure) throw failure;
      if (!terminal) throw Error('语音流提前中断');
      if (signal.aborted) return;
      if (!received) throw Error('TTS 返回空音频');
      if (media) { await ready; if (failure) throw failure; if (signal.aborted) return; finished = true; pump(); }
      else if (chunks.length) { url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })); audio.src = url; begin(); }
      if (!playback) throw Error('TTS 返回空音频');
      await playback;
      if (failure) throw failure;
    } catch (error) {
      if (!this.controller.signal.aborted) { failure ??= error instanceof Error ? error : Error('语音播放失败'); audio.dispatchEvent(new Event('error')); }
      throw failure || error;
    } finally { clearTimeout(readyTimer); clearTimeout(playbackTimer); this.controller.signal.removeEventListener('abort', cancelRequest); signal.removeEventListener('abort', abort); if (signal.aborted || failure) abort(); if (url) URL.revokeObjectURL(url); }
  }
}
