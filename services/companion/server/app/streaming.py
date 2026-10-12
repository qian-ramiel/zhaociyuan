import json


async def sse_data(response):
    parts = []
    size = 0
    async for line in response.aiter_lines():
        if not line:
            if parts:
                yield '\n'.join(parts)
            parts, size = [], 0
        elif line.startswith('data:'):
            part = line[5:].lstrip(' ')
            size += len(part)
            if size > 2_000_000:
                raise ValueError('stream event too large')
            parts.append(part)
    if parts:
        yield '\n'.join(parts)


def event(kind, **values):
    return json.dumps({'type': kind, **values}, ensure_ascii=False) + '\n'
