export class VoiceSession {
  constructor(options) {
    this.options = options;
    this.epoch = 0;
    this.active = false;
    this.mode = 'draft';
    this.detector = null;
    this.speaking = false;
    this.chunks = [];
    this.pending = [];
    this.queue = Promise.resolve();
    this.limit = null;
    this.finishing = false;
  }

  state(phase) { this.options.onState({ mode: this.mode, active: this.active, speaking: this.speaking, phase }); }

  async start(mode) {
    await this.stop();
    const epoch = ++this.epoch;
    this.mode = mode; this.active = true; this.chunks = []; this.pending = []; this.queue = Promise.resolve();
    this.state('loading');
    const current = () => this.epoch === epoch && this.active;
    let detector;
    try {
      detector = await this.options.createDetector({
        silenceSeconds: this.options.silenceSeconds(),
        isActive: current,
        onSpeechRealStart: () => {
          if (!current()) return;
          this.speaking = true;
          if (mode === 'call') {
            this.options.onInterrupt();
            clearTimeout(this.limit);
            this.limit = setTimeout(async () => {
              if (!current() || !this.detector) return;
              try { await this.detector.pause(); if (current()) await this.detector.start(); }
              catch (error) { if (current()) { void this.stop(); this.options.onError(error); } }
            }, 30000);
          }
          this.state('listening');
        },
        onVADMisfire: () => { if (current()) { this.speaking = false; this.flush(); this.state('listening'); } },
        onSpeechEnd: (samples) => {
          if (!current()) return;
          this.speaking = false;
          if (mode === 'call') { clearTimeout(this.limit); this.limit = null; }
          // VAD confirms human speech; reject empty, tiny or near-silent payloads too.
          if (samples.length < 6400 || !samples.every(Number.isFinite) || Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length) < .0008) { this.flush(); this.state('listening'); return; }
          if (mode === 'draft') this.chunks.push(samples.slice());
          else this.enqueue(samples.slice(), epoch);
        },
        onError: (error) => { if (current()) { void this.stop(); this.options.onError(error); } },
      });
      if (!current()) { await detector.destroy(); return; }
      this.detector = detector;
      await detector.start();
      if (!current()) { await detector.destroy(); return; }
      this.state('listening');
      if (mode === 'draft') this.limit = setTimeout(() => { void this.finishDraft(); }, 60000);
    } catch (error) {
      await detector?.destroy().catch(() => {});
      if (this.epoch === epoch) { await this.stop(); this.options.onError(error); }
    }
  }

  flush() {
    if (!this.active || this.mode !== 'call' || this.speaking || !this.pending.length || !this.pending.every((part) => part.done)) return;
    const text = this.pending.map((part) => part.text).filter(Boolean).join(' ');
    this.pending = [];
    if (text) this.options.onTranscript(text, 'call');
  }

  enqueue(samples, epoch) {
    const item = { text: '', done: false };
    this.pending.push(item); this.state('transcribing');
    // Keep ASR ordering, but never wait for LLM/TTS before listening to the next utterance.
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (this.epoch !== epoch || !this.active || !this.pending.includes(item)) return;
      try { item.text = (await this.options.transcribe(samples)).trim(); }
      catch (error) { if (this.epoch === epoch) this.options.onError(error); }
      if (this.epoch !== epoch || !this.active || !this.pending.includes(item)) return;
      item.done = true;
      this.flush();
      this.state('listening');
    });
  }

  discardPending() { this.pending = []; }

  async finishDraft() {
    if (!this.active || this.mode !== 'draft' || this.finishing) return;
    this.finishing = true;
    const epoch = this.epoch, detector = this.detector;
    clearTimeout(this.limit); this.limit = null;
    try {
      await detector?.pause();
      if (this.epoch !== epoch) return;
      this.active = false; this.speaking = false; this.detector = null; this.state('transcribing');
      await detector?.destroy();
      if (this.epoch !== epoch) return;
      const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (length) {
        const samples = new Float32Array(length); let offset = 0;
        for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
        const text = (await this.options.transcribe(samples)).trim();
        if (this.epoch === epoch) this.options.onTranscript(text, 'draft');
      } else this.options.onTranscript('', 'draft');
    } catch (error) { if (this.epoch === epoch) this.options.onError(error); }
    finally { if (this.epoch === epoch) { this.finishing = false; this.chunks = []; this.state('idle'); } }
  }

  async stop() {
    this.epoch++; this.active = false; this.speaking = false;
    this.finishing = false;
    clearTimeout(this.limit); this.limit = null;
    const detector = this.detector; this.detector = null;
    this.chunks = []; this.pending = [];
    this.state('idle');
    await detector?.destroy().catch(() => {});
  }
}
