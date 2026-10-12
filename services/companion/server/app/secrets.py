import json
import os
from pathlib import Path


from server.app.config import LOCAL_ROOT

FALLBACK_PATH = LOCAL_ROOT / "secrets.json"
SERVICE = "nice-people-v1"


def get_secret(name: str) -> str:
    try:
        import keyring

        return keyring.get_password(SERVICE, name) or ""
    except Exception:
        if not FALLBACK_PATH.exists():
            return ""
        return json.loads(FALLBACK_PATH.read_text(encoding="utf-8")).get(name, "")


def set_secret(name: str, value: str) -> None:
    try:
        import keyring

        if value:
            keyring.set_password(SERVICE, name, value)
        else:
            try:
                keyring.delete_password(SERVICE, name)
            except Exception:
                pass
        return
    except Exception:
        FALLBACK_PATH.parent.mkdir(parents=True, exist_ok=True)
        secrets = json.loads(FALLBACK_PATH.read_text(encoding="utf-8")) if FALLBACK_PATH.exists() else {}
        if value:
            secrets[name] = value
        else:
            secrets.pop(name, None)
        FALLBACK_PATH.write_text(json.dumps(secrets), encoding="utf-8")
        os.chmod(FALLBACK_PATH, 0o600)
