"""Real PTY/relay check: slash spawning stays local and leaves the composer usable."""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
import pyte

cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', os.path.abspath('packages/cli/dist/main.js'))]
with tempfile.TemporaryDirectory(prefix='pairlobby-spawn-chat-') as directory:
    binary = directory + '/codex'
    shutil.copyfile('scripts/fixtures/codex-receiver.mjs', binary)
    os.chmod(binary, 0o755)
    environment = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory + '/device', 'PAIRLOBBY_ROOM': '', 'PAIRLOBBY_SESSION': '', 'PATH': directory + os.pathsep + os.environ['PATH'], 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells', 'PAIRLOBBY_TEST_RECORD': directory + '/calls'}
    relay = subprocess.Popen(cli + ['serve', '--port', '0', '--data-dir', directory + '/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=environment)
    terminal = None
    master = None
    room_id = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        url = re.search(r'http://\S+', relay.stdout.readline()).group(0)

        def command(*args):
            return json.loads(subprocess.check_output(cli + list(args) + ['--json'], env=environment, text=True, timeout=15))

        owner = command('create', '--name', 'Spawn terminal', '--human', '--as', 'human', '--server', url)
        room_id = owner['roomId']
        scope = ['--room', room_id, '--session', owner['sessionId']]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 150, 0, 0))
        terminal = subprocess.Popen(cli + ['chat', *scope], stdin=slave, stdout=slave, stderr=slave, env=environment)
        os.close(slave)
        screen = pyte.Screen(150, 32)
        stream = pyte.Stream(screen)

        def pump():
            if select.select([master], [], [], 0.1)[0]:
                try:
                    stream.feed(os.read(master, 65536).decode(errors='replace'))
                except OSError:
                    pass

        def wait_for(text):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                pump()
                if text in '\n'.join(screen.display):
                    return
            raise AssertionError(text + '\n' + '\n'.join(screen.display))

        def send(text):
            os.write(master, text.encode() + b'\r')

        wait_for('Turns: sequential')
        # Tab completion inserts the alias; typing the next draft must survive async startup.
        os.write(master, b'/cod\t--model fixture-model --name reviewer\rmy next draft')
        wait_for('reviewer joined')
        wait_for('my next draft')
        assert not os.path.exists(directory + '/calls'), 'idle spawn must not invoke the provider'
        os.write(master, b'\x01\x0b')
        send('@reviewer declare-working Hello')
        wait_for('Fixture answer:')
        os.write(master, b'/sta')
        wait_for('/status')
        wait_for('tab to complete')
        os.write(master, b'\t')
        wait_for('> /status ')
        os.write(master, b'\r')
        wait_for('Room status')
        wait_for('Messages (retained)')
        assert any('Messages (retained)' in line and '2' in line for line in screen.display)
        wait_for('Agents')
        assert any('Agents' in line and '1' in line for line in screen.display), '\n'.join(screen.display)
        os.write(master, b'\x1b')
        deadline = time.monotonic() + 10
        while 'Room status —' in '\n'.join(screen.display) and time.monotonic() < deadline:
            pump()
        assert 'Room status —' not in '\n'.join(screen.display), 'Escape must close status'
        os.write(master, b'my status draft')
        wait_for('my status draft')
        os.write(master, b'\x01\x0b/turns par')
        wait_for('/turns parallel')
        os.write(master, b'\t')
        wait_for('> /turns parallel ')
        os.write(master, b'\x01\x0b')
        send('/agents')
        wait_for('Agents (1)')
        os.write(master, b'\x1b')
        deadline = time.monotonic() + 10
        while 'Agents (1)' in '\n'.join(screen.display) and time.monotonic() < deadline:
            pump()
        assert 'Agents (1)' not in '\n'.join(screen.display), 'Escape must close the agent table'
        send('/agent stop reviewer')
        wait_for('reviewer: receiver stopped')
        send('/agent start reviewer')
        wait_for('reviewer: receiver available')
        events = command('read', '--after', '0', *scope)['events']
        messages = [event['payload']['text'] for event in events if event['type'] == 'message']
        assert not any(text.startswith(('/codex', '/agent', '/spawn', '/status')) for text in messages), messages
        send('/quit')
        deadline = time.monotonic() + 10
        while terminal.poll() is None and time.monotonic() < deadline:
            pump()
        assert terminal.wait(timeout=3) == 0
        sessions = json.load(open(directory + '/device/rooms.json'))[0]['sessions']
        spawned = next(entry for entry in sessions if entry.get('spawnedBy') == owner['sessionId'])
        receiver_status = command('receiver', 'status', '--room', room_id, '--session', spawned['sessionId'])
        assert receiver_status['state'] == 'available', receiver_status
        print('PASS slash suggestions, Tab completion, room status counts, draft preservation, spawning, local lifecycle controls, no command broadcast, and receiver surviving chat exit.')
    finally:
        if terminal is not None and terminal.poll() is None:
            terminal.kill()
            terminal.wait(timeout=5)
        registry = directory + '/device/rooms.json'
        if os.path.exists(registry):
            for room in json.load(open(registry)):
                for session in room['sessions']:
                    if session.get('spawnedBy'):
                        subprocess.run(cli + ['receiver', 'stop', '--room', room['roomId'], '--session', session['sessionId']], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if master is not None:
            os.close(master)
        relay.terminate()
        relay.wait(timeout=5)
