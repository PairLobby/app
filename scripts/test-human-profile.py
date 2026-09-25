"""Exercise human session selection and room names through a real terminal and relay."""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time
import pyte


cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', 'packages/cli/dist/main.js')]
with tempfile.TemporaryDirectory(prefix='pairlobby-profile-') as directory:
    environment = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory + '/client', 'TERM': 'xterm-256color'}
    for variable in ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_SESSION']:
        environment.pop(variable, None)
    relay = subprocess.Popen(cli + ['serve', '--port', '0', '--data-dir', directory + '/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=environment)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0], 'relay did not start'
        url = re.search(r'http://\S+', relay.stdout.readline()).group(0)

        def command(*arguments):
            return json.loads(subprocess.check_output(cli + list(arguments) + ['--json'], env=environment, text=True, timeout=15))

        command('profile', '--as', 'Default One', '--human')
        human = command('create', '--name', 'Profile check', '--human', '--manual-receive', '--server', url)
        room_id = human['roomId']
        scope = ['--room', room_id, '--session', human['sessionId']]
        agent = command('join', human['invite']['code'], '--as', 'agent', '--agent', '--manual-receive', '--server', url)

        def open_chat():
            global terminal, master, output, screen, stream
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 130, 0, 0))
            terminal = subprocess.Popen(cli + ['chat', '--room', room_id], stdin=slave, stdout=slave, stderr=slave, env=environment)
            os.close(slave)
            output = bytearray()
            screen = pyte.Screen(130, 30)
            stream = pyte.Stream(screen)

        def pump():
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return False
                output.extend(data)
                stream.feed(data.decode(errors='replace'))
                return bool(data)
            return True

        def wait_for(text):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if not pump():
                    break
                if text in '\n'.join(screen.display):
                    return
            raise AssertionError(text + '\n' + '\n'.join(screen.display))

        def say(text):
            os.write(master, text.encode() + b'\r')

        def quit_chat():
            global terminal, master
            say('/quit')
            deadline = time.monotonic() + 10
            while terminal.poll() is None and time.monotonic() < deadline:
                pump()
            assert terminal.wait(timeout=2) == 0, output.decode(errors='replace')
            while pump():
                pass
            expected = f'pairlobby chat --room {room_id}'
            text = output.decode(errors='replace')
            assert expected in text and expected + ' --session' not in text, text
            os.close(master)
            master = None
            terminal = None

        def member(participant_id):
            snapshot = command('status', *scope)
            return next(row for row in snapshot['participants'] if row['participantId'] == participant_id)

        open_chat()
        wait_for('as Default One')
        assert not member(human['participantId'])['left']
        assert member(agent['participantId'])['displayName'] == 'agent'
        quit_chat()
        command('profile', '--as', 'Default Two', '--human')
        open_chat()
        wait_for('as Default Two')
        say('/name Room Alias')
        wait_for('Default Two is now Room Alias')
        say('/who')
        wait_for('Room Alias  ')
        assert member(human['participantId'])['nameSource'] == 'room'
        assert command('profile')['displayName'] == 'Default Two'
        # Routing still uses the same participant ID after a rename.
        command('send', 'Hello room alias', '--to', 'Room Alias', '--no-wait', '--room', room_id, '--session', agent['sessionId'])
        wait_for('Hello room alias')
        quit_chat()

        command('profile', '--as', 'Default Three', '--human')
        open_chat()
        wait_for('as Room Alias')
        assert member(human['participantId'])['displayName'] == 'Room Alias'
        quit_chat()

        invite = command('invite', '--room', room_id, '--session', agent['sessionId'])
        second = command('join', invite['code'], '--human', '--manual-receive', '--server', url)
        # A fixture with multiple humans and no previous choice must prompt once.
        registry_path = directory + '/client/rooms.json'
        with open(registry_path) as source:
            registry = json.load(source)
        registry[0].pop('preferredHumanSessionId', None)
        with open(registry_path, 'w') as target:
            json.dump(registry, target)
        open_chat()
        wait_for('Choose your human membership')
        os.write(master, b'\x1b[B\r')
        wait_for('as Default Three')
        quit_chat()
        open_chat()
        wait_for('as Default Three')
        assert b'Choose your human membership' not in output
        assert member(human['participantId'])['left']
        assert not member(second['participantId'])['left']
        quit_chat()
        print('PASS room-only human selection, profile changes, /name announcement and persistence, and remembered multi-human choice.')
    finally:
        if terminal is not None and terminal.poll() is None:
            terminal.kill()
            terminal.wait(timeout=5)
        if master is not None:
            os.close(master)
        relay.terminate()
        relay.wait(timeout=5)
