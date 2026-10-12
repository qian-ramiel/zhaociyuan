import asyncio
import time

import httpx
from fastapi import HTTPException

from server.app import companion
from server.app.provider_errors import ProviderFailure, redact


class StreamInterrupted(HTTPException):
    def __init__(self):
        super().__init__(502, '模型流式响应中断，请重试')


def transient(error):
    # Inspect the original provider error, not the gateway's generic HTTP 502.
    cause = error
    while True:
        if isinstance(cause, ProviderFailure):
            return cause.retryable
        if cause.__cause__ is None:
            break
        cause = cause.__cause__
    if isinstance(cause, httpx.HTTPStatusError):
        return cause.response.status_code in (408, 429, 500, 502, 503, 504)
    return isinstance(cause, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError, StreamInterrupted))


def summary(error):
    if isinstance(error, HTTPException) and isinstance(error.detail, (list, dict)):
        return '参数验证失败'
    value = str(error.detail) if isinstance(error, HTTPException) else type(error).__name__
    causes, cause = [], error
    while cause is not None and len(causes) < 5:
        causes.append(type(cause).__name__)
        cause = cause.__cause__
    context = getattr(error, 'provider_context', '')
    return redact(value)[:500] + ' · 异常=' + '/'.join(causes) + (' · ' + context if context else '')


def record_failure(error, service, request_id, started, stage):
    if getattr(error, 'runtime_recorded', False):
        return
    cancelled = isinstance(error, asyncio.CancelledError)
    companion.log('service', f'{request_id} · 阶段={stage} · ' + ('已停止，不重试' if cancelled else summary(error)),
                  'cancelled' if cancelled else 'error', round((time.monotonic() - started) * 1000), service)
    error.runtime_recorded = True


async def retry_stream(factory, service, request_id, started_output=lambda: False):
    started = time.monotonic()
    emitted = False
    for attempt in range(3):
        try:
            async for item in factory():
                emitted = True
                yield item
            if attempt:
                companion.log('service', f'{request_id} · 重试后恢复', 'success', round((time.monotonic() - started) * 1000), service)
            return
        except asyncio.CancelledError as error:
            record_failure(error, service, request_id, started, '服务调用')
            raise
        except Exception as error:
            retrying = not emitted and not started_output() and transient(error) and attempt < 2 and time.monotonic() - started < 120
            detail = f'{request_id} · 阶段=服务调用 · 尝试 {attempt + 1}/3 · {summary(error)}'
            if not retrying:
                if emitted or started_output():
                    detail += ' · 已开始输出，不重复播放或生成'
                companion.log('service', detail, 'error', round((time.monotonic() - started) * 1000), service)
                error.runtime_recorded = True
                raise
            companion.log('service', detail + f' · 自动重试 {attempt + 1}/2', 'retry', round((time.monotonic() - started) * 1000), service)
            try:
                await asyncio.sleep(((1.0, 3.0) if getattr(error, 'startup', False) else (0.4, 1.0))[attempt])
            except asyncio.CancelledError as stopped:
                record_failure(stopped, service, request_id, started, '重试等待')
                raise


async def retry_call(operation, service, request_id, started_output=lambda: False):
    async def single():
        yield await operation()
    result = None
    async for value in retry_stream(single, service, request_id, started_output):
        result = value
    return result
