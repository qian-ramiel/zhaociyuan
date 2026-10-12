import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MINIMUM_PYTHON = (3, 12, 15)


def supported_python(version):
    return version[:2] == (3, 12) and version[:3] >= MINIMUM_PYTHON


def python_version(executable):
    output = subprocess.check_output(
        [str(executable), '-c', 'import json, sys; print(json.dumps(list(sys.version_info[:3])))'],
        text=True, timeout=10,
    )
    return tuple(json.loads(output))


def select_python():
    if supported_python(sys.version_info):
        return sys.executable
    candidate = shutil.which('python3.12')
    if candidate and supported_python(python_version(candidate)):
        return candidate
    raise RuntimeError('Python 3.12.15 or a newer 3.12 patch is required. Install it, then run python3.12 tools/setup_api.py.')


def prepare_environment(root, python):
    environment = root / '.venv'
    executable = environment / 'bin' / 'python'
    # Refuse to rewrite a legacy environment that may still serve a running app.
    if environment.exists():
        if not executable.exists() or not supported_python(python_version(executable)):
            raise RuntimeError('Existing .venv does not meet Python 3.12.15 requirements. Stop development services and rename it before setup; keep runtime and user data.')
    else:
        subprocess.run([python, '-m', 'venv', str(environment)], check=True)
    cache = str(Path(tempfile.gettempdir()) / 'zhaociyuan-pip-cache')
    subprocess.run([str(executable), '-m', 'pip', 'install', '--cache-dir', cache,
                    '-r', str(root / 'services/companion/server/requirements.txt')], check=True)


def main():
    try:
        prepare_environment(Path(__file__).resolve().parents[1], select_python())
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f'Service setup failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
