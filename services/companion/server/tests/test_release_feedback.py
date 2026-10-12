import asyncio
import json

import httpx
import pytest

from fastapi import HTTPException
from server.app import api, companion, llm, retry, speech
from server.app.models import CompanionReply
from server.tests.test_v1 import client, empty_client, configure_model
from server.tests.test_voice_stream import TextStream, delta, transport


@pytest.fixture
def no_backoff(monkeypatch):
    original = asyncio.sleep
    async def yield_once(_):
        await original(0)
    monkeypatch.setattr(retry.asyncio, 'sleep', yield_once)


def success_response():
    return httpx.Response(200, json={'choices': [{'message': {'content': '{"text":"恢复。","speech":""}'}}]})


@pytest.mark.parametrize('status', [200, 400, 409, 422, 503])
def test_model_startup_failure_retries_before_output_with_safe_context(client, monkeypatch, no_backoff, status):
    configure_model(client)
    calls = []
    def handler(request):
        calls.append(request)
        if len(calls) < 3:
            return httpx.Response(status, json={'error': {'code': 'model_loading', 'message': '模型启动失败 private-chat sk-private-value https://private?token=private'}})
        return success_response()
    transport(monkeypatch, handler)
    result = client.post('/api/chat/stream', json={'content': 'private-chat', 'requestId': 'startup-test'})
    assert [json.loads(line)['type'] for line in result.text.splitlines()] == ['text', 'done']
    assert len(calls) == 3 and len(client.get('/api/chat/history').json()) == 2
    records = client.get('/api/events').json()
    assert len([item for item in records if item['result'] == 'retry']) == 2
    detail = json.dumps(records, ensure_ascii=False)
    assert 'model_loading' in detail and '对话生成' in detail and 'test-model' in detail and 'model.invalid' in detail
    assert 'private-chat' not in detail and 'sk-private-value' not in detail and 'token=private' not in detail


@pytest.mark.parametrize('after_text', [False, True])
def test_sse_model_startup_failure_is_retried_only_before_first_text(client, monkeypatch, no_backoff, after_text):
    configure_model(client)
    calls = []
    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            frames = [delta('{"text":"已经说了。')] if after_text else []
            frames.append('data: ' + json.dumps({'error': {'code': 'model_load_failed', 'message': 'Failed to load model'}}) + '\n\n')
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=TextStream(frames))
        return success_response()
    transport(monkeypatch, handler)
    response = client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'sse-startup'})
    frames = [json.loads(line) for line in response.text.splitlines()]
    assert len(calls) == (1 if after_text else 2)
    assert frames[-1]['type'] == ('error' if after_text else 'done')
    assert len(client.get('/api/chat/history').json()) == (0 if after_text else 2)
    errors = [item for item in client.get('/api/events').json() if item['result'] == 'error']
    assert len(errors) == int(after_text)


@pytest.mark.parametrize('status, code, message', [
    (401, 'model_loading', '模型加载中'), (404, 'model_loading', '模型加载中'),
    (400, 'model_not_found', 'Failed to load model: model not found'),
    (503, 'out_of_memory', 'Failed to load model: out of memory'),
    (429, 'insufficient_quota', 'Insufficient quota'),
    (400, 'invalid_api_key', 'private credential'),
    (400, 'invalid_model', 'Invalid model'),
])
def test_permanent_provider_errors_do_not_retry_or_leak_body(client, monkeypatch, no_backoff, status, code, message):
    configure_model(client)
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={'error': {'code': code, 'message': message, 'request': 'private-body'}})
    transport(monkeypatch, handler)
    response = client.post('/api/chat/stream', json={'content': 'private-chat', 'requestId': 'permanent-test'})
    assert json.loads(response.text.splitlines()[-1])['type'] == 'error' and len(calls) == 1
    assert 'private-body' not in client.get('/api/events').text
    assert 'private credential' not in client.get('/api/events').text
    assert not any(item['result'] == 'retry' for item in client.get('/api/events').json())


def test_stream_preflight_failures_have_request_id_http_status_and_no_payload(client):
    for route, body, status in [
        ('/api/chat/stream', {'content': ['private-payload']}, 422),
        ('/api/chat/stream', {'content': '   '}, 400),
        ('/api/tts/stream', {'text': ['private-payload']}, 422),
    ]:
        assert client.post(route, json=body, headers={'X-Request-ID': 'preflight-test'}).status_code == status
    desktop = client.get('/api/desktop').json()
    client.put('/api/desktop', json={**desktop, 'speechEnabled': False})
    assert client.post('/api/tts/stream', json={'text': 'private-payload', 'requestId': 'tts-preflight'}).status_code == 409
    records = client.get('/api/events').json()
    assert len([item for item in records if 'preflight-test' in item['detail']]) == 3
    assert any('tts-preflight' in item['detail'] and 'HTTP 409' in item['detail'] for item in records)
    assert 'private-payload' not in client.get('/api/events').text
    assert all(item['result'] == 'error' for item in records)


def test_stream_duplicate_and_early_cancel_are_logged_before_generation(client):
    api.tasks['duplicate-test'] = object()
    try:
        response = client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'duplicate-test'})
        assert response.status_code == 409
    finally:
        api.tasks.clear()
    client.post('/api/chat/early-test/cancel')
    response = client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'early-test'})
    assert response.status_code == 499
    records = client.get('/api/events').json()
    assert any('duplicate-test' in item['detail'] and item['result'] == 'error' for item in records)
    assert any('early-test' in item['detail'] and item['result'] == 'cancelled' for item in records)


def test_post_generation_persistence_failure_is_logged_not_retried(client, monkeypatch):
    configure_model(client)
    calls = []
    async def complete(*args, **kwargs):
        calls.append(1)
        await kwargs['on_text']('完成。')
        return CompanionReply(text='完成。', speech='')
    def persist(*args):
        raise RuntimeError('private-chat private-credential')
    monkeypatch.setattr(llm, 'complete', complete)
    monkeypatch.setattr(api, 'persist', persist)
    response = client.post('/api/chat/stream', json={'content': 'private-chat', 'requestId': 'save-test'})
    assert [json.loads(line)['type'] for line in response.text.splitlines()] == ['text', 'error']
    assert len(calls) == 1 and client.get('/api/chat/history').json() == []
    records = client.get('/api/events').json()
    assert len(records) == 1 and records[0]['result'] == 'error'
    assert '保存回复' in records[0]['detail'] and 'RuntimeError' in records[0]['detail']
    assert 'private-chat' not in client.get('/api/events').text


def test_cancellation_while_waiting_for_lock_is_recorded(client, monkeypatch):
    class CancelledLock:
        async def __aenter__(self):
            raise asyncio.CancelledError()
        async def __aexit__(self, *args):
            pass
    api.locks[companion.settings().characterId] = CancelledLock()
    result = client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'waiting-test'})
    assert json.loads(result.text)['type'] == 'cancelled'
    records = client.get('/api/events').json()
    assert len(records) == 1 and records[0]['result'] == 'cancelled' and '等待对话' in records[0]['detail']


def test_client_diagnostics_are_allowlisted_and_keep_duration(client):
    role_id = client.get('/api/bootstrap').json()['activeRoleId']
    response = client.post('/api/runtime/issues', json={'code': 'client-stream', 'requestId': 'client-test', 'roleId': role_id,
                                                     'phase': 'request', 'errorType': 'timeout', 'durationMs': 1234})
    assert response.status_code == 200
    record = client.get('/api/events').json()[0]
    assert record['duration_ms'] == 1234 and '发起请求' in record['detail'] and '超时' in record['detail']
    assert client.post('/api/runtime/issues', json={'code': 'client-stream', 'requestId': 'invalid-test', 'roleId': role_id,
                                                   'errorType': 'private-message'}).status_code == 422
    assert 'private-message' not in client.get('/api/events').text


def test_local_tts_stream_failure_keeps_sentence_request_id(client, monkeypatch):
    def fail(*args):
        raise HTTPException(503, '本地 TTS 模型尚未安装')
    monkeypatch.setattr(speech, 'synthesize_local', fail)
    response = client.post('/api/tts/stream', json={'text': '测试。', 'requestId': 'chat-id-speech-2'})
    assert json.loads(response.text.splitlines()[-1])['type'] == 'error'
    errors = [item for item in client.get('/api/events').json() if item['result'] == 'error']
    assert len(errors) == 1 and 'chat-id-speech-2' in errors[0]['detail']
