// Headless-test substitute only; production loads the real Silero adapter.
export async function createVoiceDetector(options) {
  window.__voiceOptions = options;
  let stream, destroyed = false;
  const release = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
  return {
    start: async () => {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!options.isActive()) { release(); return; }
      if (window.__micMode === 'invalid-recorder') { release(); throw Error('fixture recorder unavailable'); }
      window.__metrics.recorderStarts++;
    },
    pause: async () => { if (window.__voiceTail) { options.onSpeechEnd(new Float32Array(16000).fill(.1)); window.__voiceTail = false; } },
    destroy: async () => { if (!destroyed) { destroyed = true; release(); } },
  };
}
export function voiceWav() { return new Blob(['isolated audio'], { type: 'audio/wav' }); }
