from __future__ import annotations

import json
import shutil
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Dict, List, Tuple

from fastapi import HTTPException, UploadFile

from server.app import database


from server.app.config import CHARACTERS_DIR
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_FILES = 5000


def import_character(upload: UploadFile, name: str) -> dict:
    if not upload.filename or not upload.filename.lower().endswith(".zip"):
        raise HTTPException(400, "请选择 ZIP 格式的 Live2D 模型包")

    character_id = uuid.uuid4().hex
    target = CHARACTERS_DIR / character_id
    archive = target / "source.zip"
    target.mkdir(parents=True, exist_ok=False)

    try:
        with archive.open("wb") as output:
            shutil.copyfileobj(upload.file, output)
        if archive.stat().st_size > MAX_ARCHIVE_BYTES:
            raise HTTPException(413, "模型压缩包不能超过 512 MB")

        with zipfile.ZipFile(archive) as zipped:
            members = zipped.infolist()
            if len(members) > MAX_FILES:
                raise HTTPException(400, "模型包中的文件数量过多")
            total_size = sum(member.file_size for member in members)
            if total_size > MAX_ARCHIVE_BYTES * 2:
                raise HTTPException(400, "模型包解压后的体积过大")
            for member in members:
                normalized = PurePosixPath(member.filename)
                if normalized.is_absolute() or ".." in normalized.parts:
                    raise HTTPException(400, "模型包包含不安全的文件路径")
            zipped.extractall(target / "files")

        model_files = list((target / "files").rglob("*.model3.json"))
        if not model_files:
            raise HTTPException(400, "没有找到 .model3.json，请确认这是完整的 Live2D 模型包")
        if len(model_files) > 1:
            model_files.sort(key=lambda path: len(path.parts))

        model_file = model_files[0]
        config = json.loads(model_file.read_text(encoding="utf-8-sig"))
        validate_references(config, model_file.parent)
        motions, expressions = inspect_model(config)
        relative_model = model_file.relative_to(CHARACTERS_DIR).as_posix()
        preview_url = find_preview(target / "files")
        active_count = database.row("SELECT COUNT(*) AS count FROM characters WHERE active = 1")
        active = not active_count or active_count["count"] == 0
        if active:
            with database.connect() as db:
                db.execute("UPDATE characters SET active = 0")

        imported_at = database.utc_now()
        with database.connect() as db:
            db.execute(
                "INSERT INTO characters(id,name,model_path,preview_url,active,motions,expressions,imported_at) VALUES(?,?,?,?,?,?,?,?)",
                (character_id, name.strip() or model_file.stem, relative_model, preview_url, int(active), json.dumps(motions), json.dumps(expressions), imported_at),
            )
        return serialize_character(database.row("SELECT * FROM characters WHERE id = ?", (character_id,)))
    except HTTPException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    except (zipfile.BadZipFile, json.JSONDecodeError, UnicodeDecodeError) as error:
        shutil.rmtree(target, ignore_errors=True)
        raise HTTPException(400, f"模型包解析失败：{error}") from error
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


def inspect_model(config: dict) -> Tuple[Dict[str, List[str]], List[str]]:
    references = config.get("FileReferences", {})
    motion_config = references.get("Motions", {}) or {}
    motions = {
        group: [entry.get("File", "") for entry in entries if entry.get("File")]
        for group, entries in motion_config.items()
    }
    expressions = [
        entry.get("Name") or Path(entry.get("File", "expression")).stem
        for entry in references.get("Expressions", []) or []
        if entry.get("File")
    ]
    return motions, expressions


def validate_references(config: dict, model_dir: Path) -> None:
    references = config.get("FileReferences", {})
    referenced = [references.get("Moc", ""), *(references.get("Textures", []) or [])]
    referenced.extend(references.get(key, "") for key in ("Physics", "Pose", "UserData"))
    referenced.extend(item.get("File", "") for item in references.get("Expressions", []) or [])
    for motions in (references.get("Motions", {}) or {}).values():
        referenced.extend(item.get("File", "") for item in motions)

    missing = []
    for relative in filter(None, referenced):
        normalized = PurePosixPath(relative)
        if normalized.is_absolute() or ".." in normalized.parts:
            raise HTTPException(400, "模型配置包含不安全的资源路径")
        if not (model_dir / Path(*normalized.parts)).is_file():
            missing.append(relative)
    if not references.get("Moc"):
        missing.insert(0, "Moc 文件配置")
    if missing:
        detail = "、".join(missing[:5])
        raise HTTPException(400, f"模型包缺少必要资源：{detail}")


def find_preview(files_dir: Path) -> str | None:
    candidates = [
        path for path in files_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        and any(word in path.stem.lower() for word in ("preview", "icon", "thumb"))
    ]
    if not candidates:
        return None
    relative = candidates[0].relative_to(CHARACTERS_DIR).as_posix()
    return f"/assets/characters/{relative}"


def serialize_character(item: dict | None) -> dict:
    if item is None:
        raise HTTPException(404, "形象不存在")
    return {
        **item,
        "active": bool(item["active"]),
        "motions": json.loads(item["motions"]),
        "expressions": json.loads(item["expressions"]),
    }
