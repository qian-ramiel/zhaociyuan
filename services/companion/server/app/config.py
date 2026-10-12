import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
LOCAL_ROOT = Path(os.environ.get("NICE_PEOPLE_HOME", ROOT / "runtime" / "v1"))
RESOURCE_ROOT = Path(os.environ.get("NICE_PEOPLE_RESOURCES", ROOT / "resources"))
DATA_DIR = LOCAL_ROOT / "data"
RUNTIME_DIR = LOCAL_ROOT / "media"
CHARACTERS_DIR = RESOURCE_ROOT / "characters"
KNOWLEDGE_DIR = LOCAL_ROOT / "knowledge"
MODELS_DIR = RESOURCE_ROOT / "speech"
API_TOKEN = os.environ.get("NICE_PEOPLE_TOKEN", "")
