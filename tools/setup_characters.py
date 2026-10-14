"""Reproduce the bundled runtime subset from pinned official Live2D archives."""

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / 'resources/builtin-characters'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_model(model, archive, destination):
    if digest(archive) != model['archiveSha256']:
        raise ValueError(f"Official archive changed: {model['id']}. Review before updating the pin.")
    destination.mkdir(parents=True)
    with zipfile.ZipFile(archive) as zipped:
        for member in zipped.infolist():
            if member.is_dir():
                continue
            if member.filename == model['readme']:
                relative = 'ReadMe.txt'
            elif member.filename.startswith(model['runtimePrefix']):
                relative = 'runtime/' + member.filename[len(model['runtimePrefix']):]
            else:
                continue
            path = PurePosixPath(relative)
            if path.is_absolute() or '..' in path.parts or path.suffix.lower() not in {'.txt', '.json', '.png', '.moc3'}:
                raise ValueError(f'Unexpected runtime file: {relative}')
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with zipped.open(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
    if not (destination / model['model']).is_file():
        raise ValueError('Model entry point is missing')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archives', type=Path, help='Directory containing mao_en.zip and hiyori_en.zip')
    args = parser.parse_args()
    catalog = json.loads((DESTINATION / 'catalog.json').read_text())
    manifest = {'schemaVersion': 1, 'files': []}
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        for model in catalog['models']:
            archive = (args.archives or temporary) / f"{model['id']}_en.zip"
            if not archive.exists():
                print(f"Downloading {model['archiveUrl']}")
                urllib.request.urlretrieve(model['archiveUrl'], archive)
            staged = temporary / model['id']
            extract_model(model, archive, staged)
            target = DESTINATION / model['id']
            # Previews are repository-owned captures of the original runtime, not archive files.
            preview = target / 'preview.png'
            if digest(preview) != model['previewSha256']:
                raise ValueError('Restore the reviewed preview from the repository before setup')
            shutil.copyfile(preview, staged / 'preview.png')
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(staged, target)
            for path in sorted(target.rglob('*')):
                if path.is_file():
                    manifest['files'].append({'path': path.relative_to(DESTINATION).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)})
    (DESTINATION / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Prepared {len(manifest['files'])} reviewed files (official runtime/ReadMe and rendered previews); no editor projects or audio included.")


if __name__ == '__main__':
    main()
