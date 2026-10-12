const test = require('node:test');
const assert = require('node:assert/strict');

test('bubble text removes Markdown wrappers without executing HTML or dropping code content', async () => {
  const { companionText } = await import('../../apps/desktop/companion-text.mjs');
  const text = companionText('# 提醒\n\n**先保存**，使用 `Esc`。\n\n[查看设置](https://example.test)\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>');
  assert.equal(text, '提醒\n\n先保存，使用 Esc。\n\n查看设置\n\nconst x = 1;');
  assert.equal(companionText(JSON.stringify({ text: '一行\n下一行', emotion: 'invalid' })), '一行\n下一行');
  assert.doesNotMatch(companionText('{"text":"半句话'), /\{"text"/);
});

test('streamed speech keeps all sentences and flushes an unpunctuated final suffix once', async () => {
  const { SentenceQueue } = await import('../../apps/desktop/sentence-queue.mjs');
  const spoken = [], errors = [];
  const queue = new SentenceQueue(async (text) => spoken.push(text), (error) => errors.push(error));
  queue.add('第一'); queue.add('句。第二句！最后没有标点');
  await queue.finish(); await queue.finish();
  assert.deepEqual(spoken, ['第一句。', '第二句！', '最后没有标点']);
  assert.deepEqual(errors, []);
});

test('a sentence synthesis failure is reported but does not cancel later sentences', async () => {
  const { SentenceQueue } = await import('../../apps/desktop/sentence-queue.mjs');
  const spoken = [], errors = [];
  const queue = new SentenceQueue(async (text) => { spoken.push(text); if (text === '第二句。') throw Error('fixture TTS failure'); }, (error) => errors.push(error.message));
  queue.add('第一句。第二句。第三句。'); await queue.finish();
  assert.deepEqual(spoken, ['第一句。', '第二句。', '第三句。']);
  assert.deepEqual(errors, ['fixture TTS failure']); assert.equal(queue.controller.signal.aborted, false);
});

test('manual interruption still discards queued sentences and late text', async () => {
  const { SentenceQueue } = await import('../../apps/desktop/sentence-queue.mjs');
  const spoken = [];
  let release;
  const queue = new SentenceQueue(async (text) => { spoken.push(text); await new Promise((resolve) => { release = resolve; }); }, () => assert.fail('cancel must not report error'));
  queue.add('第一句。第二句。'); await new Promise(setImmediate);
  queue.cancel(); release(); queue.add('迟到的一句。'); await queue.finish();
  assert.deepEqual(spoken, ['第一句。']);
});
