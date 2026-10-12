const test = require('node:test');
const assert = require('node:assert/strict');
const speech = () => new Float32Array(16000).fill(.1);
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(overrides = {}) {
  const { VoiceSession } = await import('../../apps/desktop/voice-session.mjs');
  const events = [], uploads = [];
  let callbacks, released = 0;
  const detector = { start: async () => {}, pause: async () => {}, destroy: async () => { released++; } };
  const session = new VoiceSession({
    createDetector: async (value) => { callbacks = value; return detector; },
    silenceSeconds: () => 1.2,
    transcribe: async (audio) => { uploads.push(audio); return '有效语音'; },
    onState: (state) => events.push(['state', state]), onInterrupt: () => events.push(['interrupt']),
    onTranscript: (...args) => events.push(['text', ...args]), onError: (error) => events.push(['error', String(error)]), ...overrides,
  });
  return { session, detector, events, uploads, callbacks: () => callbacks, released: () => released };
}

test('manual recording accumulates confirmed segments and fills draft only after stop', async () => {
  const f = await fixture(); await f.session.start('draft');
  f.callbacks().onSpeechRealStart(); f.callbacks().onSpeechEnd(speech());
  assert.equal(f.uploads.length, 0); assert.equal(f.events.filter(([e]) => e === 'interrupt').length, 0);
  f.detector.pause = async () => f.callbacks().onSpeechEnd(speech());
  await f.session.finishDraft();
  assert.equal(f.uploads[0].length, 32000);
  assert.deepEqual(f.events.filter(([e]) => e === 'text'), [['text', '有效语音', 'draft']]);
  assert.equal(f.session.active, false); assert.equal(f.released(), 1);
});

test('no voice, brief noise and silent/nonfinite segments never reach ASR', async () => {
  const f = await fixture(); await f.session.start('call');
  f.callbacks().onVADMisfire();
  for (const samples of [new Float32Array(16000), new Float32Array(100).fill(.2), new Float32Array(16000).fill(NaN)]) f.callbacks().onSpeechEnd(samples);
  await flush(); assert.equal(f.uploads.length, 0);
  await f.session.stop();
});

test('call ends utterances automatically while listener stays active and interruption happens before transcript', async () => {
  const f = await fixture(); await f.session.start('call');
  f.callbacks().onSpeechRealStart();
  assert.equal(f.events.filter(([e]) => e === 'interrupt').length, 1);
  f.callbacks().onSpeechEnd(speech()); await flush();
  assert.deepEqual(f.events.filter(([e]) => e === 'text'), [['text', '有效语音', 'call']]);
  assert.equal(f.session.active, true); assert.equal(f.released(), 0);
  f.callbacks().onSpeechRealStart(); f.callbacks().onSpeechEnd(speech()); await flush();
  assert.equal(f.events.filter(([e]) => e === 'text').length, 2);
  await f.session.stop();
});

test('speaking again during slow ASR holds first phrase and sends ordered combined transcript', async () => {
  let resolve;
  const f = await fixture({ transcribe: () => new Promise((done) => { resolve = done; }) });
  await f.session.start('call'); f.callbacks().onSpeechRealStart(); f.callbacks().onSpeechEnd(speech()); await flush();
  f.callbacks().onSpeechRealStart(); resolve('第一句'); await flush();
  assert.equal(f.events.filter(([e]) => e === 'text').length, 0);
  f.callbacks().onSpeechEnd(speech()); await flush(); resolve('第二句'); await flush();
  assert.deepEqual(f.events.filter(([e]) => e === 'text'), [['text', '第一句 第二句', 'call']]);
  await f.session.stop();
});

test('hangup discards late ASR and previous-session callbacks', async () => {
  let resolve;
  const f = await fixture({ transcribe: () => new Promise((done) => { resolve = done; }) });
  await f.session.start('call'); const old = f.callbacks();
  old.onSpeechRealStart(); old.onSpeechEnd(speech()); await flush(); await f.session.stop();
  resolve('迟到结果'); await flush();
  await f.session.start('draft'); old.onSpeechRealStart(); old.onSpeechEnd(speech());
  assert.equal(f.events.filter(([e]) => e === 'text').length, 0);
  assert.equal(f.events.filter(([e]) => e === 'interrupt').length, 1);
  await f.session.stop();
});

test('canceling startup destroys detector once ready without starting microphone', async () => {
  let ready, starts = 0, destroyed = 0;
  const f = await fixture({ createDetector: () => new Promise((resolve) => { ready = resolve; }) });
  const start = f.session.start('call'); await flush(); await f.session.stop();
  ready({ start: async () => { starts++; }, destroy: async () => { destroyed++; } }); await start;
  assert.equal(starts, 0); assert.equal(destroyed, 1); assert.equal(f.session.active, false);
});

test('canceling manual ASR never fills a new role draft', async () => {
  let resolve;
  const f = await fixture({ transcribe: () => new Promise((done) => { resolve = done; }) });
  await f.session.start('draft'); f.callbacks().onSpeechEnd(speech());
  const finish = f.session.finishDraft(); await flush(); await f.session.stop(); resolve('旧角色语音'); await finish;
  assert.equal(f.events.filter(([e]) => e === 'text').length, 0);
});

test('text interruption invalidates queued voice without stopping listening', async () => {
  let resolve;
  const f = await fixture({ transcribe: () => new Promise((done) => { resolve = done; }) });
  await f.session.start('call'); f.callbacks().onSpeechRealStart(); f.callbacks().onSpeechEnd(speech()); await flush();
  f.session.discardPending(); resolve('被文字替代的旧转写'); await flush();
  assert.equal(f.events.filter(([e]) => e === 'text').length, 0);
  assert.equal(f.session.active, true);
  await f.session.stop();
});

test('ASR error does not leave call stuck and microphone errors end the session', async () => {
  const f = await fixture({ transcribe: async () => { throw Error('ASR failure'); } });
  await f.session.start('call'); f.callbacks().onSpeechRealStart(); f.callbacks().onSpeechEnd(speech()); await flush();
  assert.equal(f.session.active, true); assert.equal(f.events.filter(([e]) => e === 'error').length, 1);
  f.callbacks().onError(Error('device ended')); await flush(); assert.equal(f.session.active, false);
});
