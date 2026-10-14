import base64
import io
import json
import zipfile
from pathlib import Path

import pytest

from server.app import builtin_characters as builtin, characters, companion, database, roles
from server.tests.test_v1 import empty_client

SOURCE = Path(__file__).resolve().parents[4] / 'resources/builtin-characters'


def install(monkeypatch):
    monkeypatch.setattr(builtin, 'BUNDLED_DIR', SOURCE)
    builtin.seed_builtin_characters()


def test_fresh_profile_has_two_usable_models_and_safe_defaults(empty_client, monkeypatch):
    install(monkeypatch)
    state = empty_client.get('/api/bootstrap').json()
    assert state['activeRoleId'] == state['roles'][0]['id']
    assert [role['name'] for role in state['roles']] == ['虹色 Mao', '桃濑日和 Hiyori']
    assert all(len(role['id']) == 32 for role in state['roles'])
    for role in state['roles']:
        empty_client.post('/api/roles/' + role['id'] + '/activate')
        data = empty_client.get('/api/bootstrap').json()
        assert [item['framing'] for item in data['appearances']] == ['full', 'half', 'mini']
        assert all(item['kind'] == 'live2d' for item in data['appearances'])
        assert data['settings']['companion']['activeAppearanceId'] == role['id'] + '-full'
        assert role['previewUrl'].endswith('/preview.png')
        assert not data['settings']['companion']['screen']['enabled']
        assert not data['settings']['companion']['proactive']
        assert not data['health']['modelConfigured']
        assert not data['messages'] and not data['memories'] and not data['documents']
        assert data['settings']['providers']['tts']['provider'] == 'local'
        assert all(not data['settings']['providers'][kind]['hasApiKey'] for kind in ('llm', 'vision', 'tts', 'image'))
        appearance = companion.find_appearance(role['id'] + '-full')
        model_path = characters.CHARACTERS_DIR / appearance['modelPath']
        model = json.loads(model_path.read_text())
        characters.validate_references(model, model_path.parent)
        assert model['FileReferences']['Textures']
        for binding in appearance['bindings']:
            if binding['expression']:
                assert binding['expression'] in appearance['expressions']
            if binding['motionGroup']:
                assert binding['motionGroup'] in appearance['motions']
        assert (model_path.parent / 'licenses/free-material-license.html').is_file()
        assert (model_path.parent / 'ReadMe.txt').is_file()
        assert 'Live2D Inc.' in data['settings']['persona']['background']


def test_upgrade_preserves_active_role_settings_secrets_and_history(empty_client, monkeypatch):
    custom = empty_client.post('/api/roles', json={'name': 'My own role'}).json()['id']
    database.set_setting('persona', {'characterName': 'My own role', 'systemPrompt': 'KEEP'})
    database.set_setting('providers', {'llm': {'baseUrl': 'http://local/v1', 'model': 'own'}})
    with database.connect() as db:
        db.execute('INSERT INTO chat_messages(role,content,created_at,character_id) VALUES(?,?,?,?)', ('user', 'KEEP HISTORY', database.utc_now(), custom))
    before = empty_client.get('/api/bootstrap').json()
    install(monkeypatch)
    after = empty_client.get('/api/bootstrap').json()
    assert after['activeRoleId'] == custom
    assert after['settings'] == before['settings']
    assert after['messages'] == before['messages']
    assert after['appearances'] == before['appearances']
    assert len(after['roles']) == 3


def test_restart_preserves_edits_and_does_not_resurrect_deleted_examples(empty_client, monkeypatch):
    install(monkeypatch)
    database.set_setting('persona', {'characterName': 'Edited Mao'})
    state = companion.settings()
    state.activeAppearanceId = database.active_role() + '-half'
    companion.save_settings(state)
    hiyori = roles.list_roles()[1]['id']
    mao = database.active_role()
    roles.delete_role(hiyori)
    companion.log('test', 'KEEP LOG')
    before = empty_client.get('/api/bootstrap').json()
    builtin.seed_builtin_characters()
    after = empty_client.get('/api/bootstrap').json()
    assert after == before
    roles.delete_role(mao)
    builtin.seed_builtin_characters()
    assert empty_client.get('/api/bootstrap').json()['roles'] == []


def test_role_export_carries_original_model_terms(empty_client, monkeypatch):
    install(monkeypatch)
    exported = empty_client.get('/api/roles/export?resources=true').json()
    assert len(exported['resources']) == 1
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(exported['resources'][0]['archive']))) as archive:
        assert {'NOTICE.md', 'ReadMe.txt', 'licenses/free-material-license.html', 'licenses/sample-model-terms.html'} <= set(archive.namelist())


def test_invalid_bundle_does_not_create_partial_roles(empty_client, monkeypatch, tmp_path):
    source = tmp_path / 'broken-bundle'
    source.mkdir()
    (source / 'catalog.json').write_bytes((SOURCE / 'catalog.json').read_bytes())
    (source / 'manifest.json').write_bytes((SOURCE / 'manifest.json').read_bytes())
    monkeypatch.setattr(builtin, 'BUNDLED_DIR', source)
    with pytest.raises(ValueError, match='missing'):
        builtin.seed_builtin_characters()
    assert database.rows('SELECT * FROM roles') == []
    assert database.get_setting('builtin_characters_v1', []) == []


@pytest.mark.parametrize('relative', ['../escape', '/outside', 'mao/../catalog.json', 'mao\\runtime\\x'])
def test_builtin_paths_stay_inside_bundle(relative):
    with pytest.raises(ValueError):
        builtin.resource_path(SOURCE, relative)
