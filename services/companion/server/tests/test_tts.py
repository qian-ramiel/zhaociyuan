import asyncio
import io
import json
import wave
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from server.app import api, speech
from server.app.models import TtsSettings
from server.tests.test_v1 import client, empty_client


def wav_audio():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(32000)
        audio.writeframes(b'\x00\x00' * 320)
    return buffer.getvalue()


def mock_remote(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(speech.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def minimax_settings():
    return TtsSettings(provider='minimax', baseUrl='https://api-bj.minimaxi.com/v1/t2a_v2', apiKey='fixture-private-key', model='speech-2.8-hd', voice='male-qn-qingse', speed=1.2)


@pytest.mark.parametrize('base', ['https://api-bj.minimaxi.com', 'https://api-bj.minimaxi.com/v1/', 'https://api-bj.minimaxi.com/v1/t2a_v2'])
def test_minimax_http_request_and_hex_decode(tmp_path, monkeypatch, base):
    audio = wav_audio()
    def handler(request):
        assert str(request.url) == 'https://api-bj.minimaxi.com/v1/t2a_v2'
        assert request.headers['Authorization'] == 'Bearer fixture-private-key'
        body = json.loads(request.content)
        assert body == {
            'model': 'speech-2.8-hd', 'text': '你好', 'stream': False, 'output_format': 'hex',
            'voice_setting': {'voice_id': 'male-qn-qingse', 'speed': 1.2, 'vol': 1, 'pitch': 0},
            'audio_setting': {'sample_rate': 32000, 'format': 'wav', 'channel': 1},
        }
        return httpx.Response(200, json={'base_resp': {'status_code': 0}, 'data': {'audio': audio.hex()}})
    mock_remote(monkeypatch, handler)
    settings = minimax_settings().model_copy(update={'baseUrl': base})
    target = tmp_path / 'speech.wav'
    assert asyncio.run(speech.synthesize_remote('你好', settings, target)) == 'minimax'
    assert target.read_bytes() == audio


@pytest.mark.parametrize('provider,base', [('openai', 'https://compatible.invalid/v1/'), ('custom', 'https://compatible.invalid/v1/audio/speech')])
def test_openai_compatible_tts_keeps_existing_contract(tmp_path, monkeypatch, provider, base):
    audio = wav_audio()
    def handler(request):
        assert str(request.url) == 'https://compatible.invalid/v1/audio/speech'
        assert json.loads(request.content) == {'model': 'tts-1', 'voice': 'alloy', 'input': '你好', 'speed': 1, 'response_format': 'wav'}
        return httpx.Response(200, content=audio)
    mock_remote(monkeypatch, handler)
    settings = TtsSettings(provider=provider, baseUrl=base, model='tts-1', voice='alloy')
    target = tmp_path / 'speech.wav'
    asyncio.run(speech.synthesize_remote('你好', settings, target))
    assert target.read_bytes() == audio


@pytest.mark.parametrize('provider', ['openai', 'custom', 'minimax'])
@pytest.mark.parametrize('scheme', ['ws', 'wss'])
def test_websocket_is_rejected_before_network(tmp_path, monkeypatch, provider, scheme):
    def unexpected(**kwargs):
        pytest.fail('Invalid protocol must not make a request')
    monkeypatch.setattr(speech.httpx, 'AsyncClient', unexpected)
    settings = minimax_settings().model_copy(update={'provider': provider, 'baseUrl': scheme + '://api-bj.minimaxi.com/ws/v1/t2a_v2'})
    target = tmp_path / 'speech.wav'
    with pytest.raises(HTTPException) as caught:
        asyncio.run(speech.synthesize_remote('你好', settings, target))
    assert caught.value.status_code == 400
    assert 'WebSocket' in caught.value.detail and 'MiniMax' in caught.value.detail
    assert not target.exists()


@pytest.mark.parametrize('patch', [
    {'baseUrl': 'https://api-bj.minimaxi.com/ws/v1/t2a_v2'},
    {'baseUrl': 'https://api-bj.minimaxi.com/v1/audio/speech'},
    {'baseUrl': 'not-a-url'}, {'apiKey': ''}, {'model': ''}, {'voice': ''},
])
def test_invalid_minimax_configuration_makes_no_request(tmp_path, monkeypatch, patch):
    monkeypatch.setattr(speech.httpx, 'AsyncClient', lambda **kwargs: pytest.fail('Invalid config must not make a request'))
    with pytest.raises(HTTPException) as caught:
        asyncio.run(speech.synthesize_remote('你好', minimax_settings().model_copy(update=patch), tmp_path / 'speech.wav'))
    assert caught.value.status_code == 400


@pytest.mark.parametrize('body', [
    {'base_resp': {'status_code': 1004, 'status_msg': 'invalid api key fixture-private-key'}, 'data': None},
    {'base_resp': {'status_code': 0}, 'data': None},
    {'base_resp': {'status_code': 0}, 'data': {'audio': 'not hex'}},
    {'base_resp': {'status_code': 0}, 'data': {'audio': ''}},
    {'data': {'audio': '0102'}}, ['not-an-object'],
])
def test_minimax_errors_never_save_json_as_audio(tmp_path, monkeypatch, body):
    mock_remote(monkeypatch, lambda request: httpx.Response(200, json=body))
    target = tmp_path / 'speech.wav'
    with pytest.raises(HTTPException) as caught:
        asyncio.run(speech.synthesize_remote('你好', minimax_settings(), target))
    assert caught.value.status_code == 502
    assert 'fixture-private-key' not in caught.value.detail
    assert not target.exists()


def test_invalid_minimax_json_returns_friendly_error(tmp_path, monkeypatch):
    mock_remote(monkeypatch, lambda request: httpx.Response(200, text='not-json'))
    with pytest.raises(HTTPException) as caught:
        asyncio.run(speech.synthesize_remote('你好', minimax_settings(), tmp_path / 'speech.wav'))
    assert caught.value.status_code == 502
    assert '音频格式无效' in caught.value.detail


@pytest.mark.parametrize('status', [401, 404, 429])
def test_remote_http_errors_hide_url_and_credentials(tmp_path, monkeypatch, status):
    mock_remote(monkeypatch, lambda request: httpx.Response(status))
    settings = minimax_settings().model_copy(update={'baseUrl': 'https://api-bj.minimaxi.com/v1/t2a_v2?token=private-query'})
    with pytest.raises(HTTPException) as caught:
        asyncio.run(speech.synthesize_remote('你好', settings, tmp_path / 'speech.wav'))
    assert f'HTTP {status}' in caught.value.detail
    assert 'private-query' not in caught.value.detail
    assert 'fixture-private-key' not in caught.value.detail


def test_minimax_test_and_manual_read_use_saved_role_key(client, monkeypatch):
    audio = wav_audio()
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        assert request.headers['Authorization'] == 'Bearer fixture-private-key'
        return httpx.Response(200, json={'base_resp': {'status_code': 0}, 'data': {'audio': audio.hex()}})
    mock_remote(monkeypatch, handler)
    providers = client.get('/api/settings').json()['providers']
    providers['tts'] = minimax_settings().model_dump()
    providers['tts']['autoplay'] = False
    saved = client.put('/api/settings/providers', json=providers)
    assert saved.status_code == 200
    settings = saved.json()['tts']
    assert settings['apiKey'] == '' and settings['hasApiKey'] is True
    for route, body in [('/api/providers/tts/test', settings), ('/api/tts/synthesize', {'text': '手动朗读'})]:
        response = client.post(route, json=body)
        assert response.status_code == 200
        assert (api.RUNTIME_DIR / Path(response.json()['audio_url']).name).read_bytes() == audio
    assert len(calls) == 2
    assert calls[-1]['text'] == '手动朗读'
    assert 'fixture-private-key' not in client.get('/api/export').text
