import json
import sqlite3
from contextvars import ContextVar
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional


from server.app.config import DATA_DIR

DB_PATH = DATA_DIR / "companion.db"
ROLE_KEYS = {'persona', 'providers', 'companion', 'workflows', 'motions', 'appearance_manual_mode', 'modes'}
request_role = ContextVar('request_role', default=None)


def active_role() -> str:
    selected = request_role.get()
    return selected if selected is not None else get_setting('active_role', 'companion')


def scoped_key(key: str) -> str:
    return f'role:{active_role()}:{key}' if key in ROLE_KEYS else key


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize() -> None:
    if DB_PATH.exists() and not (DATA_DIR / 'before-role-v2.db').exists():
        with sqlite3.connect(DB_PATH) as source, sqlite3.connect(DATA_DIR / 'before-role-v2.db') as backup:
            source.backup(backup)
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS roles (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, intro TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS service_profiles (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                emotion TEXT,
                actions TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                model_path TEXT NOT NULL,
                preview_url TEXT,
                active INTEGER NOT NULL DEFAULT 0,
                motions TEXT NOT NULL DEFAULT '{}',
                expressions TEXT NOT NULL DEFAULT '[]',
                imported_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS knowledge_documents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                size INTEGER NOT NULL,
                chunks INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'indexing',
                path TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS knowledge_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                content TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL CHECK(category IN ('profile', 'relationship', 'project')),
                content TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS appearances (
                id TEXT PRIMARY KEY,
                character_id TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'live2d',
                asset_id TEXT NOT NULL,
                framing TEXT NOT NULL DEFAULT 'full',
                scale REAL NOT NULL DEFAULT 1,
                aliases TEXT NOT NULL DEFAULT '[]',
                bindings TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                detail TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        columns = {item['name'] for item in db.execute('PRAGMA table_info(chat_messages)')}
        for name in ('character_id', 'screen_context', 'image_url'):
            if name not in columns:
                db.execute(f'ALTER TABLE chat_messages ADD COLUMN {name} TEXT')
        columns = {item['name'] for item in db.execute('PRAGMA table_info(memories)')}
        for name in ('character_id', 'source'):
            if name not in columns:
                db.execute(f'ALTER TABLE memories ADD COLUMN {name} TEXT')
        for table in ('events', 'knowledge_documents'):
            columns = {item['name'] for item in db.execute(f'PRAGMA table_info({table})')}
            if 'character_id' not in columns:
                db.execute(f"ALTER TABLE {table} ADD COLUMN character_id TEXT NOT NULL DEFAULT 'companion'")
        columns = {item['name'] for item in db.execute('PRAGMA table_info(appearances)')}
        if 'gaze' not in columns:
            db.execute("ALTER TABLE appearances ADD COLUMN gaze TEXT NOT NULL DEFAULT '{}'")
        columns = {item['name'] for item in db.execute('PRAGMA table_info(events)')}
        for name, definition in [('result', "TEXT NOT NULL DEFAULT 'success'"), ('duration_ms', 'INTEGER'), ('service', "TEXT NOT NULL DEFAULT ''")]:
            if name not in columns:
                db.execute(f'ALTER TABLE events ADD COLUMN {name} {definition}')
        migrated = db.execute("SELECT 1 FROM settings WHERE key='roles_migrated'").fetchone()
        if not migrated:
            legacy = db.execute("SELECT value FROM settings WHERE key='persona'").fetchone()
            has_data = legacy or db.execute('SELECT 1 FROM appearances LIMIT 1').fetchone()
            if has_data:
                name = json.loads(legacy['value']).get('characterName', '未命名') if legacy else '未命名'
                db.execute('INSERT OR IGNORE INTO roles VALUES(?,?,?,?)', ('companion', name, '', utc_now()))
                for key in ROLE_KEYS:
                    db.execute('INSERT OR IGNORE INTO settings SELECT ?,value,updated_at FROM settings WHERE key=?', (f'role:companion:{key}', key))
                db.execute("UPDATE chat_messages SET character_id='companion' WHERE character_id IS NULL")
                db.execute("UPDATE memories SET character_id='companion' WHERE character_id IS NULL")
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', ('active_role', json.dumps('companion' if has_data else ''), utc_now()))
            db.execute('INSERT INTO settings VALUES(?,?,?)', ('roles_migrated', 'true', utc_now()))


def backup(name: str) -> None:
    target = DATA_DIR / name
    if DB_PATH.exists() and not target.exists():
        with sqlite3.connect(DB_PATH) as source, sqlite3.connect(target) as destination:
            source.backup(destination)


def get_setting(key: str, default: Any) -> Any:
    key = scoped_key(key)
    with connect() as db:
        row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value: Any) -> None:
    key = scoped_key(key)
    with connect() as db:
        db.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(value, ensure_ascii=False), utc_now()),
        )


def rows(query: str, parameters: tuple = ()) -> List[Dict[str, Any]]:
    with connect() as db:
        result = db.execute(query, parameters).fetchall()
    return [dict(item) for item in result]


def row(query: str, parameters: tuple = ()) -> Optional[Dict[str, Any]]:
    with connect() as db:
        result = db.execute(query, parameters).fetchone()
    return dict(result) if result else None
