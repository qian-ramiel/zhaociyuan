from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import subprocess
import tempfile
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal, Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from server.app import builtin_characters, characters, companion, database, knowledge, llm, roles, secrets, speech
from server.app.config import API_TOKEN, CHARACTERS_DIR, KNOWLEDGE_DIR, ROOT, RUNTIME_DIR
from server.app.defaults import DEFAULT_MOTIONS, DEFAULT_PERSONA, DEFAULT_PROVIDERS
from server.app.streaming import event
from server.app.retry import retry_call, retry_stream, summary, record_failure
from server.app.models import (
    AppearanceCreate, ChatRequest, CompanionReply, CompanionSettings, EnabledPatch,
    ImageRequest, LlmSettings, MemoryCreate, MemoryPatch, MotionBinding, ObserveRequest,
    PersonaSettings, ProviderSettings, SpeechRequest, TtsSettings, Workflow,
    DesktopSettings,
)

for directory in (CHARACTERS_DIR, KNOWLEDGE_DIR, RUNTIME_DIR):
    directory.mkdir(parents=True, exist_ok=True)

tasks: dict[str, asyncio.Task] = {}
cancelled_requests: dict[str, float] = {}
locks: dict[str, asyncio.Lock] = {}
observation_task = None
REQUEST_SERVICES = {'/api/chat': '对话模型', '/api/chat/stream': '对话模型', '/api/observe': '屏幕观察',
                    '/api/tts/synthesize': 'TTS', '/api/tts/stream': 'TTS', '/api/providers/tts/test': 'TTS 试听',
                    '/api/providers/llm/test': '连接测试', '/api/asr/transcribe': 'ASR', '/api/images/generate': '文生图'}


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.initialize()
    roles.migrate_modes()
    companion.seed_legacy_assets()
    roles.migrate_secrets()
    builtin_characters.seed_builtin_characters()
    yield
    for task in list(tasks.values()):
        task.cancel()


app = FastAPI(title="兆次元", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:4317", "http://localhost:4317", "http://127.0.0.1:8791"], allow_methods=['*'], allow_headers=['*'])


@app.middleware('http')
async def authenticate(request: Request, call_next):
    started = time.monotonic()
    trace_id = request.headers.get('x-request-id', '')
    request.state.trace_id = trace_id if re.fullmatch(r'[a-zA-Z0-9-]{1,80}', trace_id) else uuid.uuid4().hex
    if API_TOKEN and request.url.path.startswith('/api/') and request.url.path != '/api/health':
        if request.method != 'OPTIONS' and request.headers.get('authorization') != f'Bearer {API_TOKEN}':
            return JSONResponse({'detail': '本地连接未授权，请从桌面程序打开'}, status_code=401)
    role_id = database.get_setting('active_role', '')
    token = database.request_role.set(role_id)
    try:
        if request.url.path.startswith('/api/roles') and request.method not in ('GET', 'OPTIONS'):
            for task in list(tasks.values()):
                task.cancel()
            if observation_task and not observation_task.done():
                observation_task.cancel()
        if request.method not in ('GET', 'OPTIONS') and request.url.path.startswith('/api/') and not role_id:
            if request.url.path not in ('/api/roles', '/api/roles/import', '/api/profiles', '/api/desktop') and not request.url.path.startswith('/api/roles/'):
                return JSONResponse({'detail': '请先创建角色'}, status_code=409)
        response = await call_next(request)
        service = REQUEST_SERVICES.get(request.url.path)
        if service and request.method == 'POST' and role_id and (not request.url.path.endswith('/stream') or response.status_code >= 400):
            detail = f'{request.state.trace_id} · 请求={request.url.path} · HTTP {response.status_code}'
            if response.status_code >= 400 and 'application/json' in response.headers.get('content-type', ''):
                body = b''.join([chunk async for chunk in response.body_iterator])
                try:
                    detail += ' · ' + summary(HTTPException(response.status_code, json.loads(body).get('detail', '请求失败')))
                except (ValueError, AttributeError):
                    pass
                response = Response(body, status_code=response.status_code, headers=dict(response.headers))
            result = 'cancelled' if response.status_code == 499 else 'success' if response.status_code < 400 else 'error'
            companion.log('service', detail, result, round((time.monotonic() - started) * 1000), service)
        return response
    except Exception as error:
        service = REQUEST_SERVICES.get(request.url.path)
        if service and role_id:
            record_failure(error, service, request.state.trace_id, started, '请求处理')
        raise
    finally:
        database.request_role.reset(token)


app.include_router(roles.router)


@app.get('/api/desktop')
def desktop_settings():
    return DesktopSettings.model_validate(database.get_setting('desktop', {}))


@app.put('/api/desktop')
def save_desktop(value: DesktopSettings):
    if value.language is None:
        value.language = database.get_setting('desktop', {}).get('language')
    database.set_setting('desktop', value.model_dump())
    return value


app.mount('/assets/characters', StaticFiles(directory=CHARACTERS_DIR), name='characters')
app.mount('/assets/runtime', StaticFiles(directory=RUNTIME_DIR), name='runtime')


def persona():
    return PersonaSettings.model_validate(database.get_setting('persona', DEFAULT_PERSONA.model_dump()))


def providers():
    value = ProviderSettings.model_validate(database.get_setting('providers', DEFAULT_PROVIDERS.model_dump()))
    for name in ('llm', 'vision', 'tts', 'image'):
        getattr(value, name).apiKey = secrets.get_secret(roles.secret_key(name))
    return value


def public_providers(value: ProviderSettings) -> dict:
    output = value.model_dump()
    for name in ('llm', 'vision', 'tts', 'image'):
        output[name]['hasApiKey'] = bool(output[name]['apiKey'])
        output[name]['apiKey'] = ''
    return output


def messages():
    items = database.rows('SELECT * FROM (SELECT * FROM chat_messages WHERE character_id=? ORDER BY id DESC LIMIT 200) ORDER BY id', (companion.settings().characterId,))
    for item in items:
        item['actions'] = json.loads(item['actions'] or '[]')
        item['screen_context'] = json.loads(item['screen_context']) if item['screen_context'] else None
    return items


@app.get('/api/health')
def health():
    value = providers()
    return {'status': 'ok', 'version': '1.0.0', 'modelConfigured': bool(value.llm.baseUrl and value.llm.model),
            'tts_installed': (speech.TTS_MODEL_DIR / 'model.onnx').exists(), 'asr_installed': (speech.ASR_MODEL_DIR / 'model.int8.onnx').exists()}


@app.get('/api/settings')
def get_settings():
    return {'persona': persona(), 'providers': public_providers(providers()), 'motions': database.get_setting('motions', [m.model_dump() for m in DEFAULT_MOTIONS]), 'companion': companion.settings()}


@app.get('/api/bootstrap')
def bootstrap():
    return {'health': health(), 'settings': get_settings(), 'appearances': companion.appearances(), 'assets': list_assets(),
            'messages': messages(), 'memories': list_memories(), 'documents': list_documents(), 'workflows': companion.workflows(), 'events': list_events(),
            'roles': roles.list_roles(), 'activeRoleId': database.active_role(), 'modes': roles.modes(), 'profiles': roles.profiles(), 'desktop': desktop_settings()}


@app.put('/api/settings/persona')
def save_persona(value: PersonaSettings):
    database.set_setting('persona', value.model_dump())
    return value


@app.put('/api/settings/companion')
def save_companion(value: CompanionSettings):
    previous = companion.settings()
    value.characterId = database.active_role()
    mode = next((m for m in roles.modes() if m['id'] == value.mode), None)
    if not mode:
        raise HTTPException(400, '请选择当前角色的陪伴模式')
    for appearance_id in filter(None, value.modeAppearances.values()):
        companion.find_appearance(appearance_id)
    if value.mode != previous.mode:
        database.set_setting('appearance_manual_mode', '')
        for key in ('proactive', 'cooldown', 'hourlyLimit', 'quietStart', 'quietEnd'):
            setattr(value, key, mode[key])
    else:
        items = roles.modes()
        for item in items:
            if item['id'] == value.mode:
                item.update({key: getattr(value, key) for key in roles.MODE_RUNTIME_FIELDS})
        database.set_setting('modes', items)
    if value.mode != previous.mode:
        candidate = value.modeAppearances.get(value.mode)
        if candidate:
            companion.find_appearance(candidate, value.characterId)
            value.activeAppearanceId = candidate
    return companion.save_settings(value)


@app.put('/api/settings/providers')
def save_providers(value: ProviderSettings):
    previous = providers()
    for name in ('llm', 'vision', 'tts', 'image'):
        incoming = getattr(value, name)
        if incoming.apiKey:
            secrets.set_secret(roles.secret_key(name), incoming.apiKey)
        elif not incoming.hasApiKey or incoming.baseUrl != getattr(previous, name).baseUrl:
            secrets.set_secret(roles.secret_key(name), '')
        incoming.apiKey = ''
        incoming.hasApiKey = False
    database.set_setting('providers', value.model_dump())
    return public_providers(providers())


@app.delete('/api/providers/{kind}/key')
def clear_key(kind: str):
    if kind not in ('llm', 'vision', 'tts', 'image'):
        raise HTTPException(404, '服务不存在')
    secrets.set_secret(roles.secret_key(kind), '')
    return {'ok': True}


@app.post('/api/providers/llm/test')
async def test_model(value: LlmSettings):
    saved = providers().llm
    if not value.apiKey and value.baseUrl == saved.baseUrl:
        value.apiKey = saved.apiKey
    return {'message': await llm.test_connection(value)}


@app.put('/api/settings/motions')
def save_motions(value: list[MotionBinding]):
    database.set_setting('motions', [m.model_dump() for m in value])
    return value


@app.get('/api/characters')
def list_assets():
    return [characters.serialize_character(a) for a in database.rows('SELECT * FROM characters ORDER BY imported_at')]


@app.post('/api/characters/import')
def import_asset(file: UploadFile = File(...), name: str = Form('')):
    suffix = (file.filename or '').lower()
    if suffix.endswith('.zip'):
        return characters.import_character(file, name)
    if not suffix.endswith(('.png', '.jpg', '.jpeg', '.webp')):
        raise HTTPException(400, '请选择 Live2D ZIP 或 PNG/JPEG/WebP 立绘')
    from PIL import Image
    data = file.file.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, '立绘不能超过 20 MB')
    try:
        image = Image.open(io.BytesIO(data))
        image.verify()
    except Exception as error:
        raise HTTPException(400, '无法读取这张图片') from error
    asset_id = uuid.uuid4().hex
    directory = CHARACTERS_DIR / asset_id
    directory.mkdir()
    target = directory / 'portrait.png'
    image = Image.open(io.BytesIO(data)).convert('RGBA')
    image.save(target)
    relative = target.relative_to(CHARACTERS_DIR).as_posix()
    with database.connect() as db:
        db.execute('INSERT INTO characters(id,name,model_path,preview_url,motions,expressions,imported_at) VALUES(?,?,?,?,?,?,?)',
                   (asset_id, name or file.filename, relative, '/assets/characters/' + relative, '{}', '[]', database.utc_now()))
    return characters.serialize_character(database.row('SELECT * FROM characters WHERE id=?', (asset_id,)))


@app.get('/api/appearances')
def list_appearances():
    return companion.appearances()


@app.post('/api/characters/{asset_id}/preview')
def save_asset_preview(asset_id: str, value: dict):
    if not any(a['assetId'] == asset_id for a in companion.appearances()):
        raise HTTPException(404, '当前角色尚未绑定这个资源')
    asset = database.row('SELECT * FROM characters WHERE id=?', (asset_id,))
    if asset['preview_url']:
        return {'previewUrl': asset['preview_url']}
    from PIL import Image
    try:
        data = value['image']
        if not isinstance(data, str) or len(data) > 4_000_000 or not data.startswith('data:image/png;base64,'):
            raise ValueError()
        preview = Image.open(io.BytesIO(base64.b64decode(data.split(',', 1)[1], validate=True))).convert('RGBA')
        if preview.getextrema()[3][1] == 0:
            raise ValueError()
        preview.thumbnail((480, 640))
    except (KeyError, ValueError, OSError, TypeError):
        raise HTTPException(400, '预览图片无效')
    directory = CHARACTERS_DIR / asset_id
    directory.mkdir(exist_ok=True)
    target = directory / 'preview.png'
    preview.save(target)
    url = '/assets/characters/' + target.relative_to(CHARACTERS_DIR).as_posix()
    with database.connect() as db:
        db.execute('UPDATE characters SET preview_url=? WHERE id=?', (url, asset_id))
    return {'previewUrl': url}


@app.post('/api/appearances')
def add_appearance(value: AppearanceCreate):
    return companion.create_appearance(value)


@app.put('/api/appearances/{appearance_id}')
def edit_appearance(appearance_id: str, value: AppearanceCreate):
    companion.find_appearance(appearance_id)
    return companion.create_appearance(value, appearance_id)


@app.post('/api/appearances/{appearance_id}/activate')
def activate_appearance(appearance_id: str):
    return companion.activate(appearance_id)


@app.delete('/api/appearances/{appearance_id}')
def remove_appearance(appearance_id: str):
    companion.find_appearance(appearance_id)
    state = companion.settings()
    with database.connect() as db:
        db.execute('DELETE FROM appearances WHERE id=? AND character_id=?', (appearance_id, state.characterId))
    remaining = companion.appearances()
    if state.activeAppearanceId == appearance_id:
        state.activeAppearanceId = remaining[0]['id'] if remaining else ''
    state.modeAppearances = {k: v for k, v in state.modeAppearances.items() if v != appearance_id}
    companion.save_settings(state)
    return {'ok': True}


@app.get('/api/chat/history')
def history():
    return messages()


@app.delete('/api/chat/history')
def clear_history():
    with database.connect() as db:
        db.execute('DELETE FROM chat_messages WHERE character_id=?', (companion.settings().characterId,))
    return {'ok': True}


def validate_screen(screen):
    state = companion.settings()
    if screen and not desktop_settings().visionEnabled:
        raise HTTPException(409, '视觉开关已关闭，本次不会发送画面')
    if screen and (not state.screen.enabled or state.screen.paused):
        raise HTTPException(409, '屏幕观察已关闭或暂停，本次不会发送画面')
    if screen and not (roles.current_mode() or {}).get('screenAllowed', False):
        raise HTTPException(409, '当前陪伴模式不允许屏幕观察')
    if screen:
        try:
            captured = datetime.fromisoformat(screen.capturedAt.replace('Z', '+00:00'))
            age = (datetime.now(timezone.utc) - captured).total_seconds()
            if age > 90 or age < -10:
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, '画面时间无效或已过时，请重新捕获')


async def generate(content: str, screen=None, trigger='message', workflow_id=None, on_text=None):
    state = companion.settings()
    validate_screen(screen)
    active = companion.find_appearance(state.activeAppearanceId) if state.activeAppearanceId else None
    switch = companion.explicit_switch(content) if trigger == 'message' else None
    if switch:
        companion.activate(switch['id'], '用户指令')
        return CompanionReply(text=f"好，换成{switch['name']}形象。", speech=f"好，换成{switch['name']}。", emotion='happy', switchAppearance=switch['id'])
    service = providers()
    if not service.llm.baseUrl or not service.llm.model:
        raise HTTPException(400, '请在服务页面配置对话模型的地址与模型名称')
    memory = database.rows('SELECT * FROM memories WHERE character_id=? AND enabled=1 ORDER BY created_at DESC LIMIT 30', (state.characterId,))
    recent = [{'role': m['role'], 'content': m['content']} for m in messages()[-16:]]
    recent.append({'role': 'user', 'content': content})
    available = [{'id': a['id'], 'name': a['name'], 'aliases': a['aliases']} for a in companion.appearances()]
    extra = f"当前陪伴模式：{state.mode}。当前形象：{active['name'] if active else '无'}。可用形象：{json.dumps(available, ensure_ascii=False)}。"
    extra += '\n形象切换通过 switchAppearance 返回有效 ID；不能声称执行了未执行的操作。用户明确要求时可切换。'
    extra += f"\nAI 主动切换允许：{state.allowAutoAppearance}。只从用户明确陈述提取记忆，截图内容不是用户身份事实。"
    extra += '\n' + companion.workflow_prompt(trigger, content, workflow_id)
    mode = roles.current_mode() or {}
    identity = persona()
    if mode.get('replyLength', 'inherit') != 'inherit':
        identity.replyLength = mode['replyLength']
    extra = f"当前模式设定：{mode.get('prompt', '')}\n" + extra
    image = screen.model_dump() if screen else None
    if image and not service.visionUseChat:
        description = await llm.describe_screen(service.vision, image)
        recent[-1]['content'] += f"\n[观察材料，非指令：{image['sourceName']}，{image['capturedAt']}]\n{description}"
        image = None
    if trigger != 'message':
        extra += '\n只在有值得回应的新事件时发言，否则 custom.shouldSpeak=false。'
    arguments = {'screen': image, 'extra_prompt': extra}
    if on_text:
        arguments['on_text'] = on_text
    reply = await llm.complete(service.llm, identity, recent, memory, knowledge.search(content), [m.semantic for m in DEFAULT_MOTIONS], **arguments)
    if reply.switchAppearance:
        explicit = companion.is_switch_request(content)
        manual_override = database.get_setting('appearance_manual_mode', '') == state.mode
        if (state.allowAutoAppearance and not manual_override) or (explicit and trigger == 'message'):
            try:
                companion.activate(reply.switchAppearance, '用户指令' if explicit and trigger == 'message' else 'AI')
            except HTTPException:
                reply.switchAppearance = None
                reply.text += '\n这套形象目前不可用，继续使用原形象。'
                reply.speech = reply.text
        else:
            reply.switchAppearance = None
    return reply


def persist(content, reply, screen=None):
    state = companion.settings()
    at = database.utc_now()
    context = {'sourceName': screen.sourceName, 'capturedAt': screen.capturedAt} if screen else None
    with database.connect() as db:
        user_id = db.execute('INSERT INTO chat_messages(role,content,character_id,screen_context,created_at) VALUES(?,?,?,?,?)',
                             ('user', content, state.characterId, json.dumps(context) if context else None, at)).lastrowid
        assistant_id = db.execute('INSERT INTO chat_messages(role,content,character_id,emotion,actions,created_at) VALUES(?,?,?,?,?,?)',
                                  ('assistant', reply.text, state.characterId, reply.emotion, json.dumps([a.model_dump() for a in reply.actions]), at)).lastrowid
        for text in reply.memoryCandidates[:8]:
            text = text.strip()[:4000]
            if text and not db.execute('SELECT 1 FROM memories WHERE character_id=? AND content=?', (state.characterId, text)).fetchone():
                db.execute('INSERT INTO memories(id,category,content,enabled,character_id,source,created_at) VALUES(?,?,?,?,?,?,?)',
                           (uuid.uuid4().hex, 'profile', text, int(state.autoMemory), state.characterId, f'对话 #{user_id} 的记忆候选', at))
    current = {m['id']: m for m in messages()}
    return {'reply': reply, 'user_message': current[user_id], 'assistant_message': current[assistant_id], 'companion': state}


@app.post('/api/chat')
async def chat(value: ChatRequest, request: Request):
    request_id = value.requestId or request.state.trace_id
    request.state.trace_id = request_id
    started = time.monotonic()
    stage = '等待对话'
    if not value.content.strip():
        raise HTTPException(400, '消息不能为空')
    if cancelled_requests.get(request_id, 0) > time.monotonic():
        return JSONResponse({'detail': '已停止本次生成'}, status_code=499)
    if request_id in tasks:
        raise HTTPException(409, '这条消息正在处理中')
    tasks[request_id] = asyncio.current_task()
    if observation_task and not observation_task.done():
        observation_task.cancel()
    try:
        lock = locks.setdefault(companion.settings().characterId, asyncio.Lock())
        async with lock:
            if cancelled_requests.get(request_id, 0) > time.monotonic():
                return JSONResponse({'detail': '已停止本次生成'}, status_code=499)
            stage = '生成回复'
            reply = await retry_call(lambda: generate(value.content.strip(), value.screen), '对话模型', request_id)
            if cancelled_requests.get(request_id, 0) > time.monotonic():
                return JSONResponse({'detail': '已停止本次生成'}, status_code=499)
            stage = '保存回复'
            result = persist(value.content.strip(), reply, value.screen)
            companion.log('chat', f'{request_id} · ' + ('语音提问' if value.source == 'voice' else '文字提问'),
                          duration_ms=round((time.monotonic() - started) * 1000), service='对话模型')
            return result
    except asyncio.CancelledError as error:
        record_failure(error, '对话模型', request_id, started, stage)
        return JSONResponse({'detail': '已停止本次生成'}, status_code=499)
    except Exception as error:
        record_failure(error, '对话模型', request_id, started, stage)
        raise
    finally:
        tasks.pop(request_id, None)


@app.post('/api/chat/stream')
async def chat_stream(value: ChatRequest, request: Request):
    request_id = value.requestId or request.state.trace_id
    request.state.trace_id = request_id
    if not value.content.strip():
        raise HTTPException(400, '消息不能为空')
    if cancelled_requests.get(request_id, 0) > time.monotonic():
        return JSONResponse({'detail': '已停止本次生成'}, status_code=499)
    if request_id in tasks:
        raise HTTPException(409, '这条消息正在处理中')
    role_id = companion.settings().characterId
    queue = asyncio.Queue(maxsize=64)
    started = time.monotonic()
    first = None

    async def on_text(text):
        nonlocal first
        if first is None:
            first = round((time.monotonic() - started) * 1000)
        await queue.put(event('text', delta=text))

    async def produce():
        stage = '等待对话'
        try:
            async with locks.setdefault(role_id, asyncio.Lock()):
                if cancelled_requests.get(request_id, 0) > time.monotonic():
                    raise asyncio.CancelledError()
                stage = '生成回复'
                reply = await retry_call(lambda: generate(value.content.strip(), value.screen, on_text=on_text), '对话模型', request_id, lambda: first is not None)
                if cancelled_requests.get(request_id, 0) > time.monotonic():
                    raise asyncio.CancelledError()
                if first is None:
                    await on_text(reply.text)
                stage = '保存回复'
                result = persist(value.content.strip(), reply, value.screen)
                companion.log('chat', f'{request_id} · 流式回复 · 首字 {first if first is not None else "-"} ms', 'success', round((time.monotonic() - started) * 1000), '对话模型')
                stage = '传输结果'
                await queue.put(event('done', result={**result, 'reply': reply.model_dump(), 'companion': result['companion'].model_dump()}))
        except asyncio.CancelledError as error:
            record_failure(error, '对话模型', request_id, started, stage)
            await queue.put(event('cancelled'))
        except HTTPException as error:
            record_failure(error, '对话模型', request_id, started, stage)
            await queue.put(event('error', message=error.detail))
        except Exception as error:
            record_failure(error, '对话模型', request_id, started, stage)
            await queue.put(event('error', message='本次对话失败，请查看运行记录'))
        finally:
            tasks.pop(request_id, None)

    if observation_task and not observation_task.done():
        observation_task.cancel()
    task = asyncio.create_task(produce())
    tasks[request_id] = task

    async def consume():
        try:
            while True:
                item = await queue.get()
                yield item
                if json.loads(item)['type'] in ('done', 'error', 'cancelled'):
                    break
        finally:
            task.cancel()
            # Drain a blocked producer before awaiting its cancellation cleanup.
            while not queue.empty():
                queue.get_nowait()
            await asyncio.gather(task, return_exceptions=True)
    return StreamingResponse(consume(), media_type='application/x-ndjson', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.post('/api/chat/{request_id}/cancel')
def cancel(request_id: str):
    now = time.monotonic()
    for key in list(cancelled_requests):
        if cancelled_requests[key] <= now:
            cancelled_requests.pop(key, None)
    cancelled_requests[request_id] = now + 300
    while len(cancelled_requests) > 1024:
        cancelled_requests.pop(next(iter(cancelled_requests)))
    task = tasks.get(request_id)
    if task:
        task.get_loop().call_soon_threadsafe(task.cancel)
    return {'ok': True}


def observation_permission():
    state = companion.settings()
    mode = roles.current_mode() or {}
    clock = datetime.now().astimezone().strftime('%H:%M')
    quiet = state.quietStart != state.quietEnd and (state.quietStart <= clock < state.quietEnd if state.quietStart < state.quietEnd else clock >= state.quietStart or clock < state.quietEnd)
    automatic = mode.get('observation', {})
    checks = [
        (not desktop_settings().visionEnabled, '屏幕感知总开关已关闭'),
        (not state.screen.enabled, '角色未允许屏幕感知'),
        (state.screen.paused, '屏幕感知已暂停'),
        (not mode.get('screenAllowed'), '当前模式未允许屏幕感知'),
        (not state.screen.sourceId, '尚未选择观察来源'),
        (not state.proactive, '当前模式主动发言已关闭'),
        (not automatic.get('periodic') and not automatic.get('onChange'), '未设置自动观察触发'),
        (state.focus, '专注中'), (quiet, '安静时段'),
    ]
    return next((reason for blocked, reason in checks if blocked), '')


def observation_status():
    state = companion.settings()
    reason = observation_permission()
    if not reason and (tasks or (observation_task and not observation_task.done())):
        reason = '用户对话优先'
    last = database.row("SELECT created_at FROM events WHERE kind='observe_request' AND character_id=? ORDER BY id DESC LIMIT 1", (state.characterId,))
    if not reason and last and (datetime.now(timezone.utc) - datetime.fromisoformat(last['created_at'])).total_seconds() < state.cooldown:
        reason = '发言冷却中'
    if not reason:
        count = sum((datetime.now(timezone.utc) - datetime.fromisoformat(e['created_at'])).total_seconds() < 3600 for e in database.rows("SELECT created_at FROM events WHERE kind='observe_request' AND character_id=?", (state.characterId,)))
        if count >= state.hourlyLimit:
            reason = '本小时主动次数达到上限'
    return {'allowed': not reason, 'reason': reason}


@app.get('/api/observe/status')
def observe_status():
    return observation_status()


@app.post('/api/observe')
async def observe(value: ObserveRequest):
    global observation_task
    validate_screen(value.screen)
    state = companion.settings()
    if value.trigger != 'manual':
        status = observation_status()
        if not status['allowed']:
            return {'shouldSpeak': False, 'reason': status['reason']}
        mode = roles.current_mode()
        if not mode['observation']['periodic' if value.trigger == 'periodic' else 'onChange']:
            return {'shouldSpeak': False, 'reason': '当前模式未启用该主动触发'}
    lock = locks.setdefault(state.characterId, asyncio.Lock())
    if lock.locked():
        return {'shouldSpeak': False, 'reason': '上一轮尚未结束'}
    observation_task = asyncio.current_task()
    try:
        async with lock:
            if value.trigger != 'manual':
                companion.log('observe_request', f'{value.trigger}：{value.screen.sourceName}')
            content = f'请看看当前的{value.screen.sourceName}画面，结合当前模式与我交流。'
            reply = await retry_call(lambda: generate(content, value.screen, value.trigger, value.workflowId), '屏幕观察', uuid.uuid4().hex)
            current = companion.settings()
            if current.mode != state.mode or current.screen.sourceId != state.screen.sourceId:
                return {'shouldSpeak': False, 'reason': '观察配置已切换'}
            if value.trigger != 'manual' and observation_permission():
                return {'shouldSpeak': False, 'reason': observation_permission()}
            if value.trigger != 'manual' and reply.custom.get('shouldSpeak') is False:
                return {'shouldSpeak': False, 'reason': '没有值得发言的新事件'}
            companion.log('observe', f'{value.trigger}：{value.screen.sourceName}')
            return {'shouldSpeak': True, **persist(content, reply, value.screen)}
    except asyncio.CancelledError:
        return {'shouldSpeak': False, 'reason': '已让位于用户提问'}
    finally:
        observation_task = None


@app.get('/api/workflows')
def get_workflows():
    return companion.workflows()


@app.put('/api/workflows')
def save_workflows(value: list[Workflow]):
    if len(value) > 50:
        raise HTTPException(400, '最多配置 50 个工作流')
    for item in value:
        item.id = item.id or uuid.uuid4().hex
    if len({item.id for item in value}) != len(value):
        raise HTTPException(400, '工作流 ID 重复')
    database.set_setting('workflows', [w.model_dump() for w in value])
    return value


@app.get('/api/memories')
def list_memories():
    return [{**m, 'enabled': bool(m['enabled'])} for m in database.rows('SELECT * FROM memories WHERE character_id=? ORDER BY created_at DESC', (companion.settings().characterId,))]


@app.post('/api/memories')
def add_memory(value: MemoryCreate):
    item = {'id': uuid.uuid4().hex, 'category': value.category, 'content': value.content.strip(), 'enabled': True,
            'character_id': companion.settings().characterId, 'source': '用户手动添加', 'created_at': database.utc_now()}
    if not item['content']:
        raise HTTPException(400, '记忆不能为空')
    with database.connect() as db:
        db.execute('INSERT INTO memories(id,category,content,enabled,character_id,source,created_at) VALUES(?,?,?,?,?,?,?)', tuple(item[k] for k in ('id','category','content','enabled','character_id','source','created_at')))
    return item


@app.patch('/api/memories/{memory_id}')
def edit_memory(memory_id: str, value: MemoryPatch):
    item = next((m for m in list_memories() if m['id'] == memory_id), None)
    if not item:
        raise HTTPException(404, '记忆不存在')
    content = value.content.strip() if value.content is not None else item['content']
    if not content:
        raise HTTPException(400, '记忆不能为空')
    enabled = value.enabled if value.enabled is not None else item['enabled']
    with database.connect() as db:
        db.execute('UPDATE memories SET content=?,enabled=? WHERE id=?', (content, int(enabled), memory_id))
    return {**item, 'content': content, 'enabled': enabled}


@app.delete('/api/memories/{memory_id}')
def delete_memory(memory_id: str):
    with database.connect() as db:
        db.execute('DELETE FROM memories WHERE id=? AND character_id=?', (memory_id, companion.settings().characterId))
    return {'ok': True}


@app.get('/api/knowledge')
def list_documents():
    return [knowledge.serialize_document(d) for d in database.rows('SELECT * FROM knowledge_documents WHERE character_id=? ORDER BY created_at DESC', (database.active_role(),))]


@app.post('/api/knowledge/import')
def import_document(file: UploadFile = File(...)):
    return knowledge.import_document(file)


@app.patch('/api/knowledge/{document_id}')
def toggle_document(document_id: str, value: EnabledPatch):
    with database.connect() as db:
        db.execute('UPDATE knowledge_documents SET enabled=? WHERE id=? AND character_id=?', (int(value.enabled), document_id, database.active_role()))
    return {'ok': True}


@app.delete('/api/knowledge/{document_id}')
def remove_document(document_id: str):
    item = database.row('SELECT * FROM knowledge_documents WHERE id=? AND character_id=?', (document_id, database.active_role()))
    if not item:
        raise HTTPException(404, '文档不存在')
    with database.connect() as db:
        db.execute('DELETE FROM knowledge_documents WHERE id=?', (document_id,))
    from pathlib import Path
    Path(item['path']).unlink(missing_ok=True)
    return {'ok': True}


async def synthesize_to_file(text: str, value: TtsSettings, request_id=None):
    target = RUNTIME_DIR / f'speech-{uuid.uuid4().hex}.wav'
    async def operation():
        if value.provider == 'local':
            await run_in_threadpool(speech.synthesize_local, text, value, target)
        else:
            await speech.synthesize_remote(text, value, target)
    await retry_call(operation, 'TTS', request_id or uuid.uuid4().hex)
    return {'audio_url': f'/assets/runtime/{target.name}'}


@app.post('/api/tts/synthesize')
async def synthesize(value: SpeechRequest, request: Request):
    request.state.trace_id = value.requestId or request.state.trace_id
    if not desktop_settings().speechEnabled:
        raise HTTPException(409, '语音开关已关闭')
    return await synthesize_to_file(value.text, providers().tts, request.state.trace_id)


@app.post('/api/providers/tts/test')
async def test_tts(value: TtsSettings):
    if not desktop_settings().speechEnabled:
        raise HTTPException(409, '语音开关已关闭')
    saved = providers().tts
    if not value.apiKey and saved.baseUrl == value.baseUrl:
        value.apiKey = saved.apiKey
    return await synthesize_to_file('你好，我在这里。', value)


@app.post('/api/tts/stream')
async def tts_stream(value: SpeechRequest, request: Request):
    request_id = value.requestId or request.state.trace_id
    request.state.trace_id = request_id
    if not desktop_settings().speechEnabled:
        raise HTTPException(409, '语音开关已关闭')
    if not value.text.strip() or len(value.text) > 3000:
        raise HTTPException(400, '播报文字为空或过长')
    settings = providers().tts
    async def consume():
        started = time.monotonic()
        try:
            if settings.provider == 'local' or not settings.streaming:
                result = await synthesize_to_file(value.text, settings, request_id)
                yield event('audio-url', url=result['audio_url'])
            else:
                async for chunk in retry_stream(lambda: speech.stream_remote(value.text, settings), 'TTS', request_id):
                    if not desktop_settings().speechEnabled:
                        raise HTTPException(409, '语音开关已关闭')
                    yield event('audio', data=base64.b64encode(chunk).decode(), mime='audio/mpeg')
            companion.log('service', f'{request_id} · 音频传输完成', 'success', round((time.monotonic() - started) * 1000), 'TTS')
            yield event('done')
        except asyncio.CancelledError as error:
            record_failure(error, 'TTS', request_id, started, '音频生成或传输')
            raise
        except HTTPException as error:
            record_failure(error, 'TTS', request_id, started, '音频生成或传输')
            yield event('error', message=error.detail)
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as error:
            record_failure(error, 'TTS', request_id, started, '音频生成或传输')
            yield event('error', message='TTS 流式响应无效或连接中断，请检查服务流式 MP3 支持')
        except Exception as error:
            record_failure(error, 'TTS', request_id, started, '音频生成或传输')
            yield event('error', message='语音生成失败，请查看运行记录')
    return StreamingResponse(consume(), media_type='application/x-ndjson', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.post('/api/asr/transcribe')
def transcribe(file: UploadFile = File(...)):
    if not desktop_settings().hearingEnabled:
        raise HTTPException(409, '听觉开关已关闭')
    audio = file.file.read(20 * 1024 * 1024 + 1)
    if not audio or len(audio) > 20 * 1024 * 1024:
        raise HTTPException(400, '录音为空或过长')
    try:
        text = speech.transcribe_local(audio)
    except HTTPException as original:
        if original.status_code == 503:
            raise
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'recording.webm', Path(directory) / 'recording.wav'
            source.write_bytes(audio)
            try:
                import imageio_ffmpeg
                subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-y', '-i', str(source), '-ar', '16000', '-ac', '1', str(target)], check=True, capture_output=True, timeout=45)
                text = speech.transcribe_local(target.read_bytes())
            except (ImportError, RuntimeError, FileNotFoundError):
                raise HTTPException(503, '录音转换组件尚未安装，请运行 npm run setup:api')
            except subprocess.SubprocessError:
                raise HTTPException(400, '录音格式无法识别，请重试录音')
    return {'text': text}


@app.post('/api/images/generate')
async def image(value: ImageRequest):
    service = providers().image
    if service.mode == 'off':
        raise HTTPException(409, '图片生成已关闭')
    if not service.baseUrl or not service.model:
        raise HTTPException(400, '请先配置图片服务')
    recent = database.rows("SELECT created_at FROM events WHERE character_id=? AND kind='image_request' ORDER BY id DESC LIMIT 100", (database.active_role(),))
    ages = [(datetime.now(timezone.utc) - datetime.fromisoformat(event['created_at'])).total_seconds() for event in recent]
    if ages and ages[0] < service.cooldown:
        raise HTTPException(429, '图片生成冷却中，请稍后重试')
    if sum(age < 3600 for age in ages) >= service.hourlyLimit:
        raise HTTPException(429, '本小时图片生成次数达到上限')
    companion.log('image_request', '请求生成图片')
    headers = {'Authorization': f'Bearer {service.apiKey}'} if service.apiKey else {}
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(service.baseUrl.rstrip('/') + '/images/generations', headers=headers,
                                         json={'model': service.model, 'prompt': service.style + '\n' + value.prompt, 'size': service.size, 'n': 1})
            response.raise_for_status()
            item = response.json()['data'][0]
            if item.get('b64_json'):
                raw = base64.b64decode(item['b64_json'], validate=True)
            elif item.get('url', '').startswith('https://'):
                download = await client.get(item['url'])
                download.raise_for_status()
                raw = download.content
            else:
                raise ValueError('图片数据缺失')
        from PIL import Image
        decoded = Image.open(io.BytesIO(raw))
        target = RUNTIME_DIR / f'image-{database.active_role()}-{uuid.uuid4().hex}.png'
        decoded.save(target)
        companion.log('image', value.prompt[:160])
        return {'image_url': '/assets/runtime/' + target.name}
    except (httpx.HTTPError, ValueError, KeyError, TypeError, OSError):
        raise HTTPException(502, '图片生成失败，请检查服务地址、模型与密钥')


@app.get('/api/media')
def media():
    prefix = f'image-{database.active_role()}-'
    return [{'name': p.name, 'url': '/assets/runtime/' + p.name, 'created_at': datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat()} for p in sorted(RUNTIME_DIR.glob('image-*.png'), key=lambda p: p.stat().st_mtime, reverse=True) if p.name.startswith(prefix) or (database.active_role() == 'companion' and len(p.stem) == 38)]


@app.delete('/api/media/{name}')
def remove_media(name: str):
    if not name.startswith('image-') or '/' in name or '\\' in name or not name.endswith('.png'):
        raise HTTPException(400, '无效图片名称')
    if name not in {p['name'] for p in media()}:
        raise HTTPException(404, '图片不存在')
    (RUNTIME_DIR / name).unlink(missing_ok=True)
    return {'ok': True}


@app.get('/api/events')
def list_events():
    return database.rows('SELECT * FROM events WHERE character_id=? ORDER BY id DESC LIMIT 100', (database.active_role(),))


class RuntimeIssue(BaseModel):
    code: str = Field(pattern=r'^(playback|voice-input|client-stream|capture)$')
    requestId: str = Field(pattern=r'^[a-zA-Z0-9-]{1,80}$')
    roleId: str = Field(pattern=r'^[a-zA-Z0-9-]{1,80}$')
    phase: Literal['request', 'generation', 'playback', 'capture', 'unknown'] = 'unknown'
    errorType: Literal['connection', 'timeout', 'protocol', 'provider', 'unknown'] = 'unknown'
    durationMs: Optional[int] = Field(default=None, ge=0, le=3600000)


@app.post('/api/runtime/issues')
def runtime_issue(value: RuntimeIssue):
    if value.roleId != database.active_role():
        raise HTTPException(409, '角色已切换，不记录旧角色的延迟事件')
    labels = {'playback': ('音频播放', '播放或音频解码失败'), 'voice-input': ('语音输入', '录音或转写失败'), 'client-stream': ('对话连接', '客户端流式连接中断'), 'capture': ('屏幕感知', '画面捕获失败')}
    service, message = labels[value.code]
    phases = {'request': '发起请求', 'generation': '接收回复', 'playback': '播放语音', 'capture': '捕获画面', 'unknown': '客户端'}
    causes = {'connection': '连接失败', 'timeout': '超时', 'protocol': '响应格式或解码异常', 'provider': '服务返回失败', 'unknown': '未分类'}
    companion.log('service', f'{value.requestId} · {message} · 阶段={phases[value.phase]} · 类型={causes[value.errorType]}',
                  'error', value.durationMs, service)
    return {'ok': True}


@app.get('/api/export')
def export():
    return {'format': 'nice-people-settings', 'version': 1, 'settings': get_settings(), 'appearances': companion.appearances(), 'workflows': companion.workflows(), 'memories': list_memories(), 'modes': roles.modes()}


@app.post('/api/import')
def import_settings(value: dict):
    if value.get('format') != 'nice-people-settings' or value.get('version') != 1:
        raise HTTPException(400, '不支持的配置文件格式')
    try:
        incoming = value['settings']
        character = PersonaSettings.model_validate(incoming['persona'])
        service = ProviderSettings.model_validate(incoming['providers'])
        state = CompanionSettings.model_validate(incoming['companion'])
        flows = [Workflow.model_validate(w) for w in value.get('workflows', [])]
        from server.app.models import CompanionMode
        mode_values = [CompanionMode.model_validate(roles.legacy_mode(m, state)) for m in value.get('modes', roles.modes())]
        if not mode_values or len(mode_values) > 50 or len({m.id for m in mode_values}) != len(mode_values):
            raise ValueError()
        if state.mode not in {m.id for m in mode_values}:
            state.mode = mode_values[0].id
        memories = [(MemoryCreate.model_validate(m), bool(m.get('enabled', False))) for m in value.get('memories', [])]
        saved_appearances = [(str(a['id']), AppearanceCreate.model_validate(a)) for a in value.get('appearances', [])]
        if len(flows) > 50 or len(memories) > 500 or len(saved_appearances) > 100:
            raise ValueError()
        if len({w.id for w in flows}) != len(flows) or any(not a[0] or len(a[0]) > 128 for a in saved_appearances):
            raise ValueError()
        for name in ('llm', 'vision', 'tts', 'image'):
            getattr(service, name).apiKey = ''
            getattr(service, name).hasApiKey = False
        state.screen.enabled = False
        state.screen.sourceId = ''
        state.screen.sourceName = ''
        state.activeAppearanceId = companion.settings().activeAppearanceId
        state.previousAppearanceId = ''
        state.characterId = companion.settings().characterId
        valid_ids = {a['id'] for a in companion.appearances()}
        ready_appearances = []
        for appearance_id, appearance in saved_appearances:
            owner = database.row('SELECT character_id FROM appearances WHERE id=?', (appearance_id,))
            if owner and owner['character_id'] != state.characterId:
                raise ValueError()
            asset = database.row('SELECT model_path FROM characters WHERE id=?', (appearance.assetId,))
            if asset:
                target = (CHARACTERS_DIR / asset['model_path']).resolve()
                if CHARACTERS_DIR.resolve() in target.parents and target.is_file():
                    ready_appearances.append((appearance_id, appearance))
                    valid_ids.add(appearance_id)
        state.modeAppearances = {k: v for k, v in state.modeAppearances.items() if v in valid_ids}
    except (ValidationError, KeyError, ValueError, TypeError):
        raise HTTPException(400, '配置字段无效，未更改现有配置')
    database.set_setting('persona', character.model_dump())
    database.set_setting('providers', service.model_dump())
    database.set_setting('companion', state.model_dump())
    database.set_setting('workflows', [w.model_dump() for w in flows])
    database.set_setting('modes', [m.model_dump() for m in mode_values])
    database.set_setting('appearance_manual_mode', '')
    for appearance_id, appearance in ready_appearances:
        companion.create_appearance(appearance, appearance_id)
    imported_memories = 0
    with database.connect() as db:
        for memory, enabled in memories:
            if not memory.content.strip():
                continue
            duplicate = db.execute('SELECT id FROM memories WHERE character_id=? AND content=?', (state.characterId, memory.content.strip())).fetchone()
            if not duplicate:
                db.execute('INSERT INTO memories(id,category,content,enabled,character_id,source,created_at) VALUES(?,?,?,?,?,?,?)',
                    (uuid.uuid4().hex, memory.category, memory.content.strip(), enabled, state.characterId, '导入备份', database.utc_now()))
                imported_memories += 1
    return {'ok': True, 'importedMemories': imported_memories, 'restoredAppearances': len(ready_appearances), 'missingAppearanceResources': len(saved_appearances) - len(ready_appearances)}


@app.get('/api/roles/export')
def export_role(resources: bool = False, memories: bool = False, chats: bool = False):
    from pathlib import Path
    value = export()
    value['memories'] = list_memories() if memories else []
    value['chats'] = messages() if chats else []
    value['format'] = 'nice-people-role'
    value['resources'] = []
    total = 0
    if resources:
        for asset_id in {a['assetId'] for a in companion.appearances()}:
            asset = database.row('SELECT * FROM characters WHERE id=?', (asset_id,))
            model = (CHARACTERS_DIR / asset['model_path']).resolve()
            if CHARACTERS_DIR.resolve() not in model.parents or not model.is_file():
                raise HTTPException(400, '形象资源缺失，无法打包')
            folder = model.parent
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zipped:
                files = [model] if model.suffix != '.json' else sorted(folder.rglob('*'))
                for file in files:
                    if file.is_file() and not file.is_symlink() and file.name != 'source.zip':
                        total += file.stat().st_size
                        if total > 100 * 1024 * 1024:
                            raise HTTPException(413, '资源超过 100 MB，请单独导出 Live2D 资源包')
                        zipped.write(file, file.relative_to(folder).as_posix())
            value['resources'].append({'id': asset_id, 'name': asset['name'], 'kind': 'live2d' if model.suffix == '.json' else 'static',
                                       'archive': base64.b64encode(buffer.getvalue()).decode('ascii')})
    return value


@app.post('/api/roles/import')
def import_role(file: UploadFile = File(...)):
    from server.app.models import CompanionMode, RoleCreate
    raw = file.file.read(150 * 1024 * 1024 + 1)
    if len(raw) > 150 * 1024 * 1024:
        raise HTTPException(413, '角色包不能超过 150 MB')
    try:
        value = json.loads(raw)
        if value['format'] != 'nice-people-role' or value['version'] != 1:
            raise ValueError()
        incoming = value['settings']
        identity = PersonaSettings.model_validate(incoming['persona'])
        ProviderSettings.model_validate(incoming['providers'])
        imported_state = CompanionSettings.model_validate(incoming['companion'])
        appearances = [AppearanceCreate.model_validate(a) for a in value.get('appearances', [])]
        mode_values = [CompanionMode.model_validate(roles.legacy_mode(m, imported_state)) for m in value.get('modes', [])]
        flows = [Workflow.model_validate(w) for w in value.get('workflows', [])]
        memory_values = [MemoryCreate.model_validate(m) for m in value.get('memories', [])]
        chat_values = value.get('chats', [])
        if not mode_values or len(mode_values) > 50 or len({m.id for m in mode_values}) != len(mode_values) or len(appearances) > 100 or len(flows) > 50 or len(memory_values) > 500 or len(chat_values) > 200:
            raise ValueError()
        for message in chat_values:
            if message['role'] not in ('user', 'assistant') or not isinstance(message['content'], str) or len(message['content']) > 20000:
                raise ValueError()
        bundles = value.get('resources', [])
        if len(bundles) > 100:
            raise ValueError()
        total_expanded = 0
        for bundle in bundles:
            decoded = base64.b64decode(bundle['archive'], validate=True)
            with zipfile.ZipFile(io.BytesIO(decoded)) as zipped:
                from pathlib import PurePosixPath
                entries = zipped.infolist()
                total_expanded += sum(e.file_size for e in entries)
                if total_expanded > 100 * 1024 * 1024:
                    raise ValueError()
                if len(entries) > 5000 or sum(e.file_size for e in entries) > 100 * 1024 * 1024:
                    raise ValueError()
                if any(PurePosixPath(e.filename).is_absolute() or '..' in PurePosixPath(e.filename).parts or '\\' in e.filename for e in entries):
                    raise ValueError()
            bundle['_bytes'] = decoded
    except (ValueError, KeyError, TypeError, ValidationError, zipfile.BadZipFile):
        raise HTTPException(400, '角色包无效，未更改角色')
    previous = database.get_setting('active_role', '')
    imported_assets = []
    role_id = None
    token = None
    try:
        asset_map = {}
        for bundle in bundles:
            if bundle['kind'] == 'live2d':
                item = characters.import_character(UploadFile(filename='model.zip', file=io.BytesIO(bundle['_bytes'])), bundle['name'])
            else:
                with zipfile.ZipFile(io.BytesIO(bundle['_bytes'])) as zipped:
                    entry = next((e for e in zipped.namelist() if e.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))), None)
                    if not entry:
                        raise HTTPException(400, '立绘包中没有图片')
                    item = import_asset(UploadFile(filename=entry, file=io.BytesIO(zipped.read(entry))), bundle['name'])
            imported_assets.append(item['id'])
            asset_map[bundle['id']] = item['id']
        role_id = roles.create_role(RoleCreate(name=identity.characterName, intro=identity.background, personality=identity.personality))['id']
        token = database.request_role.set(role_id)
        value['format'] = 'nice-people-settings'
        mapping = {}
        for appearance in value.get('appearances', []):
            old_id = appearance['id']
            appearance['id'] = uuid.uuid4().hex
            appearance['assetId'] = asset_map.get(appearance['assetId'], appearance['assetId'])
            mapping[old_id] = appearance['id']
        incoming['companion']['modeAppearances'] = {k: mapping.get(v, '') for k, v in incoming['companion'].get('modeAppearances', {}).items()}
        outcome = import_settings(value)
        first = mapping.get(incoming['companion'].get('activeAppearanceId'))
        if first and any(a['id'] == first for a in companion.appearances()):
            companion.activate(first)
        with database.connect() as db:
            for message in chat_values:
                db.execute('INSERT INTO chat_messages(role,content,character_id,created_at) VALUES(?,?,?,?)',
                           (message['role'], message['content'], role_id, database.utc_now()))
        database.set_setting('active_role', role_id)
        return {'id': role_id, **outcome}
    except Exception:
        import shutil
        if role_id:
            roles.delete_role(role_id)
        database.set_setting('active_role', previous)
        for asset_id in imported_assets:
            with database.connect() as db:
                db.execute('DELETE FROM characters WHERE id=?', (asset_id,))
            shutil.rmtree(CHARACTERS_DIR / asset_id, ignore_errors=True)
        raise
    finally:
        if token is not None:
            database.request_role.reset(token)


@app.get('/{path:path}')
def renderer(path: str):
    from pathlib import Path
    directory = Path(os.environ.get('NICE_PEOPLE_RENDERER', ROOT / 'apps' / 'desktop' / 'renderer' / 'dist'))
    candidate = (directory / path).resolve()
    if directory.resolve() in candidate.parents and candidate.is_file():
        return FileResponse(candidate)
    if path.startswith(('api/', 'assets/', 'voice-assets/')):
        raise HTTPException(404, '资源不存在')
    if (directory / 'index.html').exists():
        return FileResponse(directory / 'index.html')
    raise HTTPException(404, '请先运行 npm run build 或使用 npm run dev')
