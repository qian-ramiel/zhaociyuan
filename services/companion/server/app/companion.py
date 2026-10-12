from __future__ import annotations

import json
import re
import sqlite3
import uuid
from pathlib import Path

from fastapi import HTTPException

from server.app import database
from server.app.config import CHARACTERS_DIR, ROOT
from server.app.models import AppearanceCreate, CompanionSettings, Workflow


DEFAULT_WORKFLOWS = [
    Workflow(id="game-question", name="游戏建议", mode="game", prompt="根据当前画面先给一句最有用的建议；不确定时说明，避免虚构敌人和操作。"),
    Workflow(id="work-checkin", name="工作陪聊", trigger="periodic", mode="work", prompt="只在发现值得交流的新进展时简短回应，否则输出 custom.shouldSpeak=false。"),
    Workflow(id="movie-chat", name="观影讨论", mode="movie", prompt="只基于已经看到的画面和用户说过的剧情讨论，避免剧透。"),
]


def settings() -> CompanionSettings:
    value = CompanionSettings.model_validate(database.get_setting("companion", CompanionSettings().model_dump()))
    value.characterId = database.active_role()
    selected = next((item for item in database.get_setting('modes', []) if item['id'] == value.mode), None)
    if selected:
        for key in ('proactive', 'cooldown', 'hourlyLimit', 'quietStart', 'quietEnd'):
            setattr(value, key, selected.get(key, getattr(value, key)))
    return value


def save_settings(value: CompanionSettings) -> CompanionSettings:
    value.characterId = database.active_role()
    if value.activeAppearanceId:
        find_appearance(value.activeAppearanceId, value.characterId)
    database.set_setting("companion", value.model_dump())
    return value


def log(kind: str, detail: str, result: str = 'success', duration_ms: int | None = None, service: str = '') -> None:
    with database.connect() as db:
        db.execute("INSERT INTO events(kind,detail,created_at,character_id,result,duration_ms,service) VALUES(?,?,?,?,?,?,?)", (kind, detail[:2000], database.utc_now(), database.active_role(), result, duration_ms, service))
        db.execute("DELETE FROM events WHERE character_id=? AND id NOT IN (SELECT id FROM events WHERE character_id=? ORDER BY id DESC LIMIT 500)", (database.active_role(), database.active_role()))


def appearances(character_id: str | None = None) -> list[dict]:
    items = database.rows("SELECT * FROM appearances WHERE character_id=? ORDER BY created_at", (character_id or settings().characterId,))
    assets = {item['id']: item for item in database.rows("SELECT * FROM characters")}
    result = []
    for item in items:
        asset = assets.get(item['asset_id'])
        if not asset:
            continue
        result.append({
            "id": item['id'], "name": item['name'], "characterId": item['character_id'],
            "assetId": item['asset_id'], "kind": item['kind'], "framing": item['framing'],
            "scale": item['scale'], "aliases": json.loads(item['aliases']),
            "bindings": json.loads(item['bindings']), "modelPath": asset['model_path'],
            "previewUrl": asset['preview_url'], "motions": json.loads(asset['motions']),
            "expressions": json.loads(asset['expressions']),
            "gaze": json.loads(item['gaze']),
        })
    return result


def find_appearance(appearance_id: str, character_id: str | None = None) -> dict:
    item = next((a for a in appearances(character_id) if a['id'] == appearance_id), None)
    if not item:
        raise HTTPException(404, "这套形象尚未配置")
    path = (CHARACTERS_DIR / item['modelPath']).resolve()
    if CHARACTERS_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(400, "形象资源缺失，保留当前形象")
    return item


def create_appearance(value: AppearanceCreate, appearance_id: str | None = None) -> dict:
    asset = database.row("SELECT * FROM characters WHERE id=?", (value.assetId,))
    if not asset:
        raise HTTPException(404, "请选择已经导入的形象资源")
    state = settings()
    appearance_id = appearance_id or uuid.uuid4().hex
    with database.connect() as db:
        db.execute(
            "INSERT INTO appearances(id,character_id,name,kind,asset_id,framing,scale,aliases,bindings,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name,asset_id=excluded.asset_id,kind=excluded.kind,framing=excluded.framing,scale=excluded.scale,aliases=excluded.aliases,bindings=excluded.bindings",
            (appearance_id, state.characterId, value.name, "static" if not asset['model_path'].endswith('.model3.json') else "live2d", value.assetId, value.framing, value.scale,
             json.dumps(value.aliases, ensure_ascii=False), json.dumps([b.model_dump() for b in value.bindings]), database.utc_now()),
        )
        db.execute('UPDATE appearances SET gaze=? WHERE id=?', (value.gaze.model_dump_json(), appearance_id))
    if not state.activeAppearanceId:
        state.activeAppearanceId = appearance_id
        save_settings(state)
    return find_appearance(appearance_id)


def activate(appearance_id: str, reason: str = "手动") -> dict:
    item = find_appearance(appearance_id)
    state = settings()
    if state.activeAppearanceId != appearance_id:
        state.previousAppearanceId = state.activeAppearanceId
    state.activeAppearanceId = appearance_id
    if reason in ('手动', '用户指令'):
        database.set_setting('appearance_manual_mode', state.mode)
    save_settings(state)
    log("appearance", f"{reason}切换形象：{item['name']}")
    return item


def is_switch_request(text: str) -> bool:
    return bool(re.search(r"换|切换|变成|改成|恢复", text)) and not re.search(r"不要|别换|不想|不需要|不用", text)


def explicit_switch(text: str) -> dict | None:
    if not is_switch_request(text):
        return None
    if re.search(r"恢复.*(?:刚才|之前|上一个)", text):
        return next((a for a in appearances() if a['id'] == settings().previousAppearanceId), None)
    matches = []
    for item in appearances():
        names = [item['name'], *item['aliases']]
        if any(name and name.lower() in text.lower() for name in names):
            matches.append(item)
    return matches[0] if len(matches) == 1 else None


def workflows() -> list[dict]:
    return database.get_setting("workflows", [w.model_dump() for w in DEFAULT_WORKFLOWS])


def workflow_prompt(trigger: str, content: str = "", workflow_id: str | None = None) -> str:
    state = settings()
    selected = []
    for item in workflows():
        if not item['enabled'] or item['mode'] not in ('all', state.mode):
            continue
        if workflow_id and item['id'] != workflow_id:
            continue
        if not workflow_id and item['trigger'] != trigger:
            continue
        if item['keyword'] and item['keyword'] not in content:
            continue
        selected.append(item['prompt'])
    return "\n".join(selected)


def seed_legacy_assets() -> None:
    if database.rows("SELECT id FROM characters"):
        return
    legacy = ROOT / "archive" / "web-demo-0.1.0-20261007" / "data" / "companion.db"
    if not legacy.exists():
        return
    # Only reuse resource metadata. Old chats, provider secrets and memories stay archived.
    with sqlite3.connect(legacy) as old:
        old.row_factory = sqlite3.Row
        assets = [dict(item) for item in old.execute("SELECT * FROM characters")]
    with database.connect() as db:
        for item in assets:
            if not (CHARACTERS_DIR / item['model_path']).is_file():
                continue
            db.execute("INSERT OR IGNORE INTO characters(id,name,model_path,preview_url,active,motions,expressions,imported_at) VALUES(?,?,?,?,?,?,?,?)",
                       tuple(item[k] for k in ('id', 'name', 'model_path', 'preview_url', 'active', 'motions', 'expressions', 'imported_at')))
