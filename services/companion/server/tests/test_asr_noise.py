import io
import sys
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from fastapi import HTTPException
from server.app import speech


def wave(samples):
    buffer = io.BytesIO()
    sf.write(buffer, samples, 16000, format='WAV', subtype='FLOAT')
    return buffer.getvalue()


@pytest.fixture
def engine(monkeypatch, tmp_path):
    (tmp_path / 'model.int8.onnx').touch()
    monkeypatch.setattr(speech, 'ASR_MODEL_DIR', tmp_path)
    calls = []
    stream = SimpleNamespace(accept_waveform=lambda *args: None, result=SimpleNamespace(text='The.'))
    recognizer = SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda value: calls.append(value))
    monkeypatch.setitem(sys.modules, 'sherpa_onnx', SimpleNamespace(OfflineRecognizer=SimpleNamespace(from_sense_voice=lambda **kwargs: recognizer)))
    return calls


def test_silence_low_energy_and_short_audio_do_not_invoke_recognizer(engine):
    for samples in (np.zeros(16000), np.full(16000, .0001), np.full(1000, .1)):
        assert speech.transcribe_local(wave(samples)) == ''
    assert engine == []


def test_real_audio_is_not_filtered_by_transcript_keyword(engine):
    assert speech.transcribe_local(wave(np.full(16000, .1))) == 'The.'
    assert len(engine) == 1


def test_nonfinite_audio_rejected_without_recognition(engine):
    with pytest.raises(HTTPException) as error:
        speech.transcribe_local(wave(np.full(16000, np.nan)))
    assert error.value.status_code == 400
    assert engine == []
