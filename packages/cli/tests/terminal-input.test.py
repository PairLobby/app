"""Real terminal regression: literal newlines, named state hovers, selection without implicit copying."""
import base64, fcntl, os, pty, select, signal, struct, subprocess, termios, time
import pyte

for width in (120, 60):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, width, 0, 0))
    process = subprocess.Popen(['node', 'scripts/fixtures/terminal-activity.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells', 'SSH_CONNECTION': 'clipboard-fixture'})
    os.close(slave)
    screen = pyte.Screen(width, 30)
    stream = pyte.Stream(screen)
    output = bytearray()

    def pump(seconds=.2):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], .02)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                output.extend(chunk)
                stream.feed(chunk.decode(errors='replace'))

    def keys(data):
        os.write(master, data)
        pump()

    def text():
        return '\n'.join(screen.display)

    def popup_text():
        return '\n'.join(line for line in screen.display if line.strip().startswith('x '))

    def location(label):
        row = next(index for index, line in enumerate(screen.display) if label in line)
        return screen.display[row].index(label) + 1, row + 1

    def hover(label):
        x, y = location(label)
        keys(f'\x1b[<35;{x};{y}M'.encode())

    def click_at(x, y):
        keys(f'\x1b[<0;{x};{y}M'.encode())
        keys(f'\x1b[<0;{x};{y}m'.encode())

    def highlighted():
        return '\n'.join(''.join(cell.data for _, cell in sorted(row.items()) if cell.bg == 'blue') for _, row in sorted(screen.buffer.items())).strip('\n')

    try:
        ready = time.monotonic() + 5
        while 'SHORT' not in text() and time.monotonic() < ready:
            pump(.1)
        assert 'SHORT' in text(), text()
        keys(b'Alpha\x1b[13;2uBeta\x1b\rGamma')
        assert 'SUBMITTED' not in text(), text()
        assert all(part in text() for part in ('> Alpha', 'Beta', 'Gamma')), text()
        keys(b'\r')
        assert 'SUBMITTED "Alpha\\nBeta\\nGamma"' in text(), text()
        assert process.poll() is None

        keys(b'/mixed\r')
        hover('Turns:')
        assert 'Relay sync' in popup_text() and 'API reviewer' in popup_text(), text()
        hover('preparing')
        assert 'Preparing an answer' in popup_text() and 'API reviewer' in popup_text(), text()
        assert 'Relay sync' not in popup_text(), text()
        hover('working')
        assert 'Agents' in popup_text() and 'Relay sync' in popup_text(), text()
        assert 'API reviewer' not in popup_text(), text()
        keys(b'\x1b')

        x, y = location('SHORT')
        click_at(x, y)
        click_at(x, y)
        assert highlighted() == 'SHORT', (highlighted(), text())
        assert b'\x1b]52;' not in output, 'Selecting text changed the clipboard'
        keys(b'\x03')
        assert b'\x1b]52;c;' + base64.b64encode(b'SHORT') + b'\x07' in output
        assert process.poll() is None, 'Copying selection quit the conversation'

        # Start a fresh triple-click sequence after the multi-click window.
        time.sleep(.55)
        click_at(x, y)
        click_at(x, y)
        click_at(x, y)
        assert 'SHORT message' in ' '.join(highlighted().split()), (highlighted(), text())
        before_copy = output.count(b'\x1b]52;c;')
        assert before_copy == 1, 'Triple-click copied without an explicit copy shortcut'
        keys(b'\x03')
        encoded = bytes(output).rsplit(b'\x1b]52;c;', 1)[1].split(b'\x07', 1)[0]
        assert 'SHORT message' in base64.b64decode(encoded).decode(), encoded
        keys(b'\x1b')
        assert highlighted() == '', highlighted()
        keys(b'/quit\r')
        process.wait(timeout=5)
        assert process.returncode == 0
        print(f'PASS {width} columns: modified Enter, multiline submission, named state hover, word/line selection and explicit copy')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
