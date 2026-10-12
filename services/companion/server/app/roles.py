from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from server.app import companion, database, secrets
from server.app.defaults import DEFAULT_PERSONA, DEFAULT_PROVIDERS
from server.app.models import CompanionMode, CompanionSettings, PersonaSettings, ProviderSettings, RoleCreate

router = APIRouter(prefix='/api')
MODE_RUNTIME_FIELDS = ('proactive', 'cooldown', 'hourlyLimit', 'quietStart', 'quietEnd')
MODE_TEMPLATES = [
    {'id': 'daily', 'name': '日常闲聊', 'prompt': '自然地交流日常，尊重我的情绪和个人边界。'},
    {'id': 'work', 'name': '工作陪聊', 'prompt': '关注正在进行的工作，建议简短而可执行；不要频繁打断。'},
    {'id': 'game', 'name': '游戏陪玩', 'prompt': '结合画面给出明确、简短的建议，不确定时说明，不虚构游戏信息。', 'screenAllowed': True},
    {'id': 'movie', 'name': '电影陪看', 'prompt': '只讨论已经看到的剧情，不剧透；没有新内容时保持安静。', 'screenAllowed': True},
]


def legacy_mode(value, state):
    normalized = CompanionMode.model_validate({
        'replyLength': 'medium', **value,
        'observation': value.get('observation', {key: getattr(state.screen, key) for key in ('periodic', 'onChange', 'interval', 'changeThreshold')}),
    }).model_dump()
    if 'observation' not in value and normalized['id'] == state.mode:
        normalized.update({field: getattr(state, field) for field in MODE_RUNTIME_FIELDS})
    return normalized


def migrate_modes():
    if database.get_setting('mode_observation_v3', False):
        return
    database.backup('before-mode-observation-v3.db')
    with database.connect() as db:
        for role in db.execute('SELECT id FROM roles').fetchall():
            key = f"role:{role['id']}:"
            stored = db.execute('SELECT value FROM settings WHERE key=?', (key + 'companion',)).fetchone()
            state = CompanionSettings.model_validate(json.loads(stored['value']) if stored else {})
            saved = db.execute('SELECT value FROM settings WHERE key=?', (key + 'modes',)).fetchone()
            values = json.loads(saved['value']) if saved else [{**t, 'screenAllowed': state.screen.enabled or t.get('screenAllowed', False), **{field: getattr(state, field) for field in MODE_RUNTIME_FIELDS}} for t in MODE_TEMPLATES]
            normalized = []
            for value in values:
                item = legacy_mode(value, state)
                if item['id'] == state.mode:
                    item.update({field: getattr(state, field) for field in MODE_RUNTIME_FIELDS})
                normalized.append(item)
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', (key + 'modes', json.dumps(normalized, ensure_ascii=False), database.utc_now()))
        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', ('mode_observation_v3', 'true', database.utc_now()))


@router.get('/modes')
def modes():
    saved = database.get_setting('modes', None)
    if saved is not None:
        state = companion.settings()
        return [legacy_mode(item, state) for item in saved]
    state = companion.settings()
    # Migrated roles keep their previously permitted capture and proactive settings.
    return [legacy_mode({**t, 'screenAllowed': state.screen.enabled or t.get('screenAllowed', False),
            'proactive': state.proactive, 'cooldown': state.cooldown, 'hourlyLimit': state.hourlyLimit,
            'quietStart': state.quietStart, 'quietEnd': state.quietEnd}, state) for t in MODE_TEMPLATES]


def current_mode():
    return next((m for m in modes() if m['id'] == companion.settings().mode), None)


def secret_key(name):
    return f'role:{database.active_role()}:{name}-api-key'


def migrate_secrets():
    if database.get_setting('role_secrets_migrated', False):
        return
    if database.row("SELECT id FROM roles WHERE id='companion'"):
        for name in ('llm', 'vision', 'tts', 'image'):
            old = secrets.get_secret(f'{name}-api-key')
            if old and not secrets.get_secret(f'role:companion:{name}-api-key'):
                secrets.set_secret(f'role:companion:{name}-api-key', old)
    database.set_setting('role_secrets_migrated', True)


@router.get('/roles')
def list_roles():
    result = []
    for role in database.rows('SELECT * FROM roles ORDER BY created_at'):
        token = database.request_role.set(role['id'])
        try:
            fallback_name = DEFAULT_PERSONA.characterName if role['id'] == 'companion' else role['name']
            result.append({**role, 'name': database.get_setting('persona', {'characterName': fallback_name})['characterName'],
                           'appearanceCount': len(companion.appearances()), 'modeCount': len(modes()),
                           'previewUrl': next((a['previewUrl'] for a in companion.appearances() if a['previewUrl']), None)})
        finally:
            database.request_role.reset(token)
    return result


@router.post('/roles')
def create_role(value: RoleCreate):
    if not value.name.strip():
        raise HTTPException(400, '请填写角色名称')
    role_id = uuid.uuid4().hex
    with database.connect() as db:
        db.execute('INSERT INTO roles VALUES(?,?,?,?)', (role_id, value.name.strip(), value.intro, database.utc_now()))
    token = database.request_role.set(role_id)
    try:
        persona = DEFAULT_PERSONA.model_copy(deep=True)
        persona.characterName = value.name.strip()
        persona.background = value.intro
        if value.personality.strip():
            persona.personality = value.personality
        database.set_setting('persona', persona.model_dump())
        database.set_setting('providers', DEFAULT_PROVIDERS.model_dump())
        database.set_setting('modes', [CompanionMode(id='daily', name='日常闲聊', prompt=MODE_TEMPLATES[0]['prompt']).model_dump()])
        database.set_setting('companion', CompanionSettings(characterId=role_id).model_dump())
        database.set_setting('workflows', [])
        if not database.get_setting('active_role', ''):
            database.set_setting('active_role', role_id)
    finally:
        database.request_role.reset(token)
    return {'id': role_id}


@router.post('/roles/{role_id}/activate')
def activate_role(role_id: str):
    if not database.row('SELECT id FROM roles WHERE id=?', (role_id,)):
        raise HTTPException(404, '角色不存在')
    database.set_setting('active_role', role_id)
    return {'ok': True}


@router.delete('/roles/{role_id}')
def delete_role(role_id: str):
    if not database.row('SELECT id FROM roles WHERE id=?', (role_id,)):
        raise HTTPException(404, '角色不存在')
    with database.connect() as db:
        for table in ('chat_messages', 'memories', 'events', 'appearances', 'knowledge_documents'):
            db.execute(f'DELETE FROM {table} WHERE character_id=?', (role_id,))
        db.execute('DELETE FROM settings WHERE key LIKE ?', (f'role:{role_id}:%',))
        db.execute('DELETE FROM roles WHERE id=?', (role_id,))
    for name in ('llm', 'vision', 'tts', 'image'):
        secrets.set_secret(f'role:{role_id}:{name}-api-key', '')
    if database.get_setting('active_role', '') == role_id:
        remaining = database.row('SELECT id FROM roles ORDER BY created_at LIMIT 1')
        database.set_setting('active_role', remaining['id'] if remaining else '')
    return {'ok': True}


@router.put('/modes')
def save_modes(value: list[CompanionMode]):
    if not value or len(value) > 50 or len({m.id for m in value}) != len(value):
        raise HTTPException(400, '需要 1 至 50 个模式，且 ID 不能重复')
    database.set_setting('modes', [m.model_dump() for m in value])
    state = companion.settings()
    valid = {m.id for m in value}
    state.modeAppearances = {k: v for k, v in state.modeAppearances.items() if k in valid}
    if state.mode not in valid:
        state.mode = value[0].id
        mapped = state.modeAppearances.get(state.mode)
        if mapped:
            state.activeAppearanceId = mapped
    selected = next(item for item in value if item.id == state.mode)
    for field in MODE_RUNTIME_FIELDS:
        setattr(state, field, getattr(selected, field))
    companion.save_settings(state)
    return value


class ProactivePatch(BaseModel):
    enabled: bool


@router.patch('/modes/{mode_id}/proactive')
def toggle_proactive(mode_id: str, value: ProactivePatch):
    items = modes()
    selected = next((item for item in items if item['id'] == mode_id), None)
    if not selected:
        raise HTTPException(404, '模式不存在')
    selected['proactive'] = value.enabled
    return save_modes([CompanionMode.model_validate(item) for item in items])


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    providers: ProviderSettings


def clean_providers(value):
    value = value.model_copy(deep=True)
    for name in ('llm', 'vision', 'tts', 'image'):
        getattr(value, name).apiKey = ''
        getattr(value, name).hasApiKey = False
    return value.model_dump()


@router.get('/profiles')
def profiles():
    return [{**p, 'providers': json.loads(p['value']), 'value': None} for p in database.rows('SELECT * FROM service_profiles ORDER BY created_at DESC')]


@router.post('/profiles')
def save_profile(value: ProfileCreate):
    profile_id = uuid.uuid4().hex
    with database.connect() as db:
        db.execute('INSERT INTO service_profiles VALUES(?,?,?,?)', (profile_id, value.name, json.dumps(clean_providers(value.providers)), database.utc_now()))
    return {'id': profile_id}


@router.post('/profiles/{profile_id}/apply')
def apply_profile(profile_id: str):
    profile = database.row('SELECT * FROM service_profiles WHERE id=?', (profile_id,))
    if not profile:
        raise HTTPException(404, '方案不存在')
    # Profiles are key-free copies. Applying one must not reuse an old endpoint's secret.
    for name in ('llm', 'vision', 'tts', 'image'):
        secrets.set_secret(secret_key(name), '')
    database.set_setting('providers', json.loads(profile['value']))
    return {'ok': True}


@router.delete('/profiles/{profile_id}')
def delete_profile(profile_id: str):
    with database.connect() as db:
        db.execute('DELETE FROM service_profiles WHERE id=?', (profile_id,))
    return {'ok': True}
