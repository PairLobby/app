"""A room open to the local network appears in another device's room list, is joined with Enter, and the list still quits at once."""
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
with tempfile.TemporaryDirectory(prefix='pairlobby-network-rooms-') as directory:
    base = {**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_NO_UPDATE_CHECK': '1', 'PAIRLOBBY_GRAPHICS': 'cells'}
    for variable in ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_SESSION', 'PAIRLOBBY_ROOM', 'PAIRLOBBY_SERVER', 'PAIRLOBBY_NO_NETWORK_SEARCH']:
        base.pop(variable, None)
    relay = subprocess.Popen(cli + ['serve', '--port', '0', '--data-dir', directory + '/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=base)
    terminal = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0], 'relay did not start'
        url = re.search(r'http://\S+', relay.stdout.readline()).group(0)

        def command(person, *arguments):
            return json.loads(subprocess.check_output(cli + list(arguments) + ['--json'], env={**base, 'PAIRLOBBY_DATA_DIR': f'{directory}/{person}'}, text=True, timeout=15))

        command('ana', 'create', '--name', 'Open Door', '--as', 'ana', '--human', '--open-local', '--server', url)
        command('ana', 'create', '--name', 'Invite Only', '--as', 'ana', '--human', '--server', url)
        command('bob', 'profile', '--as', 'bob', '--human')

        # Bob's default relay is the test relay, so "this device" is searched; a missing
        # Tailscale binary keeps the search off this machine's real tailnet.
        bob = {**base, 'PAIRLOBBY_DATA_DIR': f'{directory}/bob', 'PAIRLOBBY_SERVER': url, 'PAIRLOBBY_TAILSCALE': directory + '/no-tailscale'}
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 150, 0, 0))
        terminal = subprocess.Popen(cli + ['list'], stdin=slave, stdout=slave, stderr=slave, env=bob)
        os.close(slave)
        screen = pyte.Screen(150, 30)
        stream = pyte.Stream(screen)

        def pump(seconds=.15):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if select.select([master], [], [], .05)[0]:
                    try:
                        stream.feed(os.read(master, 65536).decode(errors='replace'))
                    except OSError:
                        return

        def text():
            return '\n'.join(screen.display)

        def wait_for(value, seconds=10):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                pump()
                if value in text():
                    return
            raise AssertionError(value + '\n' + text())

        def keys(value):
            os.write(master, value)
            pump()

        wait_for('PairLobby rooms')
        wait_for('on network')
        assert 'Open Door' in text() and 'Not joined' in text(), text()
        assert 'Invite Only' not in text(), text()

        # Closing a room you have not joined is refused; Enter asks before joining.
        keys(b'c')
        wait_for('not joined yet')
        keys(b'\r')
        wait_for('Join Open Door')
        keys(b'\x1b[B\r')
        wait_for('registered in this room')
        keys(b'/quit\r')
        wait_for('Local sessions')
        keys(b'\x1b')
        wait_for('PairLobby rooms')
        pump(1)
        assert 'Open Door' in text() and 'on network' not in text(), text()
        assert [room['name'] for room in command('bob', 'list')['rooms']] == ['Open Door']

        started = time.monotonic()
        keys(b'q')
        terminal.wait(timeout=5)
        assert terminal.returncode == 0
        assert time.monotonic() - started < 3, 'the list waited on its network search before exiting'
        print('PASS a room open to the network is listed, joined from the list and saved; closing it unjoined is refused; the list quits at once.')
    finally:
        if terminal and terminal.poll() is None:
            terminal.kill()
            terminal.wait(5)
        relay.terminate()
        relay.wait(5)
