"""Exercise exit hints and the copied rejoin command through a real terminal and relay."""
import fcntl
import json
import os
import pty
import re
import select
import shlex
import struct
import subprocess
import tempfile
import termios
import time


cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', 'packages/cli/dist/main.js')]
with tempfile.TemporaryDirectory(prefix='pairlobby-rejoin-') as directory:
    environment = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory + '/client', 'TERM': 'xterm-256color'}
    for variable in ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_SESSION']:
        environment.pop(variable, None)
    relay = subprocess.Popen(cli + ['serve', '--port', '0', '--data-dir', directory + '/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=environment)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0], 'relay did not start'
        first = relay.stdout.readline()
        url = re.search(r'http://[^\s]+', first).group(0)

        def command(*arguments):
            return json.loads(subprocess.check_output(cli + list(arguments) + ['--json'], env=environment, text=True, timeout=15))

        created = command('create', '--name', 'Rejoin check', '--as', 'returning-user', '--human', '--manual-receive', '--server', url)
        room_id = created['roomId']
        session_id = created['sessionId']
        arguments = ['chat', '--room', room_id, '--session', session_id]
        expected = 'pairlobby chat --room ' + room_id

        for exit_keys in [b'/quit\r', b'\x03', b'\x04']:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
            terminal = subprocess.Popen(cli + arguments, stdin=slave, stdout=slave, stderr=slave, env=environment)
            os.close(slave)
            output = bytearray()

            def pump():
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        return False
                    output.extend(data)
                    return bool(data)
                return True

            deadline = time.monotonic() + 10
            while b'/help' not in output and time.monotonic() < deadline:
                if not pump():
                    break
            assert b'/help' in output, output.decode(errors='replace')
            snapshot = command('status', '--room', room_id, '--session', session_id)
            assert len(snapshot['participants']) == 1, snapshot
            assert snapshot['participants'][0]['participantId'] == created['participantId']
            assert not snapshot['participants'][0]['left'], snapshot
            command('send', 'Returned with the same session', '--no-wait', '--room', room_id, '--session', session_id)

            os.write(master, exit_keys)
            deadline = time.monotonic() + 10
            while terminal.poll() is None and time.monotonic() < deadline:
                pump()
            assert terminal.wait(timeout=2) == 0, output.decode(errors='replace')
            while pump():
                pass
            text = output.decode(errors='replace')
            assert text.count('To rejoin this room:') == 1, text
            assert expected in text, text
            restored = output.rfind(b'\x1b[?1049l')
            assert restored >= 0 and output.find(expected.encode()) > restored, 'command must remain after restoring the terminal buffer'
            printed = re.search(r'pairlobby chat --room rm_[A-Z0-9]+', text).group(0)
            arguments = shlex.split(printed)[1:]
            snapshot = command('status', '--room', room_id, '--session', session_id)
            assert snapshot['participants'][0]['left'], snapshot
            assert 'plp_' not in printed and 'plc_' not in printed
            os.close(master)
            master = None
            terminal = None

        print('PASS /quit, Ctrl+C and Ctrl+D print a reusable command in shell scrollback; rejoining preserves identity and restores sending.')
    finally:
        if terminal is not None and terminal.poll() is None:
            terminal.kill()
            terminal.wait(timeout=5)
        if master is not None:
            os.close(master)
        relay.terminate()
        relay.wait(timeout=5)
