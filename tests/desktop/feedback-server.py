"""Isolated API for headless feedback regression; no keychain or user assets."""
import sys

import uvicorn

from server.app import companion, secrets
from server.app.api import app

stored = {}
secrets.get_secret = lambda key: stored.get(key, '')
secrets.set_secret = lambda key, value: stored.update({key: value})
companion.seed_legacy_assets = lambda: None

uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
