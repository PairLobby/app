"""PTY check for native selection mode, frozen updates and intact drafts."""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time
import pyte

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
process = subprocess.Popen(['node', 'scripts/fixtures/terminal-receipts.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells'})
os.close(slave)
screen = pyte.Screen(100, 24)
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
    pump(0.3)
    keys(b'draft stays here')
    start = len(raw)
    keys(b'\x1bOS')  # F4
    assert 'Select text: drag' in text(), text()
    assert re.search(rb'\x1b\[\?(1000|1002|1003|1006)l', raw[start:]), 'release mouse reporting to native selection'
    frozen = bytes(raw)
    pump(1.3)  # Receipt arrives while selecting: no repaint may disrupt selection.
    assert bytes(raw) == frozen, 'incoming updates must not repaint the selected screen'
    keys(b'\x03do not send this\r')
    assert bytes(raw) == frozen and process.poll() is None, 'selection must not send input or quit on Ctrl+C'
    keys(b'\x1b')
    assert 'Select text: drag' not in text() and 'Seen' in text(), text()
    assert '> draft stays here' in text(), text()
    assert re.search(rb'\x1b\[\?(1000|1002|1003|1006)h', raw[len(frozen):]), 'restore mouse controls'
    keys(b'\x01\x0b/select\r')
    assert 'Select text: drag' in text(), text()
    keys(b'\x1bOS')
    assert 'Select text: drag' not in text(), text()
    keys(b'/fill\r\x1bOS\x1b[5~\x1b[5~\x1b[5~')
    assert 'Select text: drag' in text() and 'hey @codex' in text(), text()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 70, 0, 0))
    screen.resize(24, 70)
    process.send_signal(signal.SIGWINCH)
    pump()
    assert 'Select text: drag' not in text(), text()
    keys(b'/quit\r')
    process.wait(timeout=3)
    assert process.returncode == 0
    print('PASS native-selection mouse release, frozen redraw, delayed receipts, draft preservation, F4/Escape, /select, paging and resize recovery.')
finally:
    if process.poll() is None:
        process.kill()
        process.wait(timeout=3)
    os.close(master)
