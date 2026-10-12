import importlib.metadata
import json
import shutil
import sys
from pathlib import Path

target = Path(sys.argv[1]) / 'python'
inventory = []
for package in importlib.metadata.distributions():
    name = package.metadata['Name']
    if name.lower() in {'pytest', 'pyinstaller', 'pyinstaller-hooks-contrib', 'pip', 'altgraph', 'macholib'}:
        continue
    inventory.append({'name': name, 'version': package.version,
                      'license': package.metadata.get('License-Expression') or package.metadata.get('License', '')})
    directory = target / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'METADATA.txt').write_text(str(package.metadata), encoding='utf-8')
    for entry in package.files or []:
        if any(part.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE')) for part in entry.parts):
            source = Path(package.locate_file(entry))
            if source.is_file():
                destination = directory / Path(*[part for part in entry.parts if part not in ('..', '.')])
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
(target / 'inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
