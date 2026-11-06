"""Harness stand-in for a speech provider, run by Hermes as a `type: command` STT/TTS provider (tools/tts_command_provider.py,
tools/transcription_command.py at f8489405). No network, no model.

    fake_voice.py stt|tts <label> <input_path> <output_path>

STT: the transcript is `<label>:` + the text after b'SAY:' in the recording (up to a NUL); b'FAIL:' makes the provider fail with the
rest on stderr (a provider error whose text Hermes puts in HTTPException.detail). TTS: the "audio" is b'ID3' + `<label>:` + the
text it was asked to speak, so a test sees exactly what reached the provider and for which profile."""
import sys

mode, label, source, target = sys.argv[1:5]
data = open(source, 'rb').read()
if mode == 'stt':
    if b'FAIL:' in data:
        sys.stderr.write(data.split(b'FAIL:', 1)[1].split(b'\0', 1)[0].decode('utf-8', 'replace'))
        sys.exit(3)
    said = data.split(b'SAY:', 1)[1].split(b'\0', 1)[0] if b'SAY:' in data else b''
    open(target, 'wb').write(label.encode() + b':' + said)
else:
    open(target, 'wb').write(b'ID3' + label.encode() + b':' + data)
