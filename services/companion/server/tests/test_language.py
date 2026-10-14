from server.tests.test_v1 import client, empty_client
from server.app import database


def test_new_profile_has_no_language_until_desktop_chooses_system(empty_client):
    assert empty_client.get('/api/desktop').json()['language'] is None


def test_language_persists_globally_and_does_not_change_role_or_provider_content(client):
    before = client.get('/api/bootstrap').json()
    for language in ('zh', 'en', 'ja'):
        desktop = client.get('/api/desktop').json()
        desktop['language'] = language
        assert client.put('/api/desktop', json=desktop).status_code == 200
        database.initialize()
        after = client.get('/api/bootstrap').json()
        assert after['desktop']['language'] == language
        assert after['settings'] == before['settings']
        assert after['messages'] == before['messages']
    other = client.post('/api/roles', json={'name': '原始名称不翻译'}).json()['id']
    client.post('/api/roles/' + other + '/activate')
    assert client.get('/api/desktop').json()['language'] == 'ja'


def test_invalid_language_is_rejected_and_older_clients_cannot_clear_preference(client):
    desktop = client.get('/api/desktop').json()
    desktop['language'] = 'en'
    assert client.put('/api/desktop', json=desktop).status_code == 200
    assert client.put('/api/desktop', json={**desktop, 'language': 'ko'}).status_code == 422
    desktop.pop('language')
    assert client.put('/api/desktop', json=desktop).json()['language'] == 'en'
