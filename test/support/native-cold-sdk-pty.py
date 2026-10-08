"""Bounded private PTY fixture runner. No tmux/default socket or real HOME."""
import json
import os
import pathlib
import pty
import select
import subprocess
import tempfile
import time

sdk = os.environ.get('WT_NATIVE_SDK_TEST_MODULE')
if not sdk or not pathlib.Path(sdk).is_file():
    raise RuntimeError('Explicit actual public SDK test module required')
root = pathlib.Path(os.environ.get('NATIVE_HOST_TEST_ROOT') or tempfile.mkdtemp(prefix='wt-cold-sdk-pty.'))
(root / 'home').mkdir(exist_ok=True)
(root / 'agent').mkdir(exist_ok=True)
env = dict(os.environ, HOME=str(root / 'home'), PI_CODING_AGENT_DIR=str(root / 'agent'),
           NATIVE_HOST_TEST_ROOT=str(root), NATIVE_HOST_TEST_SDK=sdk,
           PI_SUBAGENT_REQUIRED_NATIVE_PROVIDER='', WT_DB=str(root / 'wt.db'),
           WT_STATUS_DIR=str(root / 'status'), WT_CONFIG_DIR=str(root / 'config'),
           TERM='xterm-256color')
if os.environ.get('NATIVE_COLD_WT_CONTROL_FILE'):
    for key in ['WT_DB', 'WT_STATUS_DIR', 'WT_CONFIG_DIR', 'WT_STATE',
                'WT_ROOT_ID', 'WT_AGENT_ID', 'WT_RUNTIME_ID']:
        if not os.environ.get(key):
            raise RuntimeError('Missing private control fixture ' + key)
        env[key] = os.environ[key]
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
script = os.environ.get('NATIVE_HOST_TEST_SCRIPT', str(pathlib.Path(__file__).with_suffix('.mjs').resolve()))
log = pathlib.Path(os.environ.get('NATIVE_HOST_TEST_LOG', str(root / 'sdk-pty.log')))
master, slave = pty.openpty()
child = subprocess.Popen(['node', '--experimental-strip-types', script],
                         stdin=slave, stdout=slave, stderr=slave,
                         env=env, start_new_session=True)
os.close(slave)
data = bytearray()

def consume():
    try:
        chunk = os.read(master, 65536)
    except OSError:
        return False
    if not chunk:
        return False
    data.extend(chunk)
    return True

try:
    deadline = time.monotonic() + 30
    while child.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .2)[0] and not consume():
            break
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    for _ in range(32):
        if not select.select([master], [], [], 0)[0] or not consume():
            break
finally:
    os.close(master)
    log.write_bytes(data)
proof = (root / 'proof.json').exists()
print(json.dumps({'root': str(root), 'exit': child.returncode, 'proof': proof}))
raise SystemExit(0 if child.returncode == 0 and proof else 1)
