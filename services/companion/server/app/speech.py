import io
import os
import tarfile
import urllib.request
from pathlib import Path
from typing import Dict
from functools import lru_cache
from threading import RLock
from urllib.parse import urlsplit, urlunsplit

import httpx
import soundfile as sf
import numpy as np
from fastapi import HTTPException

from server.app.models import TtsSettings
from server.app.streaming import sse_data
import json


from server.app.config import MODELS_DIR, RUNTIME_DIR
def model_directory(name, filename):
    local = MODELS_DIR / name
    bundled = Path(os.environ.get('NICE_PEOPLE_BUNDLED_SPEECH', MODELS_DIR)) / name
    return local if (local / filename).exists() or not (bundled / filename).exists() else bundled


TTS_MODEL_DIR = model_directory("kokoro-multi-lang-v1_1", "model.onnx")
ASR_MODEL_DIR = model_directory("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", "model.int8.onnx")
TTS_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2"
ASR_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
SPEAKER_IDS: Dict[str, int] = {"zf_xiaobei": 45, "zf_xiaoni": 46, "zf_xiaoxiao": 47, "zf_xiaoyi": 48, "zm_yunjian": 49, "zm_yunxi": 50, "zm_yunxia": 51, "zm_yunyang": 52}
_engine_lock = RLock()
_tts_lock = RLock()


@lru_cache(maxsize=4)
def asr_engine(directory: str, language: str):
    import sherpa_onnx
    root = Path(directory)
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(root / 'model.int8.onnx'), tokens=str(root / 'tokens.txt'),
        use_itn=True, num_threads=4, language='' if language == 'auto' else language,
    )


def ensure_model(model: str) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if model == "tts" and (TTS_MODEL_DIR / "model.onnx").exists():
        return
    if model == "asr" and (ASR_MODEL_DIR / "model.int8.onnx").exists():
        return
    url = TTS_URL if model == "tts" else ASR_URL
    archive = MODELS_DIR / ("kokoro.tar.bz2" if model == "tts" else "sensevoice.tar.bz2")
    try:
        urllib.request.urlretrieve(url, archive)
        with tarfile.open(archive, "r:bz2") as compressed:
            members = compressed.getmembers()
            for member in members:
                target = (MODELS_DIR / member.name).resolve()
                if MODELS_DIR.resolve() not in target.parents or member.issym() or member.islnk():
                    raise RuntimeError("语音模型压缩包包含不安全的文件路径")
            compressed.extractall(MODELS_DIR, members=members)
    finally:
        archive.unlink(missing_ok=True)


@lru_cache(maxsize=2)
def tts_engine(directory: str):
    import sherpa_onnx
    root = Path(directory)
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(root / "model.onnx"),
                voices=str(root / "voices.bin"),
                tokens=str(root / "tokens.txt"),
                data_dir=str(root / "espeak-ng-data"),
                lexicon=",".join([str(root / "lexicon-us-en.txt"), str(root / "lexicon-zh.txt")]),
            ),
            provider="cpu",
            num_threads=4,
        ),
        rule_fsts=",".join([str(root / "date-zh.fst"), str(root / "number-zh.fst")]),
        max_num_sentences=1,
    )
    if not config.validate():
        raise RuntimeError("本地 TTS 配置无效")
    return sherpa_onnx.OfflineTts(config)


def synthesize_local(text: str, settings: TtsSettings, output: Path) -> str:
    if not (TTS_MODEL_DIR / "model.onnx").exists():
        raise HTTPException(503, "本地 TTS 模型尚未安装，请运行 npm run setup:speech")
    try:
        import sherpa_onnx

        with _tts_lock:
            engine = tts_engine(str(TTS_MODEL_DIR))
        generation = sherpa_onnx.GenerationConfig()
        generation.sid = SPEAKER_IDS.get(settings.voice, 45)
        generation.speed = settings.speed
        generation.silence_scale = 0.2
        with _tts_lock:
            audio = engine.generate(text, generation)
        sf.write(output, audio.samples, audio.sample_rate, subtype="PCM_16")
        return "sherpa-onnx"
    except Exception as error:
        raise HTTPException(500, f"本地 TTS 生成失败：{error}") from error


def remote_request(text: str, settings: TtsSettings, streaming=False):
    if not settings.baseUrl:
        raise HTTPException(400, "请配置 TTS Base URL")
    try:
        address = urlsplit(settings.baseUrl.strip())
        if address.scheme in {"ws", "wss"}:
            raise HTTPException(400, "这是 WebSocket 地址，当前 TTS 使用 HTTP 接口。MiniMax 请选 MiniMax（HTTP），并填写 https:// 开头的 /v1/t2a_v2 地址，不要填写 /ws/ 路径。")
        if address.scheme not in {"http", "https"} or not address.hostname or address.username or address.password or address.fragment:
            raise ValueError("invalid HTTP address")
        address.port
    except ValueError as error:
        raise HTTPException(400, "TTS API 地址无效，请填写完整的 http:// 或 https:// 接口地址") from error
    path = address.path.rstrip("/")
    if settings.provider == "minimax":
        if not settings.apiKey:
            raise HTTPException(400, "请填写 MiniMax API Key")
        if not settings.model.strip() or not settings.voice.strip():
            raise HTTPException(400, "请填写 MiniMax 模型名称和音色 ID（voice_id）")
        if path in {"", "/v1"}:
            path = "/v1/t2a_v2"
        elif "/ws/" in path or not path.endswith("/v1/t2a_v2"):
            raise HTTPException(400, "MiniMax HTTP 接口路径应为 /v1/t2a_v2，不能使用 /ws/ 或 /audio/speech")
        payload = {
            "model": settings.model, "text": text, "stream": streaming, "output_format": "hex",
            "voice_setting": {"voice_id": settings.voice, "speed": settings.speed, "vol": 1, "pitch": 0},
            "audio_setting": {"sample_rate": 32000, "format": 'mp3' if streaming else "wav", "channel": 1},
        }
    else:
        if not path.endswith("/audio/speech"):
            path += "/audio/speech"
        payload = {"model": settings.model, "voice": settings.voice, "input": text, "speed": settings.speed, "response_format": 'mp3' if streaming else "wav"}
    url = urlunsplit(address._replace(path=path))
    headers = {"Content-Type": "application/json"}
    if settings.apiKey:
        headers["Authorization"] = f"Bearer {settings.apiKey}"
    return url, headers, payload


async def stream_remote(text: str, settings: TtsSettings):
    url, headers, payload = remote_request(text, settings, True)
    received = 0
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            async with client.stream('POST', url, headers=headers, json=payload) as response:
                response.raise_for_status()
                if settings.provider == 'minimax':
                    if 'text/event-stream' not in response.headers.get('content-type', ''):
                        raise HTTPException(502, 'MiniMax 没有返回流式音频，请检查 HTTP 接口与模型')
                    async for data in sse_data(response):
                        if data == '[DONE]':
                            break
                        result = json.loads(data)
                        status = result.get('base_resp', {}).get('status_code', 0)
                        if status != 0:
                            raise HTTPException(502, f'MiniMax 流式 TTS 调用失败（{status}），请检查账户、模型及音色')
                        audio = result.get('data') or {}
                        # MiniMax's final status=2 packet contains the aggregated audio.
                        if audio.get('status') == 2 and received:
                            continue
                        if audio.get('audio'):
                            chunk = bytes.fromhex(audio['audio'])
                            received += len(chunk)
                            if received > 32 * 1024 * 1024:
                                raise ValueError('audio too large')
                            yield chunk
                else:
                    mime = response.headers.get('content-type', '')
                    if 'json' in mime or 'text/' in mime or 'wav' in mime:
                        raise HTTPException(502, '此 TTS 服务没有返回 MP3 音频流，请关闭流式回复或使用兼容服务')
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
                        if received > 32 * 1024 * 1024:
                            raise ValueError('audio too large')
                        yield chunk
                if not received:
                    raise HTTPException(502, 'TTS 返回了空音频')
    except httpx.HTTPStatusError as error:
        raise HTTPException(502, f'TTS 流式调用失败（HTTP {error.response.status_code}），请检查接入地址、密钥及额度') from error


async def synthesize_remote(text: str, settings: TtsSettings, output: Path) -> str:
    url, headers, payload = remote_request(text, settings)
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        message = {401: "密钥无效，请检查 API Key", 403: "没有调用权限，请检查服务授权", 404: "接口不存在，请检查接入类型和 HTTP 接口地址", 429: "调用受限，请检查额度或稍后重试"}.get(status, "服务请求失败，请检查服务状态")
        raise HTTPException(502, f"第三方 TTS 调用失败（HTTP {status}）：{message}") from error
    except httpx.HTTPError as error:
        raise HTTPException(502, "第三方 TTS 连接失败，请检查网络和 HTTP 接口地址") from error
    audio = response.content
    if settings.provider == "minimax":
        try:
            result = response.json()
            status = result.get("base_resp")
            if not isinstance(status, dict) or "status_code" not in status:
                raise ValueError("missing status")
            if status["status_code"] != 0:
                code = str(status["status_code"])[:30]
                message = str(status.get("status_msg") or "请检查模型、音色、密钥及账户额度")
                message = message.replace(settings.apiKey, "[已隐藏]")
                raise HTTPException(502, f"MiniMax TTS 调用失败（{code}）：{message[:200]}")
            data = result.get("data")
            encoded = data.get("audio") if isinstance(data, dict) else None
            if not isinstance(encoded, str) or not encoded:
                raise ValueError("missing audio")
            audio = bytes.fromhex(encoded)
            if not audio:
                raise ValueError("empty audio")
        except (ValueError, AttributeError, TypeError) as error:
            raise HTTPException(502, "MiniMax TTS 返回的音频格式无效，应为非流式 hex 音频") from error
    output.write_bytes(audio)
    return settings.provider


def transcribe_local(audio_bytes: bytes) -> str:
    if not (ASR_MODEL_DIR / "model.int8.onnx").exists():
        raise HTTPException(503, "本地 ASR 模型尚未安装，请运行 npm run setup:speech")
    try:
        import sherpa_onnx

        data, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
        if not np.isfinite(data).all():
            raise HTTPException(400, '录音包含无效的音频数据')
        if len(data) < sample_rate * .25 or float(np.sqrt(np.mean(data.astype('float64') ** 2))) < .0008:
            return ''
        from server.app import database
        language = database.get_setting('providers', {}).get('asr', {}).get('language', 'auto')
        with _engine_lock:
            recognizer = asr_engine(str(ASR_MODEL_DIR), language)
            stream = recognizer.create_stream()
            stream.accept_waveform(sample_rate, data[:, 0])
            recognizer.decode_stream(stream)
            return stream.result.text.strip()
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"本地 ASR 识别失败：{error}") from error
