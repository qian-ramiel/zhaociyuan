from server.app import speech

if __name__ == '__main__':
    speech.ensure_model('tts')
    speech.ensure_model('asr')
    print('本地 TTS 与 ASR 已就绪。')
