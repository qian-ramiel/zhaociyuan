import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('setup_api', ROOT / 'tools/setup_api.py')
setup_api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup_api)


def test_setup_uses_current_python_312(monkeypatch):
    monkeypatch.setattr(setup_api.sys, 'version_info', (3, 12, 15))
    monkeypatch.setattr(setup_api.sys, 'executable', '/prepared/python')
    assert setup_api.select_python() == '/prepared/python'


def test_setup_finds_python_312_without_reusing_old_system_python(monkeypatch):
    monkeypatch.setattr(setup_api.sys, 'version_info', (3, 9, 6))
    monkeypatch.setattr(setup_api.shutil, 'which', lambda name: '/prepared/python3.12' if name == 'python3.12' else None)
    monkeypatch.setattr(setup_api, 'python_version', lambda _: (3, 12, 15))
    assert setup_api.select_python() == '/prepared/python3.12'


def test_setup_reports_missing_python_without_creating_environment(monkeypatch):
    monkeypatch.setattr(setup_api.sys, 'version_info', (3, 9, 6))
    monkeypatch.setattr(setup_api.shutil, 'which', lambda _: None)
    with pytest.raises(RuntimeError, match='Python 3.12.15'):
        setup_api.select_python()


@pytest.mark.parametrize('version', [(3, 9, 6), (3, 12, 11), (3, 13, 0)])
def test_setup_preserves_incompatible_existing_environment(tmp_path, monkeypatch, version):
    executable = tmp_path / '.venv/bin/python'
    executable.parent.mkdir(parents=True)
    executable.write_text('existing-environment', encoding='utf8')
    monkeypatch.setattr(setup_api, 'python_version', lambda _: version)
    calls = []
    monkeypatch.setattr(setup_api.subprocess, 'run', lambda *args, **kwargs: calls.append(args))
    with pytest.raises(RuntimeError, match='rename it before setup'):
        setup_api.prepare_environment(tmp_path, '/prepared/python')
    assert calls == []
    assert executable.read_text(encoding='utf8') == 'existing-environment'


def test_setup_reuses_compatible_environment_without_recreating_it(tmp_path, monkeypatch):
    executable = tmp_path / '.venv/bin/python'
    executable.parent.mkdir(parents=True)
    executable.touch()
    monkeypatch.setattr(setup_api, 'python_version', lambda _: (3, 12, 15))
    calls = []
    monkeypatch.setattr(setup_api.subprocess, 'run', lambda command, **kwargs: calls.append(command))
    setup_api.prepare_environment(tmp_path, '/prepared/python')
    assert len(calls) == 1
    assert calls[0][:4] == [str(executable), '-m', 'pip', 'install']


def test_setup_creates_fresh_environment_then_installs_requirements(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(setup_api.subprocess, 'run', lambda command, **kwargs: calls.append(command))
    setup_api.prepare_environment(tmp_path, '/prepared/python')
    assert calls[0] == ['/prepared/python', '-m', 'venv', str(tmp_path / '.venv')]
    assert calls[1][-2:] == ['-r', str(tmp_path / 'services/companion/server/requirements.txt')]


def test_setup_allows_newer_security_patches_but_not_old_runtime():
    assert setup_api.supported_python((3, 12, 15))
    assert setup_api.supported_python((3, 12, 16))
    assert not setup_api.supported_python((3, 12, 11))
    assert not setup_api.supported_python((3, 13, 0))
