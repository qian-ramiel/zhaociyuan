from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path, PurePosixPath

from server.app import characters, database
from server.app.config import ROOT
from server.app.defaults import DEFAULT_MOTIONS, DEFAULT_PERSONA, DEFAULT_PROVIDERS
from server.app.models import CompanionMode, CompanionSettings, GazeSettings

BUNDLED_DIR = Path(os.environ.get('NICE_PEOPLE_BUNDLED_CHARACTERS', ROOT / 'resources/builtin-characters'))
NOTICE = ('This content uses sample data owned and copyrighted by Live2D Inc. '
          'The sample data are utilized in accordance with terms and conditions set by Live2D Inc. '
          "This content itself is created at the author's sole discretion.")
LICENSE_FILES = ('NOTICE.md', 'licenses/free-material-license.html', 'licenses/sample-model-terms.html')


def resource_path(root: Path, relative: str) -> Path:
    path = PurePosixPath(relative)
    if not relative or path.is_absolute() or '..' in path.parts or '\\' in relative:
        raise ValueError('Invalid bundled character resource path')
    target = root.joinpath(*path.parts)
    if not target.is_file() or target.is_symlink() or root.resolve() not in target.resolve().parents:
        raise ValueError(f'Bundled character resource is missing: {relative}')
    return target


def seed_builtin_characters() -> None:
    if not BUNDLED_DIR.is_dir():
        return
    catalog = json.loads((BUNDLED_DIR / 'catalog.json').read_text(encoding='utf-8'))
    manifest = json.loads((BUNDLED_DIR / 'manifest.json').read_text(encoding='utf-8'))
    if catalog['schemaVersion'] != 1 or manifest['schemaVersion'] != 1:
        raise ValueError('Unsupported bundled character catalog')
    completed = set(database.get_setting('builtin_characters_v1', []))
    for model in catalog['models']:
        model_id = model['id']
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,40}', model_id):
            raise ValueError('Invalid bundled character ID')
        if model_id in completed:
            continue
        seed_model(model, manifest)
        completed.add(model_id)


def seed_model(model: dict, manifest: dict) -> None:
    model_id = model['id']
    asset_id = 'builtin-' + model_id
    # Validate the entire allowlisted subset before making it user-visible.
    files = [entry for entry in manifest['files'] if entry['path'].startswith(model_id + '/')]
    if not files:
        raise ValueError(f'Empty bundled model: {model_id}')
    for entry in files:
        source = resource_path(BUNDLED_DIR, entry['path'])
        if source.stat().st_size != entry['bytes'] or hashlib.sha256(source.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError(f"Bundled character checksum mismatch: {entry['path']}")
    for relative in LICENSE_FILES:
        resource_path(BUNDLED_DIR, relative)
    config = json.loads(resource_path(BUNDLED_DIR, model_id + '/' + model['model']).read_text(encoding='utf-8-sig'))
    characters.validate_references(config, BUNDLED_DIR / model_id / Path(model['model']).parent)
    motions, expressions = characters.inspect_model(config)
    target = characters.CHARACTERS_DIR / asset_id
    characters.CHARACTERS_DIR.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with tempfile.TemporaryDirectory(prefix='.builtin-', dir=characters.CHARACTERS_DIR) as directory:
            staged = Path(directory) / asset_id
            for entry in files:
                relative = PurePosixPath(entry['path']).relative_to(model_id)
                destination = staged / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(BUNDLED_DIR / entry['path'], destination)
            for relative in LICENSE_FILES:
                destination = staged / Path(model['model']).parent / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(BUNDLED_DIR / relative, destination)
            shutil.copyfile(staged / 'ReadMe.txt', staged / Path(model['model']).parent / 'ReadMe.txt')
            staged.rename(target)
    # Role IDs are profile-unique so new installations cannot inherit another profile's keychain secrets.
    with database.connect() as db:
        installed = db.execute("SELECT value FROM settings WHERE key='builtin_characters_v1'").fetchone()
        completed = set(json.loads(installed['value']) if installed else [])
        if model['id'] in completed:
            return
        role_id = uuid.uuid4().hex
        had_roles = bool(db.execute('SELECT 1 FROM roles LIMIT 1').fetchone())
        now = database.utc_now()
        db.execute('INSERT INTO roles VALUES(?,?,?,?)', (role_id, model['name'], model['credit'], now))
        db.execute('INSERT OR IGNORE INTO characters VALUES(?,?,?,?,?,?,?,?)',
                   (asset_id, model['name'], asset_id + '/' + model['model'], '/assets/characters/' + asset_id + '/preview.png', 0,
                    json.dumps(motions), json.dumps(expressions), now))
        bindings = []
        for binding in DEFAULT_MOTIONS:
            value = binding.model_dump()
            value['expression'] = model['expressions'].get(binding.semantic, '')
            if binding.semantic in ('idle', 'listening', 'thinking', 'speaking'):
                value['motionGroup'] = 'Idle'
            elif model['id'] == 'hiyori' and binding.semantic in ('greeting', 'happy', 'joy'):
                value['motionGroup'] = 'Tap'
            if value['expression'] or value['motionGroup']:
                bindings.append(value)
        for framing, name in [('full', '全身'), ('half', '半身'), ('mini', 'mini')]:
            db.execute('INSERT INTO appearances(id,character_id,name,kind,asset_id,framing,scale,aliases,bindings,created_at,gaze) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (role_id + '-' + framing, role_id, name, 'live2d', asset_id, framing, 1,
                        json.dumps([framing, name + '形象'], ensure_ascii=False), json.dumps(bindings), now,
                        GazeSettings().model_dump_json()))
        persona = DEFAULT_PERSONA.model_copy(deep=True)
        persona.characterName = model['name']
        persona.background = f"{model['credit']}\n{model['source']}\n{NOTICE}"
        persona.boundaries += ' 尊重角色版权，不参与色情、暴力、猎奇或歧视性角色演绎。不声称是官方角色账号。'
        state = CompanionSettings(characterId=role_id, activeAppearanceId=role_id + '-full',
                                  modeAppearances={'daily': role_id + '-full'})
        values = {'persona': persona.model_dump(), 'providers': DEFAULT_PROVIDERS.model_dump(),
                  'companion': state.model_dump(), 'workflows': [],
                  'modes': [CompanionMode(id='daily', name='日常闲聊', prompt='自然交流日常，尊重用户情绪与个人边界。').model_dump()]}
        for key, value in values.items():
            db.execute('INSERT INTO settings VALUES(?,?,?)', (f'role:{role_id}:{key}', json.dumps(value, ensure_ascii=False), now))
        if not had_roles:
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', ('active_role', json.dumps(role_id), now))
        completed.add(model['id'])
        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', ('builtin_characters_v1', json.dumps(sorted(completed)), database.utc_now()))
