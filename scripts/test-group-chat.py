"""Real terminal/relay check for multi-mentions, @all, queue display and owner controls."""
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
with tempfile.TemporaryDirectory(prefix='pairlobby-group-chat-') as directory:
    environment = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory + '/device', 'TERM': 'xterm-256color'}
    relay = subprocess.Popen(cli + ['serve', '--port', '0', '--data-dir', directory + '/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=environment)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        url = re.search(r'http://\S+', relay.stdout.readline()).group(0)

        def command(*arguments):
            return json.loads(subprocess.check_output(cli + list(arguments) + ['--json'], env=environment, text=True, timeout=15))

        owner = command('create', '--name', 'Group terminal', '--as', 'owner', '--human', '--manual-receive', '--server', url)
        room_id = owner['roomId']
        scope = ['--room', room_id, '--session', owner['sessionId']]
        codex = command('join', owner['invite']['code'], '--as', 'codex', '--agent', '--manual-receive', '--server', url)
        invite = command('invite', *scope)
        claude = command('join', invite['code'], '--as', 'claude', '--agent', '--manual-receive', '--server', url)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 130, 0, 0))
        terminal = subprocess.Popen(cli + ['chat', *scope], stdin=slave, stdout=slave, stderr=slave, env=environment)
        os.close(slave)
        screen = pyte.Screen(130, 30)
        stream = pyte.Stream(screen)

        def pump():
            if select.select([master], [], [], 0.1)[0]:
                try:
                    stream.feed(os.read(master, 65536).decode(errors='replace'))
                except OSError:
                    return

        def wait_for(text):
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                pump()
                if text in '\n'.join(screen.display):
                    return
            raise AssertionError(text + '\n' + '\n'.join(screen.display))

        def send(text):
            os.write(master, text.encode() + b'\r')

        wait_for('Turns: sequential')
        send('@codex @claude Review this together')
        wait_for('codex: waiting')
        wait_for('claude: waiting')
        transcript = command('read', '--after', '0', *scope)['events']
        questions = [event for event in transcript if event['type'] == 'message' and event.get('recipientIds')]
        assert len(questions) == 1
        assert questions[0]['recipientIds'] == [codex['participantId'], claude['participantId']]
        deliveries = command('requests', *scope)['requests']
        first = next(request for request in deliveries if request['to'] == codex['participantId'])
        grant = command('turn', 'claim', first['eventId'], '--room', room_id, '--session', codex['sessionId'])
        assert grant['state'] == 'granted'
        wait_for('codex: answering')
        send('/turns skip codex')
        wait_for('turn skipped')
        assert all(entry['participantId'] != codex['participantId'] for entry in command('turns', *scope)['entries'])
        send('/turns parallel')
        wait_for('Turns: parallel')
        send('@all Give another view')
        wait_for('Give another view')
        transcript = command('read', '--after', '0', *scope)['events']
        groups = [event for event in transcript if event['type'] == 'message' and event.get('recipientIds')]
        assert len(groups) == 2
        assert set(groups[-1]['recipientIds']) == {codex['participantId'], claude['participantId']}
        send('/turns cancel ' + groups[-1]['eventId'])
        wait_for('turn cancelled')
        assert all(entry['conversationId'] != groups[-1]['eventId'] for entry in command('turns', *scope)['entries'])
        send('/quit')
        deadline = time.monotonic() + 10
        while terminal.poll() is None and time.monotonic() < deadline:
            pump()
        terminal.wait(timeout=2)
        assert terminal.returncode == 0
        print('PASS terminal group mentions, @all, queue strip, claim display, skip, mode switch and round cancellation.')
    finally:
        if terminal is not None and terminal.poll() is None:
            terminal.kill()
            terminal.wait(timeout=5)
        if master is not None:
            os.close(master)
        relay.terminate()
        relay.wait(timeout=5)
