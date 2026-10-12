import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
subprocess.run([sys.executable, '-m', 'venv', str(root / '.venv')], check=True)
subprocess.run([str(root / '.venv/bin/python'), '-m', 'pip', 'install', '--cache-dir', '/private/tmp/nice-people-pip-cache', '-r', str(root / 'services/companion/server/requirements.txt')], check=True)
