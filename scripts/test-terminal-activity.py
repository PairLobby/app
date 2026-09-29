"""PTY checks for compact details, room-idle evidence and sticky message receipts."""
import fcntl, os, pty, select, signal, struct, subprocess, termios, time
import pyte
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
process = subprocess.Popen(['node', 'scripts/fixtures/terminal-activity.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells'})
os.close(slave)
screen = pyte.Screen(100, 24)
stream = pyte.Stream(screen)
def pump(seconds=.25):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if select.select([master], [], [], .025)[0]:
            try: data = os.read(master, 65536)
            except OSError: return
            stream.feed(data.decode(errors='replace'))
def text(): return '\n'.join(screen.display)
def keys(value):
    os.write(master, value)
    pump()
def command(value): keys(b'\x01\x0b' + value.encode() + b'\r')
def hover_seen(row):
    col = screen.display[row].index('Seen')
    keys(f'\x1b[<35;{col+1};{row+1}M'.encode())
try:
    pump(.6)
    assert 'All agents idle (2)' in text(), text()
    row = next(i for i, line in enumerate(screen.display) if 'SHORT message' in line)
    sender = screen.display[row].index('hjoncour')
    receiver = screen.display[row].index('codex')
    body = screen.display[row].index('SHORT')
    original_bg = screen.buffer[row][body].bg
    hover_seen(row)
    assert 'Confirmed receipts' in text(), text()
    assert screen.buffer[row][sender].underscore and screen.buffer[row][receiver].underscore, 'header identities must underline'
    assert screen.buffer[row][body].bg != original_bg, 'message needs a subtle hover background'
    keys(b'\x1b[<35;1;23M')
    assert not screen.buffer[row][sender].underscore
    assert screen.buffer[row][body].bg == original_bg
    command('/busy')
    assert '1 working' in text() and '1 idle' in text(), text()
    keys(b'\x1bOR')
    heading = next(line for line in screen.display if 'Working on an answer' in line)
    assert heading.index('Working on an answer') >= 75, heading
    keys(b'\x1b')
    command('/done')
    command('/unread')
    assert '2 unread' in text() and 'All agents idle' not in text(), text()
    command('/read')
    assert 'All agents idle (2)' in text()
    command('/waiting')
    assert '1 waiting' in text() and 'All agents idle' not in text()
    command('/done')
    command('/unknown')
    assert '2 unknown' in text() and 'All agents idle' not in text(), text()
    command('/done')
    # Footer hover explains each agent's state in a compact popup.
    row = next(i for i, line in enumerate(screen.display) if 'All agents idle' in line)
    keys(f'\x1b[<35;25;{row+1}M'.encode())
    assert 'Agent activity' in text() and 'Idle' in text() and 'caught up' in text(), text()
    keys(b'\x1b')
    command('/long')
    row = next(i for i, line in enumerate(screen.display[:-3]) if 'Seen' in line)
    assert 'LONG099' in screen.display[row], text()
    keys(b'\x1b[5~')
    row = next(i for i, line in enumerate(screen.display[:-3]) if 'Seen' in line)
    assert 5 <= row <= 15 and 'LONG' in screen.display[row], text()
    hover_seen(row)
    assert 'Confirmed receipts' in text(), text()
    assert screen.buffer[row][2].bg != 'default', 'visible fragment should highlight'
    keys(b'\x1b')
    for _ in range(7): keys(b'\x1b[5~')
    row = next(i for i, line in enumerate(screen.display) if 'LONG000' in line)
    assert 'Seen' in screen.display[row], text()
    hover_seen(row)
    sender = screen.display[row].index('hjoncour')
    assert screen.buffer[row][sender].underscore
    keys(b'\x1b')
    command('/many')
    keys(b'\x1bOQ')
    assert 'Confirmed receipts (scroll)' in text(), text()
    row = next(i for i, line in enumerate(screen.display) if 'Confirmed receipts' in line)
    col = screen.display[row].index('Confirmed receipts')
    for _ in range(5): keys(f'\x1b[<65;{col+1};{row+3}M'.encode())
    assert 'Reader 15' in text(), text()
    keys(b'draft remains')
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 60, 0, 0))
    screen.resize(18, 60)
    process.send_signal(signal.SIGWINCH)
    pump(.5)
    assert 'draft remains' in text(), text()
    keys(b'\x1b')
    command('/quit')
    process.wait(timeout=3)
    assert process.returncode == 0
    print('PASS compact popups, scrollable overflow, idle/unread/waiting/working states, sticky Seen top/middle/bottom, scoped highlight/underlines, resize and draft preservation.')
finally:
    if process.poll() is None:
        process.kill()
        process.wait(timeout=3)
    os.close(master)
