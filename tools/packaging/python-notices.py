import importlib.metadata
import json
import platform
import shutil
import ssl
import sys
import sysconfig
from pathlib import Path

def collect_notices(destination, packages=None):
    target = Path(destination) / 'python'
    target.mkdir(parents=True, exist_ok=True)
    inventory = []
    for package in importlib.metadata.distributions() if packages is None else packages:
        name = package.metadata['Name']
        if name.lower() in {'pytest', 'pyinstaller', 'pyinstaller-hooks-contrib', 'pip', 'altgraph', 'macholib'}:
            continue
        inventory.append({'name': name, 'version': package.version,
                          'license': package.metadata.get('License-Expression') or package.metadata.get('License', '')})
        directory = target / name
        directory.mkdir(parents=True, exist_ok=True)
        # Preserve upstream metadata verbatim; email header folding may reject multiline descriptions.
        metadata = package.read_text('METADATA') or package.read_text('PKG-INFO')
        if metadata is None:
            raise RuntimeError(f'Missing upstream metadata for {name}')
        (directory / 'METADATA.txt').write_text(metadata, encoding='utf-8')
        for entry in package.files or []:
            if any(part.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE')) for part in entry.parts):
                source = Path(package.locate_file(entry))
                if source.is_file():
                    destination_file = directory / Path(*[part for part in entry.parts if part not in ('..', '.')])
                    destination_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination_file)
    (target / 'inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')


def collect_runtime_notice(destination):
    candidates = [Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt',
                  Path(sys.base_prefix) / 'LICENSE.txt', Path(sys.base_prefix) / 'LICENSE']
    license_file = next((candidate for candidate in candidates if candidate.is_file()), None)
    if license_file is None:
        raise RuntimeError('Missing CPython runtime license; include the license from the exact Python distribution.')
    target = Path(destination) / 'python/CPython'
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(license_file, target / 'LICENSE.txt')
    runtime = {'implementation': platform.python_implementation(), 'version': platform.python_version(),
               'openssl': ssl.OPENSSL_VERSION}
    (target / 'runtime.json').write_text(json.dumps(runtime, indent=2), encoding='utf8')


if __name__ == '__main__':
    collect_notices(sys.argv[1])
    collect_runtime_notice(sys.argv[1])
