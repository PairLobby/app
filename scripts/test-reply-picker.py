"""Real terminal/relay check for reply navigation, quotes, cancellation and default @all."""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import pyte


cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', 'packages/cli/dist/main.js')]
with tempfile.TemporaryDirectory(prefix='pairlobby-reply-picker-') as directory:
    environment = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory + '/device', 'TERM': 'xterm-256color'}
    relay = subprocess.Popen(cli + ['serve', '--port', '0', '--data-dir', directory + '/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=environment)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        url = re.search(r'http://\S+', relay.stdout.readline()).group(0)

        def command(*arguments):
            return json.loads(subprocess.check_output(cli + list(arguments) + ['--json'], env=environment, text=True, timeout=15))

        human = command('create', '--name', 'Reply picker', '--as', 'human', '--human', '--manual-receive', '--server', url)
        room_id = human['roomId']
        scope = ['--room', room_id, '--session', human['sessionId']]
        codex = command('join', human['invite']['code'], '--as', 'codex', '--agent', '--manual-receive', '--server', url)
        invite = command('invite', *scope)
        claude = command('join', invite['code'], '--as', 'claude', '--agent', '--manual-receive', '--server', url)

        def post(text, sender=codex, recipient='human'):
            return command('send', text, '--to', recipient, '--no-wait', '--room', room_id, '--session', sender['sessionId'])

        def messages():
            return [event for event in command('read', '--after', '0', *scope)['events'] if event['type'] == 'message']

        post('Older scroll anchor\n' + '\n'.join(f'Wrapped history line {index}' for index in range(30)))
        post('First original request')
        post('Second original request', claude)
        originals = [event for event in messages() if event['payload']['text'] in ['First original request', 'Second original request']]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 26, 110, 0, 0))
        terminal = subprocess.Popen(cli + ['chat', *scope], stdin=slave, stdout=slave, stderr=slave, env=environment)
        os.close(slave)
        screen = pyte.Screen(110, 26)
        stream = pyte.Stream(screen)

        def pump(seconds=0.2):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        stream.feed(os.read(master, 65536).decode(errors='replace'))
                    except OSError:
                        break

        def display():
            return '\n'.join(screen.display)

        def wait_for(text):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                pump()
                if text in display():
                    return
            raise AssertionError(text + '\n' + display())

        def keys(data):
            os.write(master, data)
            pump()

        def send(text):
            keys(text.encode() + b'\r')

        def highlighted(text):
            for row, line in enumerate(screen.display[:-4]):
                if text in line:
                    column = line.index(text)
                    if screen.buffer[row][column].bg == 'blue':
                        return True
            return False

        wait_for('Second original request')
        keys(b'/reply')
        assert highlighted('Second original request'), display()
        keys(b'\x1b[A')
        assert highlighted('First original request'), display()
        keys(b'\x1b[A')
        assert highlighted('Older scroll anchor'), display()
        keys(b'\x1b[B')
        assert highlighted('First original request'), display()
        keys(b'\r')
        assert len(messages()) == 3, 'choosing a message must not send'
        assert '> codex: First original request' in screen.display[-3], display()
        quote_column = screen.display[-3].index('First')
        assert screen.buffer[screen.lines - 3][quote_column].fg != 'default'
        send('My first answer')
        wait_for('My first answer')
        answer = messages()[-1]
        assert answer['replyTo'] == originals[0]['eventId'], answer
        assert answer['recipientId'] == codex['participantId'], answer
        assert any('> codex: First original request' in line for line in screen.display[:-3]), display()

        # Tab selects, new messages cannot move the selected target, and resize preserves it.
        keys(b'/reply\x1b[A\t')
        keys(b'Second answer')
        post('New arrival while composing', codex)
        wait_for('New arrival while composing')
        assert '> claude: Second original request' in screen.display[-3], display()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 22, 76, 0, 0))
        screen.resize(22, 76)
        terminal.send_signal(signal.SIGWINCH)
        pump()
        assert 'Second original request' in screen.display[-3], display()
        keys(b'\r')
        wait_for('Second answer')
        assert messages()[-1]['replyTo'] == originals[1]['eventId']

        # Removing the command keeps the draft, clears the quote, and sends as @all.
        keys(b'/reply\tPlain after cancelling')
        keys(b'\x01' + b'\x1b[3~' * 7)
        assert '> Plain after cancelling' in screen.display[-2], display()
        assert not screen.display[-3].lstrip().startswith('>'), display()
        assert 'Enter sends your reply' not in display()
        keys(b'\r')
        wait_for('Plain after cancelling')
        plain = messages()[-1]
        assert set(plain['recipientIds']) == {codex['participantId'], claude['participantId']}, plain
        assert plain['replyTo'] is None and 'quoteOf' not in plain, plain

        # A completed agent answer can be selected for a fresh, quoted follow-up.
        question = post('Question for agent answer', human, 'codex')
        question_event = next(event for event in messages() if event['payload']['text'] == 'Question for agent answer')
        command('reply', question_event['eventId'], 'A completed agent answer', '--room', room_id, '--session', codex['sessionId'])
        wait_for('A completed agent answer')
        source = messages()[-1]
        keys(b'/reply\t')
        send('Can you expand that?')
        wait_for('Can you expand that?')
        followup = messages()[-1]
        assert followup['quoteOf'] == source['eventId'] and followup['replyTo'] is None, followup
        assert followup['recipientId'] == codex['participantId'], followup
        pending = command('requests', '--room', room_id, '--session', codex['sessionId'])['requests']
        assert any(row['eventId'] == followup['eventId'] and 'A completed agent answer' in row['text'] for row in pending)

        # Escape also cancels, and ordinary /to routing still overrides implicit @all.
        keys(b'/reply\tkeep draft\x1b')
        assert '> keep draft' in screen.display[-2], display()
        keys(b'\x01\x0b')
        send('/to claude')
        send('Only the chosen agent')
        wait_for('Only the chosen agent')
        assert messages()[-1]['recipientId'] == claude['participantId']
        send('/to')
        send('/mute claude')
        wait_for('claude was muted')
        send('Only one eligible agent')
        wait_for('Only one eligible agent')
        assert messages()[-1]['recipientIds'] == [codex['participantId']]
        send('/quit')
        deadline = time.monotonic() + 10
        while terminal.poll() is None and time.monotonic() < deadline:
            pump()
        assert terminal.wait(timeout=2) == 0
        print('PASS highlighted reply navigation, Enter/Tab selection, dim quotes, stable drafts, resizing, cancellation, correlated answers, quoted follow-ups and implicit @all.')
    finally:
        if terminal is not None and terminal.poll() is None:
            terminal.kill()
            terminal.wait(timeout=5)
        if master is not None:
            os.close(master)
        relay.terminate()
        relay.wait(timeout=5)
