#!/usr/bin/env python3
"""Disposable copies only: ROOT SDK_MODULE WT_NATIVE_PROTOCOL_MODULE. Real PTY, no tmux."""
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
root.mkdir(parents=True, exist_ok=False)
sdk, protocol = [str(Path(p).resolve()) for p in sys.argv[2:4]]
for case in ['session-create', 'bind', 'claim', 'extensions-empty', 'deny-extensions']:
    directory = root / case
    (directory / 'home').mkdir(parents=True)
    (directory / 'agent').mkdir()
    (directory / 'marker.txt').write_text('FIXTURE_MARKER\n')
    (directory / 'agent/settings.json').write_text(json.dumps({'defaultProvider': 'synthetic', 'defaultModel': 'native-host', 'retry': {'enabled': False}, 'compaction': {'enabled': False}, 'quietStartup': True, 'enableInstallTelemetry': False}))
    model = {'id': 'native-host', 'name': 'native-host', 'reasoning': True, 'input': ['text'], 'contextWindow': 128000, 'maxTokens': 4096, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}
    (directory / 'agent/models.json').write_text(json.dumps({'providers': {'synthetic': {'baseUrl': 'https://synthetic.invalid/v1', 'apiKey': 'fixture', 'api': 'openai-completions', 'models': [model]}}}))
    env = {'PATH': os.environ['PATH'], 'HOME': str(directory / 'home'), 'PI_CODING_AGENT_DIR': str(directory / 'agent'), 'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'JITI_FS_CACHE': '0', 'PI_SUBAGENTS_TEMP_ROOT': str(directory / 'runtime'), 'NATIVE_HOST_TEST_ROOT': str(directory), 'NATIVE_HOST_TEST_SDK': sdk, 'NATIVE_HOST_TEST_PROTOCOL': protocol, 'NATIVE_HOST_TEST_CASE': case, 'TERM': 'xterm-256color'}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 150, 0, 0))
    process = subprocess.Popen(['node', '--experimental-strip-types', str(Path(__file__).with_suffix('.mjs').resolve())], cwd=directory, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    try:
        with open(directory / 'tty.log', 'wb') as log:
            deadline = time.monotonic() + 45
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        log.write(os.read(master, 65536))
                        log.flush()
                    except OSError:
                        pass
            assert process.poll() == 0, f'{case} exited {process.poll()}; inspect {directory}/tty.log'
        print((directory / 'proof.json').read_text(), flush=True)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
