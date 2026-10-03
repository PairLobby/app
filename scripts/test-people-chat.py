"""Three people and no agent talk through the real chat terminal: untagged, @all and several names."""
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
with tempfile.TemporaryDirectory(prefix='pairlobby-people-') as directory:
    base = {**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_NO_UPDATE_CHECK': '1'}
    for variable in ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_SESSION', 'PAIRLOBBY_SERVER']:
        base.pop(variable, None)
    relay = subprocess.Popen(cli + ['serve', '--port', '0', '--data-dir', directory + '/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=base)
    terminal = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0], 'relay did not start'
        url = re.search(r'http://\S+', relay.stdout.readline()).group(0)

        def command(person, *arguments):
            return json.loads(subprocess.check_output(cli + list(arguments) + ['--json'], env={**base, 'PAIRLOBBY_DATA_DIR': f'{directory}/{person}'}, text=True, timeout=15))

        ana = command('ana', 'create', '--name', 'people', '--as', 'ana', '--human', '--server', url)
        for person in ['bob', 'cy']:
            command(person, 'join', command('ana', 'invite')['code'], '--as', person, '--human', '--server', url)

        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
        terminal = subprocess.Popen(cli + ['chat', '--room', ana['roomId']], stdin=slave, stdout=slave, stderr=slave, env={**base, 'PAIRLOBBY_DATA_DIR': f'{directory}/bob'})
        os.close(slave)
        screen = pyte.Screen(120, 30)
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

        def wait_for(value):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                pump()
                if value in text():
                    return
            raise AssertionError(value + '\n' + text())

        wait_for('/help for commands')
        for line in ['hello from bob', '@all still just people', '@ana @cy both of you']:
            os.write(master, line.encode() + b'\r')
            wait_for(line)
        pump(.5)
        assert 'not sent' not in text(), text()

        said = [event['payload']['text'] for event in command('ana', 'read')['events'] if event['type'] == 'message']
        for line in ['hello from bob', '@all still just people', '@ana @cy both of you']:
            assert line in said, said
        print('PASS three people without an agent: untagged, @all and several names all reach the room.')
    finally:
        if terminal:
            # The chat keeps running on SIGTERM; /quit is how a person leaves it.
            try:
                os.write(master, b'/quit\r')
                terminal.wait(5)
            except (OSError, subprocess.TimeoutExpired):
                terminal.kill()
                terminal.wait(5)
        relay.terminate()
        relay.wait(5)
