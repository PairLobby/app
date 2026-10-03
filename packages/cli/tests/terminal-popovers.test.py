"""Offline PTY regression: activity, message status and Working never overlap."""
import fcntl, os, pty, select, signal, struct, subprocess, termios, time
import pyte

for width in (100, 60, 40):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, width, 0, 0))
    process = subprocess.Popen(['node', 'scripts/fixtures/terminal-activity.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells'})
    os.close(slave)
    screen = pyte.Screen(width, 24)
    stream = pyte.Stream(screen)
    headings = ('Agent activity', 'Working on an answer', '| Receipt')

    def text():
        return '\n'.join(screen.display)

    def pump(seconds=.18):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], .025)[0]:
                try:
                    stream.feed(os.read(master, 65536).decode(errors='replace'))
                except OSError:
                    return

    def keys(data):
        os.write(master, data)
        pump()

    def location(label):
        row = next(i for i, line in enumerate(screen.display) if label in line)
        return screen.display[row].index(label) + 1, row + 1

    def hover(label):
        x, y = location(label)
        keys(f'\x1b[<35;{x};{y}M'.encode())

    def click(label):
        x, y = location(label)
        keys(f'\x1b[<0;{x};{y}M'.encode())
        keys(f'\x1b[<0;{x};{y}m'.encode())

    def only(expected):
        # Animation and subsequent renders must not bring an old popup back.
        pump(.25)
        shown = [heading for heading in headings if heading in text()]
        assert shown == ([expected] if expected else []), (width, expected, shown, text())
        assert 'keep my draft' in text(), text()

    try:
        pump(.5)
        keys(b'/busy\r')
        keys(b'keep my draft')
        hover('Turns:')
        only('Agent activity')
        hover('Working')
        only('Working on an answer')
        hover('Turns:')
        only('Agent activity')
        click('Turns:')
        hover('OpenAI')
        only('Agent activity')  # An incidental hover cannot replace a pinned popup.
        keys(b'\x1bOR')  # F3 explicitly replaces the activity popup.
        only('Working on an answer')
        hover('Status')
        only('Working on an answer')
        keys(b'\x1bOQ')  # F2 explicitly replaces Working with message status.
        only('| Receipt')
        keys(b'\x1bOR')
        only('Working on an answer')
        click('Turns:')
        only('Agent activity')
        click('Working')
        only('Working on an answer')
        keys(b'\x1b')
        only(None)
        hover('Turns:')
        only('Agent activity')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, width, 0, 0))
        screen.resize(18, width)
        process.send_signal(signal.SIGWINCH)
        only('Agent activity')
        keys(b'\x1bOR')
        only('Working on an answer')
        keys(b'\x1b')
        only(None)
        keys(b'\x01\x0b/quit\r')
        process.wait(timeout=5)
        assert process.returncode == 0
        print(f'PASS {width} columns: exclusive hover/click/F2/F3, pin protection, redraw, resize and draft preservation')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
