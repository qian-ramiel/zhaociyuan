import asyncio
import json
import sqlite3
from datetime import datetime, timezone, timedelta

import httpx
import pytest
from fastapi import HTTPException

from server.app import api, companion, database, llm, retry, roles, speech
from server.app.models import CompanionReply, CompanionSettings
from server.tests.test_v1 import client, empty_client, configure_model, screen_context


def mode_update(client, **changes):
    values = client.get('/api/modes').json()
    values[0].update(changes)
    assert client.put('/api/modes', json=values).status_code == 200
    return values[0]


def enable_automatic(client):
    mode_update(client, screenAllowed=True, proactive=True, quietStart='00:00', quietEnd='00:00', cooldown=10,
                observation={'periodic': True, 'onChange': True, 'interval': 5, 'changeThreshold': .12})
    state = client.get('/api/settings').json()['companion']
    state['screen'].update(enabled=True, sourceId='screen:1:0', sourceName='fixture')
    assert client.put('/api/settings/companion', json=state).status_code == 200


def test_new_role_and_mode_inherit_reply_length_and_legacy_runtime_patch_updates_mode(empty_client):
    empty_client.post('/api/roles', json={'name': '新角色'})
    mode = empty_client.get('/api/modes').json()[0]
    assert mode['replyLength'] == 'inherit'
    assert mode['observation']['periodic'] is False
    assert empty_client.patch('/api/modes/daily/proactive', json={'enabled': True}).status_code == 200
    assert empty_client.get('/api/settings').json()['companion']['proactive'] is True
    state = empty_client.get('/api/settings').json()['companion']
    empty_client.put('/api/settings/companion', json={**state, 'proactive': False})
    assert empty_client.get('/api/modes').json()[0]['proactive'] is False


def test_edit_other_mode_does_not_activate_and_current_proactive_survives_switch(client):
    mode_update(client, proactive=True)
    values = client.get('/api/modes').json()
    values[1]['proactive'] = False
    client.put('/api/modes', json=values)
    state = client.get('/api/settings').json()['companion']
    assert state['mode'] == 'daily' and state['proactive'] is True
    client.put('/api/settings/companion', json={**state, 'mode': 'work'})
    assert client.get('/api/settings').json()['companion']['proactive'] is False
    state = client.get('/api/settings').json()['companion']
    client.put('/api/settings/companion', json={**state, 'mode': 'daily'})
    assert client.get('/api/settings').json()['companion']['proactive'] is True


def test_role_default_and_explicit_mode_override_resolve_one_reply_length(client, monkeypatch):
    configure_model(client)
    identity = client.get('/api/settings').json()['persona']
    client.put('/api/settings/persona', json={**identity, 'replyLength': 'long'})
    seen = []
    async def complete(settings, persona, *args, **kwargs):
        seen.append((persona.replyLength, kwargs['extra_prompt']))
        return CompanionReply(text='回复', speech='回复')
    monkeypatch.setattr(llm, 'complete', complete)
    mode_update(client, replyLength='inherit')
    assert client.post('/api/chat', json={'content': '继承'}).status_code == 200
    mode_update(client, replyLength='short')
    assert client.post('/api/chat', json={'content': '覆盖'}).status_code == 200
    assert [item[0] for item in seen] == ['long', 'short']
    assert all('回复长度' not in item[1] for item in seen)
    assert client.get('/api/settings').json()['persona']['replyLength'] == 'long'


def test_legacy_schedule_migration_is_backed_up_idempotent_and_role_scoped(client):
    first = database.active_role()
    second = client.post('/api/roles', json={'name': '另一个'}).json()['id']
    for role_id, interval in [(first, 11), (second, 47)]:
        token = database.request_role.set(role_id)
        try:
            state = CompanionSettings(characterId=role_id, proactive=True, cooldown=99)
            state.screen.interval = interval
            state.screen.periodic = True
            database.set_setting('companion', state.model_dump())
            database.set_setting('modes', [{'id': 'daily', 'name': '原模式', 'proactive': False}])
        finally:
            database.request_role.reset(token)
    database.set_setting('mode_observation_v3', False)
    backup = database.DATA_DIR / 'before-mode-observation-v3.db'
    # Empty-install backup was created by the fixture's initial lifespan.
    backup.unlink(missing_ok=True)
    roles.migrate_modes()
    assert backup.is_file()
    with sqlite3.connect(backup) as db:
        original = json.loads(db.execute('SELECT value FROM settings WHERE key=?', ('role:' + first + ':modes',)).fetchone()[0])
        assert 'observation' not in original[0]
    for role_id, interval in [(first, 11), (second, 47)]:
        token = database.request_role.set(role_id)
        try:
            mode = roles.modes()[0]
            assert mode['replyLength'] == 'medium'
            assert mode['observation']['interval'] == interval
            assert mode['observation']['periodic'] is True
            assert mode['proactive'] is True and mode['cooldown'] == 99
        finally:
            database.request_role.reset(token)
    mode_update(client, observation={'periodic': False, 'interval': 60})
    roles.migrate_modes()
    assert roles.modes()[0]['observation']['periodic'] is False


def test_automatic_observation_gates_apply_before_capture_and_no_screenless_schedule(client, monkeypatch):
    enable_automatic(client)
    assert client.get('/api/observe/status').json()['allowed'] is True
    client.patch('/api/modes/daily/proactive', json={'enabled': False})
    assert client.get('/api/observe/status').json()['reason'] == '当前模式主动发言已关闭'
    client.patch('/api/modes/daily/proactive', json={'enabled': True})
    mode_update(client, observation={'periodic': False, 'onChange': False})
    assert client.get('/api/observe/status').json()['reason'] == '未设置自动观察触发'
    mode_update(client, observation={'periodic': True})
    state = client.get('/api/settings').json()['companion']
    client.put('/api/settings/companion', json={**state, 'focus': True})
    assert client.get('/api/observe/status').json()['reason'] == '专注中'
    client.put('/api/settings/companion', json=state)
    companion.log('observe_request', 'fixture')
    assert client.get('/api/observe/status').json()['reason'] == '发言冷却中'
    with database.connect() as db:
        db.execute('UPDATE events SET created_at=?', ((datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat(),))
    mode_update(client, hourlyLimit=1)
    assert client.get('/api/observe/status').json()['reason'] == '本小时主动次数达到上限'
    with database.connect() as db:
        db.execute('DELETE FROM events')
    mode_update(client, observation={'periodic': True, 'onChange': False})
    response = client.post('/api/observe', json={'screen': screen_context(), 'trigger': 'change'}).json()
    assert response['shouldSpeak'] is False and '未启用' in response['reason']


def test_automatic_reply_is_discarded_if_proactive_is_disabled_during_generation(client, monkeypatch):
    enable_automatic(client)
    configure_model(client)
    async def complete(*args, **kwargs):
        values = roles.modes()
        values[0]['proactive'] = False
        database.set_setting('modes', values)
        return CompanionReply(text='迟到的自动发言', speech='')
    monkeypatch.setattr(llm, 'complete', complete)
    result = client.post('/api/observe', json={'screen': screen_context(), 'trigger': 'periodic'}).json()
    assert result['shouldSpeak'] is False
    assert client.get('/api/chat/history').json() == []


def test_import_old_schedule_preserves_active_toggle_but_revokes_source_access(client):
    value = client.get('/api/export').json()
    value['settings']['companion'].update(proactive=True, cooldown=71)
    value['settings']['companion']['screen'].update(periodic=True, interval=37)
    for mode in value['modes']:
        mode.pop('observation', None)
        mode['proactive'] = False
    assert client.post('/api/import', json=value).status_code == 200
    current = client.get('/api/bootstrap').json()
    assert current['modes'][0]['proactive'] is True
    assert current['modes'][0]['cooldown'] == 71
    assert current['modes'][0]['observation']['interval'] == 37
    assert current['settings']['companion']['screen']['enabled'] is False
    assert current['settings']['companion']['screen']['sourceId'] == ''


def test_asr_error_logs_reason_and_validation_logs_never_include_payload(client, monkeypatch):
    def fail(*args):
        raise HTTPException(503, '本地 ASR 模型尚未安装')
    monkeypatch.setattr(speech, 'transcribe_local', fail)
    assert client.post('/api/asr/transcribe', files={'file': ('voice.wav', b'fixture')}).status_code == 503
    assert any('模型尚未安装' in item['detail'] for item in client.get('/api/events').json())
    assert client.post('/api/tts/synthesize', json={'text': ['private-spoken-content']}).status_code == 422
    assert 'private-spoken-content' not in client.get('/api/events').text


def test_transient_llm_retries_before_output_and_persists_once(client, monkeypatch):
    configure_model(client)
    calls = []
    async def complete(*args, **kwargs):
        calls.append(1)
        if len(calls) < 3:
            raise httpx.ReadTimeout('fixture')
        await kwargs['on_text']('恢复。')
        return CompanionReply(text='恢复。', speech='恢复。')
    monkeypatch.setattr(llm, 'complete', complete)
    response = client.post('/api/chat/stream', json={'content': '语音请求', 'requestId': 'retry-voice', 'source': 'voice'})
    frames = [json.loads(line) for line in response.text.splitlines()]
    assert [item['type'] for item in frames] == ['text', 'done'] and len(calls) == 3
    assert len(client.get('/api/chat/history').json()) == 2
    records = client.get('/api/events').json()
    assert len([item for item in records if item['result'] == 'retry']) == 2
    assert any('重试后恢复' in item['detail'] for item in records)


def test_llm_partial_output_never_replays_and_error_is_logged_despite_http_200(client, monkeypatch):
    configure_model(client)
    calls = []
    async def complete(*args, **kwargs):
        calls.append(1)
        await kwargs['on_text']('已经说了。')
        raise httpx.ReadError('fixture')
    monkeypatch.setattr(llm, 'complete', complete)
    response = client.post('/api/chat/stream', json={'content': '测试', 'requestId': 'no-replay'})
    assert response.status_code == 200 and len(calls) == 1
    assert json.loads(response.text.splitlines()[-1])['type'] == 'error'
    assert any(item['result'] == 'error' and '已开始输出' in item['detail'] for item in client.get('/api/events').json())


@pytest.mark.parametrize('status, attempts', [(401, 1), (404, 1), (429, 3), (503, 3)])
def test_retry_classification_uses_provider_status_not_wrapped_502(client, status, attempts):
    count = []
    async def operation():
        count.append(1)
        request = httpx.Request('POST', 'https://fixture?secret=private')
        try:
            httpx.Response(status, request=request).raise_for_status()
        except httpx.HTTPStatusError as error:
            raise HTTPException(502, '上游 HTTP ' + str(status)) from error
    with pytest.raises(HTTPException):
        asyncio.run(retry.retry_call(operation, 'TTS', 'classification'))
    assert len(count) == attempts
    assert 'private' not in client.get('/api/events').text


def test_tts_retry_before_first_audio_but_not_after_playback_has_started(client, monkeypatch):
    providers = client.get('/api/settings').json()['providers']
    providers['tts'].update(provider='openai', baseUrl='https://fixture/v1', streaming=True)
    client.put('/api/settings/providers', json=providers)
    calls = []
    async def stream(*args):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError('fixture')
        yield b'mp3-first'
        raise httpx.ReadError('fixture')
    monkeypatch.setattr(speech, 'stream_remote', stream)
    response = client.post('/api/tts/stream', json={'text': '一句话', 'requestId': 'speech-retry-1'})
    frames = [json.loads(line) for line in response.text.splitlines()]
    assert len(calls) == 2 and [item['type'] for item in frames] == ['audio', 'error']
    records = client.get('/api/events').json()
    assert any(item['result'] == 'retry' for item in records)
    assert any(item['result'] == 'error' and 'speech-retry-1' in item['detail'] for item in records)


def test_cancellation_during_backoff_does_not_retry(client):
    calls = []
    async def run():
        async def operation():
            calls.append(1)
            raise httpx.ReadTimeout('fixture')
        task = asyncio.create_task(retry.retry_call(operation, '对话模型', 'cancel-retry'))
        await asyncio.sleep(.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(run())
    assert len(calls) == 1
    assert any(item['result'] == 'cancelled' for item in client.get('/api/events').json())


def test_client_playback_errors_are_allowlisted_and_role_scoped(client):
    first = database.active_role()
    assert client.post('/api/runtime/issues', json={'code': 'playback', 'requestId': 'playback-1', 'roleId': first}).status_code == 200
    assert any(item['service'] == '音频播放' and item['result'] == 'error' for item in client.get('/api/events').json())
    assert client.post('/api/runtime/issues', json={'code': 'secret arbitrary content', 'requestId': 'bad', 'roleId': first}).status_code == 422
    second = client.post('/api/roles', json={'name': '新角色'}).json()['id']
    client.post('/api/roles/' + second + '/activate')
    assert client.post('/api/runtime/issues', json={'code': 'playback', 'requestId': 'playback-late', 'roleId': first}).status_code == 409
    assert client.get('/api/events').json() == []
