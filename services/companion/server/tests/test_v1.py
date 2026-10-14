import io
import zipfile
from datetime import datetime, timezone, timedelta

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.app import api, builtin_characters, characters, companion, database, knowledge, llm, secrets
from server.app.models import CompanionReply


@pytest.fixture
def empty_client(tmp_path, monkeypatch):
    assets = tmp_path / 'characters'
    assets.mkdir()
    runtime = tmp_path / 'media'
    runtime.mkdir()
    monkeypatch.setattr(database, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(database, 'DB_PATH', tmp_path / 'data/companion.db')
    monkeypatch.setattr(characters, 'CHARACTERS_DIR', assets)
    monkeypatch.setattr(companion, 'CHARACTERS_DIR', assets)
    monkeypatch.setattr(api, 'CHARACTERS_DIR', assets)
    monkeypatch.setattr(api, 'RUNTIME_DIR', runtime)
    monkeypatch.setattr(knowledge, 'KNOWLEDGE_DIR', tmp_path / 'knowledge')
    monkeypatch.setattr(companion, 'seed_legacy_assets', lambda: None)
    monkeypatch.setattr(builtin_characters, 'BUNDLED_DIR', tmp_path / 'no-bundled-characters')
    monkeypatch.setattr(api, 'API_TOKEN', '')
    stored = {}
    monkeypatch.setattr(secrets, 'get_secret', lambda key: stored.get(key, ''))
    monkeypatch.setattr(secrets, 'set_secret', lambda key, value: stored.update({key: value}))
    api.locks.clear()
    api.tasks.clear()
    with TestClient(api.app) as client:
        yield client


@pytest.fixture
def client(empty_client):
    from server.app import roles
    empty_client.post('/api/roles', json={'name': '测试角色'})
    modes = [{**mode, 'screenAllowed': True} for mode in roles.MODE_TEMPLATES]
    empty_client.put('/api/modes', json=modes)
    return empty_client


def create_appearance(client, name='全身', framing='full'):
    image = io.BytesIO()
    Image.new('RGBA', (32, 48), (30, 180, 160, 255)).save(image, format='PNG')
    resource = client.post('/api/characters/import', files={'file': ('portrait.png', image.getvalue(), 'image/png')}).json()
    response = client.post('/api/appearances', json={'name': name, 'assetId': resource['id'], 'framing': framing, 'aliases': [name + '形象']})
    assert response.status_code == 200
    return response.json()


def configure_model(client):
    value = client.get('/api/settings').json()['providers']
    value['llm'].update({'baseUrl': 'http://model.invalid/v1', 'model': 'test-model'})
    assert client.put('/api/settings/providers', json=value).status_code == 200


def screen_context():
    image = io.BytesIO()
    Image.new('RGB', (8, 8), (70, 160, 190)).save(image, format='PNG')
    import base64
    return {'imageData': 'data:image/png;base64,' + base64.b64encode(image.getvalue()).decode(), 'sourceName': '游戏测试窗口', 'capturedAt': datetime.now(timezone.utc).isoformat()}


def test_bootstrap_requires_real_model_and_never_returns_keys(client):
    result = client.get('/api/bootstrap').json()
    assert result['health']['version'] == '1.0.0'
    assert result['health']['modelConfigured'] is False
    assert client.post('/api/chat', json={'content': '你好'}).status_code == 400
    assert client.get('/api/chat/history').json() == []
    service = result['settings']['providers']
    service['llm']['apiKey'] = 'private-key-value'
    saved = client.put('/api/settings/providers', json=service).json()
    assert saved['llm']['apiKey'] == '' and saved['llm']['hasApiKey'] is True
    assert 'private-key-value' not in client.get('/api/export').text
    client.put('/api/settings/providers', json=saved)
    assert api.providers().llm.apiKey == 'private-key-value'
    client.delete('/api/providers/llm/key')
    assert api.providers().llm.apiKey == ''


def test_voice_style_appearance_switch_preserves_memory_and_history(client):
    full = create_appearance(client)
    mini = create_appearance(client, 'mini', 'mini')
    client.post('/api/memories', json={'category': 'project', 'content': '正在设计一个游戏'})
    response = client.post('/api/chat', json={'content': '换成 mini 形象，别挡住游戏', 'source': 'voice'})
    assert response.status_code == 200
    assert response.json()['reply']['switchAppearance'] == mini['id']
    assert client.get('/api/settings').json()['companion']['activeAppearanceId'] == mini['id']
    assert len(client.get('/api/chat/history').json()) == 2
    assert client.get('/api/memories').json()[0]['content'] == '正在设计一个游戏'
    response = client.post('/api/chat', json={'content': '换成全身形象'})
    assert response.json()['reply']['switchAppearance'] == full['id']
    assert len(client.get('/api/chat/history').json()) == 4


def test_negative_appearance_instruction_does_not_switch(client):
    full = create_appearance(client)
    create_appearance(client, 'mini', 'mini')
    assert companion.explicit_switch('不要换成mini') is None
    assert companion.settings().activeAppearanceId == full['id']

    assert client.post('/api/appearances/not-present/activate').status_code == 404
    assert companion.settings().activeAppearanceId == full['id']


def test_restore_previous_appearance_without_model(client):
    full = create_appearance(client)
    mini = create_appearance(client, 'mini', 'mini')
    client.post('/api/chat', json={'content': '换成mini形象'})
    response = client.post('/api/chat', json={'content': '恢复刚才的形象'})
    assert response.json()['reply']['switchAppearance'] == full['id']
    assert companion.settings().previousAppearanceId == mini['id']


def test_manual_appearance_has_priority_over_unsolicited_ai(client, monkeypatch):
    full = create_appearance(client)
    mini = create_appearance(client, 'mini', 'mini')
    state = client.get('/api/settings').json()['companion']
    state['allowAutoAppearance'] = True
    client.put('/api/settings/companion', json=state)
    client.post('/api/appearances/' + mini['id'] + '/activate')
    configure_model(client)
    async def response(*args, **kwargs):
        return CompanionReply(text='继续聊天', speech='继续聊天', switchAppearance=full['id'])
    monkeypatch.setattr(llm, 'complete', response)
    result = client.post('/api/chat', json={'content': '今天做什么'}).json()
    assert result['reply']['switchAppearance'] is None
    assert companion.settings().activeAppearanceId == mini['id']


def test_message_screen_is_bound_to_this_question_and_not_stored(client, monkeypatch):
    create_appearance(client)
    configure_model(client)
    state = client.get('/api/settings').json()['companion']
    state['screen']['enabled'] = True
    client.put('/api/settings/companion', json=state)
    calls = []
    async def fake(settings, persona, history, memories, knowledge, actions, **kwargs):
        calls.append((history[-1]['content'], kwargs['screen']))
        return CompanionReply(text='先躲开左侧攻击。', speech='先躲开左侧攻击。', emotion='neutral')
    monkeypatch.setattr(llm, 'complete', fake)
    picture = screen_context()
    result = client.post('/api/chat', json={'content': '现在应该怎么打？', 'screen': picture, 'source': 'voice'}).json()
    assert calls[0] == ('现在应该怎么打？', picture)
    assert result['user_message']['screen_context']['sourceName'] == '游戏测试窗口'
    assert picture['imageData'] not in client.get('/api/chat/history').text
    assert len(list(api.RUNTIME_DIR.iterdir())) == 0


def test_pause_blocks_message_screens_but_not_text(client, monkeypatch):
    configure_model(client)
    state = client.get('/api/settings').json()['companion']
    state['screen'].update({'enabled': True, 'paused': True})
    client.put('/api/settings/companion', json=state)
    async def fake(*args, **kwargs): return CompanionReply(text='文字回复', speech='文字回复')
    monkeypatch.setattr(llm, 'complete', fake)
    assert client.post('/api/chat', json={'content': '看看画面', 'screen': screen_context()}).status_code == 409
    assert client.post('/api/chat', json={'content': '正常聊天'}).status_code == 200


def test_old_screen_rejected(client):
    state = client.get('/api/settings').json()['companion']
    state['screen']['enabled'] = True
    client.put('/api/settings/companion', json=state)
    picture = screen_context()
    picture['capturedAt'] = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    assert client.post('/api/chat', json={'content': '看看', 'screen': picture}).status_code == 400


def test_memory_candidates_require_confirmation_and_are_isolated(client, monkeypatch):
    configure_model(client)
    async def fake(*args, **kwargs): return CompanionReply(text='我记下了。', speech='我记下了。', memoryCandidates=['用户喜欢热可可'])
    monkeypatch.setattr(llm, 'complete', fake)
    client.post('/api/chat', json={'content': '我喜欢热可可'})
    client.post('/api/chat', json={'content': '记住了吗？'})
    items = client.get('/api/memories').json()
    assert len(items) == 1 and items[0]['enabled'] is False
    assert items[0]['character_id'] == database.active_role()
    client.patch('/api/memories/' + items[0]['id'], json={'enabled': True, 'content': '喜欢无糖热可可'})
    assert client.get('/api/memories').json()[0]['content'] == '喜欢无糖热可可'


def test_mode_mapping_does_not_override_explicit_switch_until_next_mode(client):
    full = create_appearance(client)
    mini = create_appearance(client, 'mini', 'mini')
    state = client.get('/api/settings').json()['companion']
    state.update({'mode': 'game', 'allowAutoAppearance': True, 'modeAppearances': {'game': mini['id']}})
    client.put('/api/settings/companion', json=state)
    assert companion.settings().activeAppearanceId == mini['id']
    client.post('/api/chat', json={'content': '换成全身形象'})
    state = client.get('/api/settings').json()['companion']
    state['focus'] = True
    client.put('/api/settings/companion', json=state)
    assert companion.settings().activeAppearanceId == full['id']


def test_workflow_prompt_has_mode_keyword_and_enable_filters(client):
    flows = [{'id': 'a', 'name': '任务拆解', 'trigger': 'message', 'mode': 'work', 'enabled': True, 'keyword': '任务', 'prompt': '先列三个步骤'}]
    assert client.put('/api/workflows', json=flows).status_code == 200
    state = client.get('/api/settings').json()['companion']
    state['mode'] = 'work'
    client.put('/api/settings/companion', json=state)
    assert companion.workflow_prompt('message', '这个任务怎么做') == '先列三个步骤'
    assert companion.workflow_prompt('message', '你好') == ''
    assert companion.workflow_prompt('periodic', '任务') == ''


def test_import_resets_screen_permissions_and_rejects_invalid_without_change(client):
    exported = client.get('/api/export').json()
    exported['settings']['companion']['screen'].update({'enabled': True, 'sourceId': 'screen:0:0'})
    assert client.post('/api/import', json=exported).status_code == 200
    assert companion.settings().screen.enabled is False
    assert companion.settings().screen.sourceId == ''
    exported['settings']['persona']['replyLength'] = 'invalid'
    before = client.get('/api/settings').json()
    assert client.post('/api/import', json=exported).status_code == 400
    assert client.get('/api/settings').json() == before


def test_zip_traversal_and_fake_image_are_rejected(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zipped: zipped.writestr('../escape.model3.json', '{}')
    assert client.post('/api/characters/import', files={'file': ('unsafe.zip', buf.getvalue(), 'application/zip')}).status_code == 400
    assert client.post('/api/characters/import', files={'file': ('fake.png', b'not an image', 'image/png')}).status_code == 400


def test_local_api_authentication(client, monkeypatch):
    monkeypatch.setattr(api, 'API_TOKEN', 'test-session-token')
    assert client.get('/api/health').status_code == 200
    assert client.get('/api/bootstrap').status_code == 401
    assert client.get('/api/bootstrap', headers={'Authorization': 'Bearer test-session-token'}).status_code == 200


def test_backup_restores_available_appearances_and_deduplicates_memories(client):
    create_appearance(client)
    memory = client.post('/api/memories', json={'category': 'project', 'content': '备份项目'}).json()
    backup = client.get('/api/export').json()
    backup['appearances'][0]['name'] = '恢复的全身'
    client.delete('/api/memories/' + memory['id'])
    restored = client.post('/api/import', json=backup).json()
    assert restored['importedMemories'] == 1
    assert restored['restoredAppearances'] == 1
    assert client.get('/api/appearances').json()[0]['name'] == '恢复的全身'
    assert client.post('/api/import', json=backup).json()['importedMemories'] == 0
    assert len(client.get('/api/memories').json()) == 1


def test_knowledge_import_and_retrieval(client):
    result = client.post('/api/knowledge/import', files={'file': ('设定.md', '角色喜欢在雨天喝热可可。'.encode(), 'text/markdown')})
    assert result.status_code == 200
    assert '热可可' in knowledge.search('雨天喝什么')[0]['content']


@pytest.mark.parametrize('image_format,suffix', [('PNG', 'png'), ('JPEG', 'jpg'), ('WEBP', 'webp')])
def test_upgraded_image_parser_handles_actual_multipart_portraits(client, image_format, suffix):
    image = io.BytesIO()
    Image.new('RGB', (32, 48), (70, 160, 190)).save(image, format=image_format)
    result = client.post('/api/characters/import', files={'file': (f'portrait.{suffix}', image.getvalue(), f'image/{suffix}')})
    assert result.status_code == 200
    decoded = Image.open(api.CHARACTERS_DIR / result.json()['model_path'])
    assert decoded.size == (32, 48)
    assert decoded.mode == 'RGBA'


def test_upgraded_pdf_parser_imports_and_retrieves_actual_pdf_text(client):
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
    content = DecodedStreamObject()
    content.set_data(b'BT /F1 12 Tf 10 100 Td (PDF regression cocoa) Tj ET')
    page[NameObject('/Contents')] = content
    output = io.BytesIO()
    writer.write(output)
    result = client.post('/api/knowledge/import', files={'file': ('test.pdf', output.getvalue(), 'application/pdf')})
    assert result.status_code == 200
    assert result.json()['kind'] == 'pdf'
    assert 'PDF regression cocoa' in knowledge.search('cocoa')[0]['content']


def test_upgraded_multipart_parser_rejects_missing_boundary_without_writing_data(client):
    before = client.get('/api/characters').json()
    result = client.post('/api/characters/import', content=b'invalid multipart', headers={'Content-Type': 'multipart/form-data'})
    assert result.status_code == 400
    assert client.get('/api/characters').json() == before


def test_background_observation_respects_proactive_off(client):
    state = client.get('/api/settings').json()['companion']
    state['screen']['enabled'] = True
    client.put('/api/settings/companion', json=state)
    result = client.post('/api/observe', json={'screen': screen_context(), 'trigger': 'periodic'})
    assert result.status_code == 200 and result.json()['shouldSpeak'] is False


def test_browser_recording_is_converted_with_bundled_ffmpeg(client, monkeypatch, tmp_path):
    import subprocess
    import wave
    import imageio_ffmpeg
    import soundfile
    from fastapi import HTTPException
    wav = tmp_path / 'source.wav'
    with wave.open(str(wav), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b'\x00\x00' * 4000)
    webm = tmp_path / 'recording.webm'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-i', str(wav), '-c:a', 'libopus', str(webm)], check=True, capture_output=True)
    attempts = []
    def recognize(audio):
        attempts.append(audio)
        try:
            samples, rate = soundfile.read(io.BytesIO(audio))
        except Exception:
            raise HTTPException(500, 'WAV conversion required')
        assert rate == 16000 and samples.ndim == 1
        return '转换后的语音'
    monkeypatch.setattr(api.speech, 'transcribe_local', recognize)
    result = client.post('/api/asr/transcribe', files={'file': ('voice.webm', webm.read_bytes(), 'audio/webm')})
    assert result.status_code == 200 and result.json()['text'] == '转换后的语音'
    assert len(attempts) == 2 and attempts[-1].startswith(b'RIFF')
