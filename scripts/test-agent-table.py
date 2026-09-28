"""PTY regression for table geometry, double-click copy, clipping, navigation and resize."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import pyte

with tempfile.TemporaryDirectory(prefix='pairlobby-agent-table-') as directory:
    record = directory + '/copies.jsonl'
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 230, 0, 0))
    process = subprocess.Popen(['node', 'scripts/fixtures/agent-table.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_TEST_COPY': record})
    os.close(slave)
    screen = pyte.Screen(230, 24)
    stream = pyte.Stream(screen)

    def pump(seconds=0.12):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.02)[0]:
                try:
                    stream.feed(os.read(master, 65536).decode(errors='replace'))
                except OSError:
                    return

    def keys(value):
        os.write(master, value)
        pump()

    def copies():
        return [json.loads(line) for line in open(record)] if os.path.exists(record) else []

    def click(x, y):
        os.write(master, f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m'.encode())
        pump(0.06)

    try:
        pump(0.5)
        output = '\n'.join(screen.display)
        for heading in ['Name', 'Provider', 'Status', 'Model', 'Conversation ID', 'Invite', 'Origin', 'Last message date']:
            assert heading in output, output
        first_row = next(index for index, line in enumerate(screen.display) if 'reviewer-with' in line)
        header = next(line for line in screen.display if 'Conversation ID' in line and 'Provider' in line)
        name_x = header.index('Name') + 2
        provider_x = header.index('Provider') + 2
        click(name_x, first_row + 1)
        assert copies() == [], 'one click must not copy'
        click(provider_x, first_row + 1)
        assert copies() == [], 'clicks in different cells must not count as a double-click'
        click(provider_x, first_row + 1)
        assert copies() == ['OpenAI'], copies()
        click(name_x, first_row + 1)
        click(name_x, first_row + 1)
        assert copies()[-1] == 'reviewer-with-a-very-long-display-name', copies()
        assert 'Copied: Name' in '\n'.join(screen.display)
        # Every requested column copies its underlying full value, including clipped Unicode text.
        expected = ['OpenAI', 'Ready', 'a-very-long-model-name-with-Ω-and-extra-details', 'conversation-0-' + 'x' * 45, 'ABCD-1234', 'This session', '2026-09-27T21:23:45.000Z']
        for value in expected:
            keys(b'\x1b[C\r')
            assert copies()[-1] == value, (value, copies())
        keys(b'r')
        for _ in range(7):
            keys(b'\x1b[D')
        assert 'Refreshed' in '\n'.join(screen.display)
        keys(b'\x1b[6~\r')
        assert copies()[-1] == 'agent-16', copies()
        # The conversation column remains reachable and copyable on narrow terminals.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        screen.resize(24, 80)
        process.send_signal(signal.SIGWINCH)
        pump()
        for _ in range(4):
            keys(b'\x1b[C')
        assert 'Conversation ID' in '\n'.join(screen.display)
        keys(b'\r')
        assert copies()[-1] == 'conversation-16-' + 'x' * 45, copies()
        keys(b'\x1b')
        assert 'Background composer: draft stays here' in '\n'.join(screen.display)
        keys(b'q')
        assert process.wait(timeout=3) == 0
        print('PASS all columns, cell-specific double-click, full Unicode value copying, paging, horizontal navigation, refresh, resize, and closing.')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        os.close(master)
