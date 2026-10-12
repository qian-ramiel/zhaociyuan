import re
from urllib.parse import urlsplit

from fastapi import HTTPException


TRANSIENT_STATUSES = (408, 429, 500, 502, 503, 504)
STARTUP_CODES = {'model_loading', 'model_not_ready', 'model_startup_failed', 'model_load_failed',
                 'model_initialization_failed', 'model_unavailable', 'failed_to_load_model'}
PERMANENT_CODES = {'invalid_api_key', 'authentication_error', 'permission_denied', 'model_not_found',
                   'invalid_model', 'insufficient_quota', 'context_length_exceeded', 'out_of_memory'}
TRANSIENT_CODES = {'rate_limit_exceeded', 'server_error', 'temporarily_unavailable', 'overloaded_error'}


def redact(value):
    value = re.sub(r'(?:https?|wss?)://\S+', '[接口地址]', str(value))
    return re.sub(r'(?i)(?:bearer\s+\S+|sk-[\w-]+)', '[密钥]', value)


def provider_context(settings, stage):
    try:
        address = urlsplit(settings.baseUrl)
        host = address.hostname or '无效地址'
        if address.port:
            host += ':' + str(address.port)
    except ValueError:
        host = '无效地址'
    return f'阶段={stage} · 接入={settings.provider} · 模型={redact(settings.model)[:120]} · 主机={host}'


class ProviderFailure(HTTPException):
    def __init__(self, service, status, payload):
        error = payload.get('error', payload) if isinstance(payload, dict) else payload
        if isinstance(error, dict):
            code = str(error.get('code') or error.get('type') or '').lower()
            message = str(error.get('message') or error.get('detail') or '')
        else:
            code, message = '', str(error or '')
        # Classify provider text without persisting it: gateways can echo prompts and credentials.
        permanent = code in PERMANENT_CODES or bool(re.search(
            r'out of memory|insufficient (?:memory|quota)|model (?:does not exist|not found)|'
            r'unknown model|invalid (?:model|api.?key)|模型不存在|显存不足|内存不足|额度不足', message, re.I))
        startup = code in STARTUP_CODES or bool(re.search(
            r'failed to (?:load|start|initialize)(?: the)? model|model (?:is |still )?(?:loading|starting|not ready)|'
            r'model.*(?:startup|initialization) failed|模型(?:启动|加载|初始化)(?:失败|中|尚未完成)', message, re.I))
        self.retryable = not permanent and (status in TRANSIENT_STATUSES or
                                           (status in (200, 400, 409, 422) and startup) or
                                           (status == 200 and code in TRANSIENT_CODES))
        self.startup = startup and self.retryable
        known_code = code if code in STARTUP_CODES | PERMANENT_CODES | TRANSIENT_CODES else ''
        if status in (401, 403):
            reason = '密钥或授权不可用'
        elif status == 404:
            reason = '接口或模型不存在'
        else:
            reason = '模型启动或加载暂时失败' if startup and not permanent else '模型资源、额度或配置不可用' if permanent else '上游服务调用失败'
        code_text = f' · 错误码={known_code}' if known_code else ''
        super().__init__(502, f'{service}：{reason}（上游 HTTP {status}{code_text}）')
