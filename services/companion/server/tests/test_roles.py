import base64
import io
import json
import zipfile

from server.app import api, companion, database, knowledge, llm
from server.app.models import CompanionReply
from server.tests.test_v1 import client, empty_client, create_appearance, configure_model, screen_context


def test_first_run_is_empty_and_requires_role(empty_client):
    data = empty_client.get('/api/bootstrap').json()
    assert data['roles'] == [] and data['activeRoleId'] == '' and data['appearances'] == []
    assert empty_client.post('/api/chat', json={'content': '你好'}).status_code == 409
    assert empty_client.post('/api/roles', json={'name': '  '}).status_code == 400


def test_legacy_role_without_saved_persona_has_consistent_name(empty_client):
    with database.connect() as db:
        db.execute('INSERT INTO roles VALUES(?,?,?,?)', ('companion', '未命名', '', database.utc_now()))
    database.set_setting('active_role', 'companion')
    data = empty_client.get('/api/bootstrap').json()
    assert data['roles'][0]['name'] == data['settings']['persona']['characterName']


def test_role_settings_secrets_history_knowledge_and_events_are_isolated(client):
    first = client.get('/api/bootstrap').json()['activeRoleId']
    full = create_appearance(client)
    mini = create_appearance(client, 'mini', 'mini')
    client.post('/api/chat', json={'content': '换成mini'})
    memory = client.post('/api/memories', json={'category': 'profile', 'content': '喜欢可可'}).json()
    document = client.post('/api/knowledge/import', files={'file': ('a.txt', '私密可可设定'.encode())}).json()
    value = client.get('/api/settings').json()['providers']
    value['llm']['apiKey'] = 'first-private-key'
    client.put('/api/settings/providers', json=value)
    other = client.post('/api/roles', json={'name': '另一个角色'}).json()['id']
    client.post('/api/roles/' + other + '/activate')
    data = client.get('/api/bootstrap').json()
    assert data['settings']['persona']['characterName'] == '另一个角色'
    assert data['appearances'] == data['messages'] == data['memories'] == data['documents'] == data['events'] == []
    assert not data['settings']['providers']['llm']['hasApiKey']
    assert knowledge.search('可可') == []
    assert client.post('/api/appearances/' + full['id'] + '/activate').status_code == 404
    assert client.patch('/api/memories/' + memory['id'], json={'enabled': False}).status_code == 404
    assert client.delete('/api/knowledge/' + document['id']).status_code == 404
    forged = data['settings']['companion']
    forged['characterId'] = first
    assert client.put('/api/settings/companion', json=forged).json()['characterId'] == other
    client.post('/api/roles/' + first + '/activate')
    data = client.get('/api/bootstrap').json()
    assert len(data['messages']) == 2 and len(data['memories']) == len(data['documents']) == 1
    assert data['settings']['companion']['activeAppearanceId'] == mini['id']
    assert api.providers().llm.apiKey == 'first-private-key'


def test_custom_mode_prompt_and_capture_permission(client, monkeypatch):
    configure_model(client)
    mode = {'id': 'code-custom', 'name': '一起写代码', 'prompt': 'MODE UNIQUE PROMPT', 'screenAllowed': False}
    assert client.put('/api/modes', json=[mode]).status_code == 200
    state = client.get('/api/settings').json()['companion']
    assert state['mode'] == mode['id']
    state['screen']['enabled'] = True
    client.put('/api/settings/companion', json=state)
    assert client.post('/api/chat', json={'content': '截图问题', 'screen': screen_context()}).status_code == 409
    prompts = []
    async def fake(*args, **kwargs):
        prompts.append(kwargs['extra_prompt'])
        return CompanionReply(text='好', speech='')
    monkeypatch.setattr(llm, 'complete', fake)
    assert client.post('/api/chat', json={'content': '文字问题'}).status_code == 200
    assert 'MODE UNIQUE PROMPT' in prompts[0]
    assert client.put('/api/modes', json=[]).status_code == 400
    assert client.put('/api/modes', json=[mode, mode]).status_code == 400


def test_profile_is_key_free_copy(client):
    providers = client.get('/api/settings').json()['providers']
    providers['llm'].update({'apiKey': 'PRIVATE', 'baseUrl': 'http://local/v1', 'model': 'alpha'})
    client.put('/api/settings/providers', json=providers)
    profile = client.post('/api/profiles', json={'name': '我的方案', 'providers': providers}).json()['id']
    assert 'PRIVATE' not in client.get('/api/profiles').text
    assert client.post('/api/profiles/' + profile + '/apply').status_code == 200
    assert not client.get('/api/settings').json()['providers']['llm']['hasApiKey']
    changed = client.get('/api/settings').json()['providers']
    changed['llm']['model'] = 'beta'
    client.put('/api/settings/providers', json=changed)
    assert client.get('/api/profiles').json()[0]['providers']['llm']['model'] == 'alpha'


def test_role_bundle_portable_resource_and_private_opt_in(client):
    appearance = create_appearance(client)
    client.post('/api/memories', json={'category': 'profile', 'content': '私密记忆'})
    public = client.get('/api/roles/export?resources=true').json()
    assert not public['memories'] and not public['chats'] and len(public['resources']) == 1
    result = client.post('/api/roles/import', files={'file': ('role.json', json.dumps(public).encode())})
    assert result.status_code == 200, result.text
    data = client.get('/api/bootstrap').json()
    assert len(data['roles']) == 2 and len(data['appearances']) == 1
    assert data['appearances'][0]['id'] != appearance['id']
    assert data['appearances'][0]['assetId'] != appearance['assetId']
    assert data['memories'] == [] and not data['settings']['companion']['screen']['enabled']
    assert data['appearances'][0]['gaze']['enabled'] is True


def test_unsafe_bundle_has_no_partial_role(client):
    public = client.get('/api/roles/export').json()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as zipped:
        zipped.writestr('../escape.png', b'unsafe')
    public['resources'] = [{'id': 'evil', 'name': 'evil', 'kind': 'static', 'archive': base64.b64encode(buffer.getvalue()).decode()}]
    before = client.get('/api/bootstrap').json()
    result = client.post('/api/roles/import', files={'file': ('role.json', json.dumps(public).encode())})
    assert result.status_code == 400
    after = client.get('/api/bootstrap').json()
    assert after['roles'] == before['roles'] and after['activeRoleId'] == before['activeRoleId']


def test_setting_context_does_not_follow_active_switch(client):
    first = database.active_role()
    token = database.request_role.set(first)
    try:
        database.set_setting('active_role', 'another')
        database.set_setting('persona', {'characterName': 'first only'})
        assert companion.settings().characterId == first
        assert database.get_setting('persona', {})['characterName'] == 'first only'
    finally:
        database.request_role.reset(token)
        database.set_setting('active_role', first)


def test_import_cannot_overwrite_another_roles_appearance(client):
    appearance = create_appearance(client)
    first = database.active_role()
    backup = client.get('/api/export').json()
    second = client.post('/api/roles', json={'name': '第二个角色'}).json()['id']
    client.post('/api/roles/' + second + '/activate')
    backup['appearances'][0]['name'] = '恶意覆盖'
    assert client.post('/api/import', json=backup).status_code == 400
    client.post('/api/roles/' + first + '/activate')
    assert client.get('/api/appearances').json()[0]['name'] == appearance['name']


def test_global_desktop_settings_are_not_role_scoped(client):
    prefs = client.get('/api/desktop').json()
    prefs.update({'menu': 'always', 'gazeEnabled': False})
    assert client.put('/api/desktop', json=prefs).status_code == 200
    other = client.post('/api/roles', json={'name': '第二个角色'}).json()['id']
    client.post('/api/roles/' + other + '/activate')
    assert client.get('/api/desktop').json() == prefs
