"""Offline PTY rendering test; needs pyte, no models or shared room data."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time
import pyte

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 110, 0, 0))
process = subprocess.Popen(['node', 'scripts/fixtures/terminal-working.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells'})
os.close(slave)
screen = pyte.Screen(110, 24)
stream = pyte.Stream(screen)
raw = bytearray()

def pump(seconds=0.2):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            raw.extend(chunk)
            stream.feed(chunk.decode(errors='replace'))

def text():
    return '\n'.join(screen.display)

def keys(data):
    os.write(master, data)
    pump()

try:
    pump(0.4)
    assert 'Seen' in text(), text()
    assert not any('Working' in row for row in screen.display[:-1]), text()
    keys(b'draft stays here')
    pump(0.7)
    assert 'Claude ×2' in text() and 'OpenAI ×1' in text() and 'DeepSeek ×1' in text(), text()
    message_row = next(y for y, row in enumerate(screen.display) if 'Working' in row and 'Seen' in row)
    column = screen.display[message_row].index('Working')
    first = list(screen.display[-5:-2])
    pump(0.3)
    assert first != screen.display[-5:-2], 'logo frames must animate'
    keys(f'\x1b[<35;{column + 1};{message_row + 1}M'.encode())
    assert 'Working on an answer' in text() and 'Claude reviewer' in text() and 'Qwen checker' in text(), text()
    assert 'draft stays here' in text()
    keys(b'\x1b')
    provider_row = next(y for y, row in enumerate(screen.display) if 'Claude ×2' in row)
    provider_column = screen.display[provider_row].index('Claude')
    keys(f'\x1b[<35;{provider_column + 1};{provider_row + 1}M'.encode())
    assert 'Claude reviewer' in text() and 'Claude coder' in text(), text()
    assert 'Qwen checker —' not in text(), text()
    keys(b'\x1b')
    keys(b'\x1bOR')  # F3: same details without mouse support.
    assert 'Working on an answer' in text(), text()
    keys(b'\x1b[<0;1;23M\x1b[<0;1;23m')
    assert 'Working on an answer' not in text(), text()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 65, 0, 0))
    screen.resize(18, 65)
    process.send_signal(signal.SIGWINCH)
    pump()
    assert 'draft stays here' in text(), text()
    keys(b'\x01\x0b/expire\r')
    pump(0.7)
    assert not any('Working' in row for row in screen.display[:-1]), text()
    assert 'Claude ×2' not in text() and 'DeepSeek' not in '\n'.join(screen.display[-5:]), text()
    assert b'1337;' not in raw and b'\x1b_G' not in raw, 'fallback must never emit image escape sequences'
    keys(b'/quit\r')
    process.wait(timeout=3)
    assert process.returncode == 0
    print('PASS explicit Working versus Seen, four animated logos, grouped agent counts, hover/F3/outside-click, draft preservation, resize and expiry.')
finally:
    if process.poll() is None:
        process.kill()
        process.wait(timeout=3)
    os.close(master)
