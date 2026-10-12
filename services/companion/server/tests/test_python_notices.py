import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('python_notices', ROOT / 'tools/packaging/python-notices.py')
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


def test_notices_preserve_multiline_metadata_and_copy_original_license(tmp_path):
    raw = 'Metadata-Version: 2.1\nName: example\nVersion: 1.0\nDescription: intro\n## CLI\nUsage: example\n'
    license_file = tmp_path / 'original-LICENSE'
    license_file.write_text('original license text', encoding='utf8')
    package = SimpleNamespace(metadata={'Name': 'example', 'License-Expression': 'MIT'}, version='1.0',
                              read_text=lambda name: raw if name == 'METADATA' else None,
                              files=[Path('example.dist-info/LICENSE')], locate_file=lambda _: license_file)
    notices.collect_notices(tmp_path / 'licenses', [package])
    target = tmp_path / 'licenses/python/example'
    assert (target / 'METADATA.txt').read_text(encoding='utf8') == raw
    assert (target / 'example.dist-info/LICENSE').read_text(encoding='utf8') == 'original license text'
    assert json.loads((target.parent / 'inventory.json').read_text()) == [{'name': 'example', 'version': '1.0', 'license': 'MIT'}]


def test_notices_fail_instead_of_silently_omitting_required_metadata(tmp_path):
    package = SimpleNamespace(metadata={'Name': 'example'}, version='1.0', read_text=lambda _: None)
    with pytest.raises(RuntimeError, match='Missing upstream metadata'):
        notices.collect_notices(tmp_path, [package])


def test_runtime_notice_preserves_exact_python_license_without_build_paths(tmp_path, monkeypatch):
    source = tmp_path / 'stdlib'
    source.mkdir()
    (source / 'LICENSE.txt').write_text('Python runtime license', encoding='utf8')
    monkeypatch.setattr(notices.sysconfig, 'get_path', lambda _: str(source))
    monkeypatch.setattr(notices.platform, 'python_implementation', lambda: 'CPython')
    monkeypatch.setattr(notices.platform, 'python_version', lambda: '3.12.15')
    notices.collect_runtime_notice(tmp_path / 'licenses')
    target = tmp_path / 'licenses/python/CPython'
    assert (target / 'LICENSE.txt').read_text() == 'Python runtime license'
    metadata = json.loads((target / 'runtime.json').read_text())
    assert metadata['version'] == '3.12.15'
    assert metadata['implementation'] == 'CPython'
    assert str(tmp_path) not in json.dumps(metadata)
