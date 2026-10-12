import { companionText } from './companion-text.mjs';

export class SentenceQueue {
  constructor(speak, onError) {
    this.speak = speak; this.onError = onError;
    this.buffer = ''; this.queue = Promise.resolve(); this.count = 0;
    this.controller = new AbortController();
  }
  add(delta, final = false) {
    if (this.controller.signal.aborted) return;
    this.buffer += delta;
    let end;
    while (this.buffer.trim() && ((end = this.buffer.search(/[。！？!?\n]|\.(?=\s)/)) >= 0 || this.buffer.length >= 80 || final)) {
      const length = end >= 0 ? end + 1 : Math.min(80, this.buffer.length);
      const sentence = companionText(this.buffer.slice(0, length)); this.buffer = this.buffer.slice(length);
      if (!sentence) continue;
      if (++this.count > 200) { this.cancel(); this.onError(Error('播报内容过长')); return; }
      this.queue = this.queue.then(async () => {
        if (!this.controller.signal.aborted) await this.speak(sentence);
      }).catch((error) => {
        // A failed sentence is reported, but must not silently discard the rest of the reply.
        if (!this.controller.signal.aborted) this.onError(error);
      });
    }
  }
  finish() { this.add('', true); return this.queue; }
  cancel() { this.controller.abort(); }
}
