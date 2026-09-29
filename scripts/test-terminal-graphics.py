"""Offline native-graphics PTY regression: byte ordering, not a GPU visual test."""
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

BEGIN = b'\x1b[?2026h'
END = b'\x1b[?2026l'
HIDE = b'\x1b[?25l'
SHOW = b'\x1b[?25h'


def run(mode):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 110, 0, 0))
    process = subprocess.Popen(['node', 'scripts/fixtures/terminal-working.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': mode})
    os.close(slave)
    raw = bytearray()

    def pump(seconds=0.25):
        start = len(raw)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.025)[0]:
                try:
                    raw.extend(os.read(master, 65536))
                except OSError:
                    break
        return bytes(raw[start:])

    def keys(value):
        os.write(master, value)
        return pump()

    try:
        pump(1.2)
        # A refresh is the same queue delivered by normal chat polling. It must
        # not delete and recreate unchanged Kitty images/placements.
        refresh = keys(b'/refresh\r')
        if mode == 'kitty':
            assert b'a=T' in refresh and b'a=d' not in refresh, 'polling cleared an unchanged logo'
            assert b'i=5262337,p=1,' in refresh, 'Claude needs a stable named placement'
        else:
            assert b'1337;File=' in refresh
        pump(3)  # Cross the 30-frame loop boundary while the room stays idle.
        keys(b'draft stays')
        keys(b'\x1bOR')  # Working details (F3), then close.
        keys(b'\x1b')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 65, 0, 0))
        process.send_signal(signal.SIGWINCH)
        pump()
        complete = keys(b'\x01\x0b/complete\r')
        if mode == 'kitty':
            assert b'a=d,d=I,i=5262337' in complete, 'completed work must release owned images'
            assert b'd=A' not in raw, 'must not clear unrelated images'
        keys(b'/quit\r')
        process.wait(timeout=3)
        assert process.returncode == 0
        data = bytes(raw)
        assert data.count(BEGIN) == data.count(END), 'unbalanced synchronized updates'
        frames = re.findall(re.escape(BEGIN) + b'(.*?)' + re.escape(END), data, re.S)
        image_frames = [frame for frame in frames if b'a=T' in frame or b'1337;File=' in frame]
        assert len(image_frames) >= 35, 'animation did not advance through a full loop'
        for frame in image_frames:
            image_start = min(index for index in (frame.find(b'\x1b_Ga=T'), frame.find(b'\x1b]1337;')) if index >= 0)
            assert frame.rfind(HIDE, 0, image_start) > frame.rfind(SHOW, 0, image_start), 'cursor visible during image write'
            # The cursor is shown only after restoring it to the input row.
            last_show = frame.rfind(SHOW)
            assert last_show > image_start
            assert re.search(rb'\x1b\[(?:23|17);\d+H', frame[image_start:last_show]), 'cursor not returned to composer'
        outside = re.sub(re.escape(BEGIN) + b'.*?' + re.escape(END), b'', data, flags=re.S)
        assert b'a=T' not in outside and b'1337;File=' not in outside, 'image escaped a synchronized frame'
        print(f'PASS {mode}: synchronized animation, hidden drawing cursor, stable polling, hover, resize and cleanup.')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        os.close(master)


for mode in ('kitty', 'iterm2'):
    run(mode)
