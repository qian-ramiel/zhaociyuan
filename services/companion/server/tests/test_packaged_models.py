from pathlib import Path
from server.app import speech


def test_bundled_models_fallback_without_copying_into_user_profile(tmp_path, monkeypatch):
    local = tmp_path / 'user' / 'speech'
    bundled = tmp_path / 'app' / 'speech'
    monkeypatch.setattr(speech, 'MODELS_DIR', local)
    monkeypatch.setenv('NICE_PEOPLE_BUNDLED_SPEECH', str(bundled))
    (bundled / 'model').mkdir(parents=True)
    (bundled / 'model' / 'model.onnx').touch()
    assert speech.model_directory('model', 'model.onnx') == bundled / 'model'
    assert not local.exists()
    (local / 'model').mkdir(parents=True)
    (local / 'model' / 'model.onnx').touch()
    assert speech.model_directory('model', 'model.onnx') == local / 'model'


def test_uninstalled_model_keeps_writable_download_location(tmp_path, monkeypatch):
    monkeypatch.setattr(speech, 'MODELS_DIR', tmp_path / 'user')
    monkeypatch.setenv('NICE_PEOPLE_BUNDLED_SPEECH', str(tmp_path / 'app'))
    assert speech.model_directory('model', 'model.onnx') == tmp_path / 'user' / 'model'
