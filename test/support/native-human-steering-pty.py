#!/usr/bin/env python3
"""Run against a disposable source copy: python3 test/support/native-human-steering-pty.py ROOT SDK_MODULE.
Uses a real pseudo-terminal and real SDK, synthetic fetch only; no tmux/WT/live state.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import termios
import time

root = Path(sys.argv[1]).resolve()
sdk = Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=False)
(root / 'home').mkdir()
(root / 'agent').mkdir()
(root / 'marker.txt').write_text('ORIGINAL_MARKER\n')
(root / 'agent/settings.json').write_text(json.dumps({'defaultProvider': 'synthetic', 'defaultModel': 'native-host', 'retry': {'enabled': False}, 'compaction': {'enabled': False}, 'quietStartup': True, 'enableInstallTelemetry': False}))
models = [{'id': name, 'name': name, 'reasoning': True, 'input': ['text'], 'contextWindow': 128000, 'maxTokens': 4096, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}} for name in ['native-host', 'other-model']]
(root / 'agent/models.json').write_text(json.dumps({'providers': {'synthetic': {'baseUrl': 'https://synthetic.invalid/v1', 'apiKey': 'fixture', 'api': 'openai-completions', 'models': models}}}))
env = {key: value for key, value in os.environ.items() if not key.startswith(('WT_', 'PI_', 'TMUX', 'ANTHROPIC_', 'OPENAI_', 'GOOGLE_', 'GEMINI_'))}
env.update(HOME=str(root / 'home'), PI_CODING_AGENT_DIR=str(root / 'agent'), PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1', JITI_FS_CACHE='0', PI_SUBAGENTS_TEMP_ROOT=str(root / 'runtime'), NATIVE_HOST_TEST_ROOT=str(root), NATIVE_HOST_TEST_SDK=str(sdk), TERM='xterm-256color')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 150, 0, 0))
fixture = Path(__file__).resolve().with_suffix('.mjs')
process = subprocess.Popen(['node', '--experimental-strip-types', str(fixture)], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
log = open(root / 'tty.log', 'wb')
def pump():
    if select.select([master], [], [], 0.05)[0]:
        try:
            data = os.read(master, 65536)
            log.write(data)
            log.flush()
        except OSError:
            pass

def wait(name):
    deadline = time.monotonic() + 35
    while not (root / name).exists():
        pump()
        if process.poll() is not None:
            raise AssertionError(f'Fixture exited {process.returncode} before {name}: {root}/tty.log')
        assert time.monotonic() < deadline, f'Timeout {name}: {root}/tty.log'
    for _ in range(5):
        pump()

def send(text):
    os.write(master, b'\x15' + text.encode() + b'\r')
    for _ in range(8):
        pump()

def touch(name):
    (root / name).touch()

try:
    wait('claim-1')
    send('CLAIM_BOUNDARY')
    touch('claim-go-1')
    wait('tool-active')
    # Real TUI thinking/model shortcuts, followed by normal Enter steering.
    os.write(master, b'\x1b[Z\x10')
    send('HUMAN_STEER_MARKER: report the steered result without changing files.')
    wait('intervention-progress')
    progress = json.loads((root / 'intervention-progress').read_text())
    assert progress['humanIntervention']['accepted'] == 1
    assert not (root / 'finish-1').exists()
    touch('steer-sent')
    wait('controls-checked')
    touch('tool-go')
    wait('terminal-active')
    send('SECOND_STEER_MARKER: finish the steered work before reporting completion.')
    touch('terminal-go')
    wait('final-tool-active')
    # Longer than runner's old 1s drain + 3s forced-finish window.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        pump()
        assert not (root / 'finish-1').exists()
        assert not (root / 'result-1').exists()
    touch('final-tool-go')
    wait('finish-1')
    send('FINISH_BOUNDARY')
    touch('finish-go-1')
    wait('idle-ready')
    send('IDLE_HUMAN_FOLLOWUP')
    wait('reload-active')
    send('RESUME_RELOAD_BOUNDARY')
    touch('reload-go')
    wait('claim-2')
    send('RESUME_BOUNDARY')
    touch('claim-go-2')
    wait('finish-2')
    touch('finish-go-2')
    wait('proof.json')
    while process.poll() is None:
        pump()
    assert process.returncode == 0
    print((root / 'proof.json').read_text())
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    log.close()
    os.close(master)
