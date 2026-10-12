const test = require('node:test');
const assert = require('node:assert/strict');

test('explicit MiniMax HTTP endpoint corrects compatible provider without changing credentials or other fields', async () => {
  const { normalizeTtsSettings } = await import('../../apps/desktop/tts.mjs');
  for (const provider of ['openai', 'custom']) {
    for (const baseUrl of ['https://api.minimax.cn/v1/t2a_v2', 'https://api-bj.minimaxi.com/v1/t2a_v2/', 'http://127.0.0.1:12345/minimax/v1/t2a_v2?GroupId=fixture']) {
      const original = { provider, baseUrl, model: 'speech-2.8-hd', voice: 'Chinese (Mandarin)_Warm_Girl', apiKey: 'fixture-key', autoplay: false };
      assert.deepEqual(normalizeTtsSettings(original), { ...original, provider: 'minimax' });
      assert.equal(original.provider, provider);
    }
  }
});

test('normalization does not guess from hostname or override explicit local and MiniMax selection', async () => {
  const { normalizeTtsSettings } = await import('../../apps/desktop/tts.mjs');
  for (const value of [
    { provider: 'openai', baseUrl: 'https://api.minimax.cn/v1' },
    { provider: 'custom', baseUrl: 'https://compatible.invalid/v1/audio/speech' },
    { provider: 'local', baseUrl: 'https://api.minimax.cn/v1/t2a_v2' },
    { provider: 'minimax', baseUrl: 'https://api.minimax.cn/v1' },
  ]) assert.equal(normalizeTtsSettings(value), value);
});

test('invalid addresses and WebSocket endpoints remain unchanged for validation', async () => {
  const { normalizeTtsSettings } = await import('../../apps/desktop/tts.mjs');
  for (const baseUrl of ['', 'not-a-url', 'wss://api-bj.minimaxi.com/ws/v1/t2a_v2', 'https://api-bj.minimaxi.com/ws/v1/t2a_v2', 'https://api.minimax.cn/v1/t2a_v2/audio/speech']) {
    const value = { provider: 'openai', baseUrl };
    assert.equal(normalizeTtsSettings(value), value);
  }
});
