import asyncio
import json
import sys
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from server.app import api, llm, speech
from server.app.models import LlmSettings, PersonaSettings, TtsSettings, CompanionReply
from server.tests.test_v1 import client, empty_client, configure_model


def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


class TextStream(httpx.AsyncByteStream):
    def __init__(self, frames):
        self.frames = frames
        self.closed = False
    async def __aiter__(self):
        for frame in self.frames:
            yield frame.encode()
            await asyncio.sleep(0)
    async def aclose(self):
        self.closed = True


def delta(text, reason=None):
    return 'data: ' + json.dumps({'choices': [{'delta': {'content': text}, 'finish_reason': reason}]}) + '\n\n'


def test_llm_partial_json_streams_only_text_before_completion(monkeypatch):
    frames = TextStream([delta('{"text":"你好。'), delta('继续聊。","speech":"你好。继续聊。","emotion":"happy"}'), delta('', 'stop'), 'data: [DONE]\n\n'])
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=frames)
    transport(monkeypatch, handler)
    received = []
    async def run():
        async def on_text(text):
            assert not frames.closed
            received.append(text)
        return await llm.complete(LlmSettings(baseUrl='https://fixture/v1', model='fixture'), PersonaSettings(), [{'role': 'user', 'content': '你好'}], [], [], [], on_text=on_text)
    result = asyncio.run(run())
    assert received[0] == '你好。'
    assert ''.join(received) == result.text == '你好。继续聊。'
    assert frames.closed and calls[0]['stream'] is True


@pytest.mark.parametrize('content', [
    '{"text":"先说重点。\\n下一行。","speech":null,"emotion":"calm","actions":"idle"}',
    '```json\n{"text":"先说重点。\\n下一行。","emotion":"calm"}\n```',
    '{"text":"先说重点。\\n下一行。","emotion":',
])
def test_reply_invalid_metadata_or_trailing_partial_json_never_leaks_schema(content):
    result = llm.parse_reply(content)
    assert result.text == result.speech == '先说重点。\n下一行。'
    assert result.emotion == 'neutral' and result.actions == []


@pytest.mark.parametrize('wrapped', [False, True])
def test_character_incremental_fenced_or_quoted_json_and_invalid_metadata(monkeypatch, wrapped):
    content = json.dumps({'text': '文字一点点出来。继续说。', 'emotion': 'calm', 'actions': 'invalid'}, ensure_ascii=False)
    content = json.dumps(content, ensure_ascii=False) if wrapped else '```json\n' + content + '\n```'
    frames = TextStream([*(delta(char) for char in content), delta('', 'stop'), 'data: [DONE]\n\n'])
    transport(monkeypatch, lambda request: httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=frames))
    received = []
    async def run():
        async def on_text(text):
            assert not frames.closed
            received.append(text)
        return await llm.complete(LlmSettings(baseUrl='https://fixture/v1', model='fixture'), PersonaSettings(), [], [], [], [], on_text=on_text)
    result = asyncio.run(run())
    assert len(received) > 5
    assert ''.join(received) == result.text == '文字一点点出来。继续说。'
    assert result.emotion == 'neutral'
    assert not any('```' in item or '{' in item or 'text' in item for item in received)


def test_reply_missing_text_is_explicit_error_not_raw_json():
    with pytest.raises(HTTPException, match='502'):
        llm.parse_reply('{"emotion":"happy"}')


@pytest.mark.parametrize('tail', ['', delta('', 'length')])
def test_llm_truncated_stream_is_error_not_persistable_json(monkeypatch, tail):
    transport(monkeypatch, lambda request: httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=TextStream([delta('{"text":"半句话'), tail])))
    async def noop(text):
        pass
    with pytest.raises(HTTPException):
        asyncio.run(llm.complete(LlmSettings(baseUrl='https://fixture/v1', model='fixture'), PersonaSettings(), [], [], [], [], on_text=noop))


def test_minimax_stream_decodes_chunks_without_replaying_final_aggregate(monkeypatch):
    chunks = [b'first-mp3', b'second-mp3']
    frames = []
    for status, audio in [(1, chunks[0]), (1, chunks[1]), (2, b''.join(chunks))]:
        frames.append('data: ' + json.dumps({'base_resp': {'status_code': 0}, 'data': {'status': status, 'audio': audio.hex()}}) + '\n\n')
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=TextStream(frames))
    transport(monkeypatch, handler)
    async def run():
        return [chunk async for chunk in speech.stream_remote('你好', TtsSettings(provider='minimax', apiKey='fixture', baseUrl='https://fixture/v1', model='speech-fixture', voice='voice-fixture'))]
    assert asyncio.run(run()) == chunks
    assert calls[0]['stream'] is True and calls[0]['audio_setting']['format'] == 'mp3'


def test_openai_mp3_stream_and_invalid_content(monkeypatch):
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, headers={'content-type': 'audio/mpeg'}, stream=TextStream(['first', 'second']))
    transport(monkeypatch, handler)
    async def run():
        return [chunk async for chunk in speech.stream_remote('hello', TtsSettings(provider='openai', baseUrl='https://fixture/v1'))]
    assert asyncio.run(run()) == [b'first', b'second']
    assert calls[0]['response_format'] == 'mp3'


def test_stream_endpoint_persists_once_and_keeps_structured_actions(client, monkeypatch):
    configure_model(client)
    async def complete(*args, **kwargs):
        await kwargs['on_text']('第一句。')
        await kwargs['on_text']('第二句。')
        return CompanionReply(text='第一句。第二句。', speech='第一句。第二句。', emotion='happy')
    monkeypatch.setattr(llm, 'complete', complete)
    response = client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'stream-success'})
    frames = [json.loads(line) for line in response.text.splitlines()]
    assert [frame['type'] for frame in frames] == ['text', 'text', 'done']
    assert frames[-1]['result']['reply']['emotion'] == 'happy'
    assert [item['content'] for item in client.get('/api/chat/history').json()] == ['测试', '第一句。第二句。']
    assert api.tasks == {}


def test_stream_error_or_early_cancel_does_not_persist(client, monkeypatch):
    configure_model(client)
    async def complete(*args, **kwargs):
        await kwargs['on_text']('没说完')
        raise HTTPException(502, '上游中断')
    monkeypatch.setattr(llm, 'complete', complete)
    response = client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'stream-error'})
    assert json.loads(response.text.splitlines()[-1]) == {'type': 'error', 'message': '上游中断'}
    assert client.get('/api/chat/history').json() == []
    client.post('/api/chat/early-stream/cancel')
    assert client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'early-stream'}).status_code == 499


def test_voice_preferences_defaults_validation_and_role_isolation(client):
    settings = client.get('/api/settings').json()['providers']
    assert settings['asr']['autoSend'] is False and settings['tts']['streaming'] is True
    settings['asr']['autoSend'] = True
    client.put('/api/settings/providers', json=settings)
    second = client.post('/api/roles', json={'name': '新角色'}).json()['id']
    client.post('/api/roles/' + second + '/activate')
    assert client.get('/api/settings').json()['providers']['asr']['autoSend'] is False
    desktop = client.get('/api/desktop').json()
    assert desktop['pushToTalk'] is True
    assert desktop['pushToTalkKey'] == 'ShiftLeft+ShiftRight'
    assert client.put('/api/desktop', json={**desktop, 'pushToTalkKey': 'bad'}).status_code == 422
    assert client.put('/api/desktop', json={**desktop, 'pushToTalkKey': 'ShiftLeft+ShiftRight'}).json()['pushToTalkKey'] == 'ShiftLeft+ShiftRight'


def test_tts_stream_master_switch_and_local_sentence_fallback(client, monkeypatch):
    async def synthesize(text, settings, request_id=None):
        return {'audio_url': '/media/fixture.wav'}
    monkeypatch.setattr(api, 'synthesize_to_file', synthesize)
    frames = [json.loads(line) for line in client.post('/api/tts/stream', json={'text': '一句话'}).text.splitlines()]
    assert frames == [{'type': 'audio-url', 'url': '/media/fixture.wav'}, {'type': 'done'}]
    prefs = client.get('/api/desktop').json()
    client.put('/api/desktop', json={**prefs, 'speechEnabled': False})
    assert client.post('/api/tts/stream', json={'text': '一句话'}).status_code == 409


def test_local_speech_engines_are_reused_and_asr_languages_are_isolated(monkeypatch):
    asr_calls, tts_calls = [], []
    def recognizer(**kwargs):
        asr_calls.append(kwargs)
        return object()
    def config(**kwargs):
        return SimpleNamespace(validate=lambda: True)
    def synthesizer(configuration):
        tts_calls.append(configuration)
        return object()
    monkeypatch.setitem(sys.modules, 'sherpa_onnx', SimpleNamespace(
        OfflineRecognizer=SimpleNamespace(from_sense_voice=recognizer),
        OfflineTtsConfig=config, OfflineTtsModelConfig=config, OfflineTtsKokoroModelConfig=config,
        OfflineTts=synthesizer,
    ))
    speech.asr_engine.cache_clear()
    speech.tts_engine.cache_clear()
    try:
        first = speech.asr_engine('/fixture/asr', 'zh')
        assert speech.asr_engine('/fixture/asr', 'zh') is first
        assert speech.asr_engine('/fixture/asr', 'auto') is not first
        assert [call['language'] for call in asr_calls] == ['zh', '']
        tts = speech.tts_engine('/fixture/tts')
        assert speech.tts_engine('/fixture/tts') is tts and len(tts_calls) == 1
        assert speech._engine_lock is not speech._tts_lock
    finally:
        speech.asr_engine.cache_clear()
        speech.tts_engine.cache_clear()
