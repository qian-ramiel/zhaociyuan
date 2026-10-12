import { MicVAD, utils } from '@ricky0123/vad-web';
import type { DetectorOptions, VoiceDetector } from '../../voice-session.mjs';

export async function createVoiceDetector(options: DetectorOptions): Promise<VoiceDetector> {
  let stream: MediaStream | null = null;
  const context = new AudioContext();
  let vad: MicVAD | undefined;
  let started = false, destroyed = false;
  let lastFrame = 0;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const release = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
  try {
    vad = await MicVAD.new({
      model: 'v5', startOnLoad: false, audioContext: context,
      baseAssetPath: '/voice-assets/', onnxWASMBasePath: '/voice-assets/',
      ortConfig: (ort) => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
      positiveSpeechThreshold: .55, negativeSpeechThreshold: .35, minSpeechMs: 300,
      redemptionMs: Math.max(500, Math.min(3000, options.silenceSeconds * 1000)), preSpeechPadMs: 300,
      submitUserSpeechOnPause: true,
      getStream: async () => {
        const next = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!options.isActive()) { next.getTracks().forEach((track) => track.stop()); throw new Error('录音已取消'); }
        stream = next;
        next.getAudioTracks().forEach((track) => track.addEventListener('ended', () => { if (options.isActive()) options.onError(new Error('麦克风连接中断')); }, { once: true }));
        return next;
      },
      pauseStream: async () => {},
      resumeStream: async () => { if (!stream || !options.isActive()) throw new Error('录音已取消'); return stream; },
      onSpeechRealStart: options.onSpeechRealStart, onSpeechEnd: options.onSpeechEnd, onVADMisfire: options.onVADMisfire,
      onFrameProcessed: () => { lastFrame = performance.now(); },
    });
    const detector = vad;
    return {
      start: async () => {
        await context.resume(); await detector.start(); if (detector.errored) throw new Error(detector.errored);
        started = true; lastFrame = performance.now();
        clearInterval(watchdog);
        watchdog = setInterval(() => {
          if (!options.isActive() || destroyed) return;
          if (context.state === 'suspended') void context.resume().catch(() => options.onError(new Error('后台录音暂停，请重新连接麦克风')));
          if (performance.now() - lastFrame > 15000) options.onError(new Error('麦克风长时间没有音频帧，请检查输入设备后重新通话'));
        }, 3000);
      },
      pause: () => detector.pause(),
      destroy: async () => {
        if (destroyed) return;
        destroyed = true; clearInterval(watchdog); release();
        try { await detector.destroy(); }
        catch (error) {
          // vad-web 0.0.31 cannot destroy a model before microphone initialization.
          if (started) throw error;
          await (detector as unknown as { model: { release(): Promise<void> } }).model.release();
        } finally { if (context.state !== 'closed') await context.close(); }
      },
    };
  } catch (error) { release(); await vad?.destroy().catch(() => {}); await context.close().catch(() => {}); throw error; }
}

export function voiceWav(samples: Float32Array) { return new Blob([utils.encodeWAV(samples, 1, 16000, 1, 16)], { type: 'audio/wav' }); }
