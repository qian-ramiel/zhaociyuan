from server.app import api, database
from server.tests.test_v1 import client, empty_client, configure_model, screen_context


def test_master_switches_defaults_persist_and_do_not_change_role(client):
    state = client.get('/api/bootstrap').json()
    desktop = state['desktop']
    assert all(desktop[key] for key in ('visionEnabled', 'hearingEnabled', 'speechEnabled'))
    desktop.update(visionEnabled=False, hearingEnabled=False, speechEnabled=False)
    assert client.put('/api/desktop', json=desktop).status_code == 200
    other = client.post('/api/roles', json={'name': '新角色'}).json()['id']
    client.post('/api/roles/' + other + '/activate')
    assert client.get('/api/bootstrap').json()['desktop'] == desktop
    database.initialize()
    assert client.get('/api/desktop').json() == desktop


def test_master_switches_block_capture_tts_and_asr_before_any_service_call(client, monkeypatch):
    configure_model(client)
    state = client.get('/api/settings').json()['companion']
    state['screen']['enabled'] = True
    client.put('/api/settings/companion', json=state)
    prefs = client.get('/api/desktop').json()
    prefs.update(visionEnabled=False, hearingEnabled=False, speechEnabled=False)
    client.put('/api/desktop', json=prefs)
    def unexpected(*args, **kwargs):
        raise AssertionError('Disabled service must not be called')
    monkeypatch.setattr(api.speech, 'synthesize_local', unexpected)
    monkeypatch.setattr(api.speech, 'transcribe_local', unexpected)
    assert client.post('/api/chat', json={'content': '看看', 'screen': screen_context()}).status_code == 409
    assert client.post('/api/tts/synthesize', json={'text': '你好'}).status_code == 409
    assert client.post('/api/providers/tts/test', json=client.get('/api/settings').json()['providers']['tts']).status_code == 409
    assert client.post('/api/asr/transcribe', files={'file': ('voice.wav', b'fake', 'audio/wav')}).status_code == 409


def test_manual_tts_is_independent_of_autoplay(client, monkeypatch):
    providers = client.get('/api/settings').json()['providers']
    providers['tts']['autoplay'] = False
    client.put('/api/settings/providers', json=providers)
    calls = []
    monkeypatch.setattr(api.speech, 'synthesize_local', lambda text, settings, target: calls.append(text))
    assert client.post('/api/tts/synthesize', json={'text': '主动朗读'}).status_code == 200
    assert calls == ['主动朗读']


def test_clear_history_only_affects_current_role(client):
    # Disposable isolated test data; never user's conversations.
    now = database.utc_now()
    first = database.active_role()
    second = client.post('/api/roles', json={'name': '二'}).json()['id']
    with database.connect() as db:
        for role in (first, second):
            db.execute('INSERT INTO chat_messages(role,content,created_at,character_id) VALUES(?,?,?,?)', ('user', role, now, role))
    client.post('/api/memories', json={'category': 'profile', 'content': '保留的记忆'})
    assert client.delete('/api/chat/history').status_code == 200
    assert client.get('/api/chat/history').json() == []
    assert len(client.get('/api/memories').json()) == 1
    client.post('/api/roles/' + second + '/activate')
    assert len(client.get('/api/chat/history').json()) == 1


def test_desktop_display_defaults_validation_and_restart_persistence(client):
    prefs = client.get('/api/desktop').json()
    assert prefs['characterScale'] == 1
    assert prefs['bubbleAutoHide'] == 8
    assert prefs['bubbleHeight'] == 72
    assert prefs['showBubble'] is True
    prefs.update(characterScale=1.35, bubbleWidth=75, bubbleHeight=152, bubbleFontSize=17, bubbleAutoHide=0, showBubble=False, pushToTalk=False)
    assert client.put('/api/desktop', json=prefs).status_code == 200
    database.initialize()
    assert client.get('/api/desktop').json() == prefs
    for patch in ({'characterScale': 0.6}, {'characterScale': 1.7}, {'bubbleWidth': 101}, {'bubbleHeight': 55}, {'bubbleHeight': 281}, {'bubbleFontSize': 10}, {'bubbleAutoHide': -1}, {'bubbleAutoHide': 121}):
        assert client.put('/api/desktop', json={**prefs, **patch}).status_code == 422
    assert client.get('/api/desktop').json() == prefs


def test_early_chat_cancel_prevents_late_post_and_history(client, monkeypatch):
    from server.app import api
    import uuid
    request_id = uuid.uuid4().hex
    before = client.get('/api/chat/history').json()
    async def forbidden(*args):
        raise AssertionError('cancelled request must not reach model')
    monkeypatch.setattr(api, 'generate', forbidden)
    assert client.post('/api/chat/' + request_id + '/cancel').status_code == 200
    assert client.post('/api/chat', json={'content': '旧语音', 'requestId': request_id}).status_code == 499
    assert client.get('/api/chat/history').json() == before


def test_screen_quality_is_role_owned_and_validated(client):
    companion = client.get('/api/settings').json()['companion']
    assert companion['screen']['quality'] == 'high'
    companion['screen']['quality'] = 'standard'
    assert client.put('/api/settings/companion', json=companion).status_code == 200
    database.initialize()
    assert client.get('/api/settings').json()['companion']['screen']['quality'] == 'standard'
    other = client.post('/api/roles', json={'name': '高清默认角色'}).json()['id']
    client.post('/api/roles/' + other + '/activate')
    assert client.get('/api/settings').json()['companion']['screen']['quality'] == 'high'
    companion = client.get('/api/settings').json()['companion']
    companion['screen']['quality'] = 'unknown'
    assert client.put('/api/settings/companion', json=companion).status_code == 422
