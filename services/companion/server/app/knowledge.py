from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path
from typing import List

from docx import Document
from fastapi import HTTPException, UploadFile
from pypdf import PdfReader

from server.app import database


from server.app.config import KNOWLEDGE_DIR
SUPPORTED = {".pdf", ".md", ".txt", ".docx"}
MAX_FILE_BYTES = 50 * 1024 * 1024


def import_document(upload: UploadFile) -> dict:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in SUPPORTED:
        raise HTTPException(400, "知识库仅支持 PDF、Markdown、TXT 和 DOCX")
    document_id = uuid.uuid4().hex
    target = KNOWLEDGE_DIR / f"{document_id}{suffix}"
    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as output:
        shutil.copyfileobj(upload.file, output)
    if target.stat().st_size > MAX_FILE_BYTES:
        target.unlink(missing_ok=True)
        raise HTTPException(413, "单个知识文档不能超过 50 MB")

    try:
        text = extract_text(target)
        chunks = split_text(text)
        if not chunks:
            raise HTTPException(400, "文档中没有解析到可用文字")
        created_at = database.utc_now()
        with database.connect() as db:
            db.execute(
                "INSERT INTO knowledge_documents(id,name,kind,size,chunks,enabled,status,path,created_at,character_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (document_id, upload.filename, suffix.lstrip("."), target.stat().st_size, len(chunks), 1, "ready", target.as_posix(), created_at, database.active_role()),
            )
            db.executemany(
                "INSERT INTO knowledge_chunks(document_id,position,content) VALUES(?,?,?)",
                [(document_id, index, chunk) for index, chunk in enumerate(chunks)],
            )
        return serialize_document(database.row("SELECT * FROM knowledge_documents WHERE id = ?", (document_id,)))
    except Exception:
        target.unlink(missing_ok=True)
        raise


def extract_text(path: Path) -> str:
    if path.suffix == ".pdf":
        reader = PdfReader(path)
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    if path.suffix == ".docx":
        document = Document(path)
        return "\n".join(paragraph.text for paragraph in document.paragraphs)
    return path.read_text(encoding="utf-8-sig", errors="replace")


def split_text(text: str, size: int = 900, overlap: int = 120) -> List[str]:
    cleaned = re.sub(r"[ \t]+", " ", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    if not cleaned:
        return []
    chunks: List[str] = []
    cursor = 0
    while cursor < len(cleaned):
        end = min(cursor + size, len(cleaned))
        if end < len(cleaned):
            boundary = max(cleaned.rfind("\n", cursor + size // 2, end), cleaned.rfind("。", cursor + size // 2, end))
            if boundary > cursor:
                end = boundary + 1
        chunk = cleaned[cursor:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(cleaned):
            break
        cursor = max(end - overlap, cursor + 1)
    return chunks


def search(query: str, limit: int = 5) -> List[dict]:
    lowered = query.lower()
    terms = set(re.findall(r"[a-z0-9_]{2,}", lowered))
    for sequence in re.findall(r"[\u4e00-\u9fff]+", lowered):
        terms.update(sequence[index:index + 2] for index in range(max(1, len(sequence) - 1)))
    candidates = database.rows(
        "SELECT c.content,d.name,c.position FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.enabled=1 AND d.character_id=?", (database.active_role(),)
    )
    ranked = []
    for candidate in candidates:
        content = candidate["content"].lower()
        score = sum(content.count(term) * (2 if len(term) > 2 else 1) for term in terms)
        if score:
            ranked.append((score, candidate))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in ranked[:limit]]


def serialize_document(item: dict | None) -> dict:
    if item is None:
        raise HTTPException(404, "文档不存在")
    return {key: value for key, value in item.items() if key != "path"} | {"enabled": bool(item["enabled"])}
