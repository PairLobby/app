"""Real CLI + isolated relay: settings editing, permission changes and structured status."""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, tempfile, termios, time
import pyte
cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', os.path.abspath('packages/cli/dist/main.js'))]
with tempfile.TemporaryDirectory(prefix='pairlobby-settings-ui-') as directory:
    env = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory+'/device', 'PAIRLOBBY_ROOM': '', 'PAIRLOBBY_SESSION': '', 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells'}
    relay = subprocess.Popen(cli+['serve', '--port', '0', '--data-dir', directory+'/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        server = re.search(r'http://\S+', relay.stdout.readline()).group(0)
        def run(*args): return json.loads(subprocess.check_output(cli+list(args)+['--json'], env=env, text=True, timeout=10))
        owner = run('create', '--name', 'Settings demo', '--human', '--as', 'Owner', '--server', server)
        helper = run('join', owner['invite']['code'], '--human', '--as', 'Helper', '--server', server)
        scope = ['--room', owner['roomId'], '--session', owner['sessionId']]
        def snapshot(): return run('status', *scope)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 110, 0, 0))
        terminal = subprocess.Popen(cli+['chat', '--human', *scope], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        screen = pyte.Screen(110, 28)
        stream = pyte.Stream(screen)
        def pump(seconds=.15):
            end = time.monotonic()+seconds
            while time.monotonic()<end:
                if select.select([master], [], [], .025)[0]:
                    try: stream.feed(os.read(master, 65536).decode(errors='replace'))
                    except OSError: return
        def text(): return '\n'.join(screen.display)
        def keys(value): os.write(master, value); pump()
        def wait_for(value):
            end=time.monotonic()+8
            while time.monotonic()<end:
                pump(.1)
                if value in text(): return
            raise AssertionError(value+'\n'+text())
        def chosen():
            return '\n'.join(screen.display[y] for y in range(screen.lines) if any(cell.bg=='cyan' for cell in screen.buffer[y].values()))
        def choose(label):
            keys(b'\x1b[H')
            for _ in range(40):
                if label in chosen():
                    keys(b'\r'); return
                keys(b'\x1b[B')
            raise AssertionError('Cannot select '+label+'\n'+text())
        def option(label):
            for _ in range(12): keys(b'\x1b[A')
            for _ in range(15):
                if label in chosen(): keys(b'\r'); return
                keys(b'\x1b[B')
            raise AssertionError('Cannot choose '+label+'\n'+text())
        def confirm(): keys(b'\x1b[B\r'); wait_for('Saved.')
        def command(value): keys(b'\x01\x0b'+value.encode()+b'\r')
        wait_for('No agents in the room')
        keys(b'/settings\rmy saved draft')
        wait_for('Room settings')
        choose('Room name')
        keys(b'\x01\x0bCancelled name')
        keys(b'\x1b')
        assert snapshot()['name']=='Settings demo'
        choose('Room name')
        keys(b'\x01\x0b'+ 'Renamed Café'.encode()+b'\r')
        wait_for('Saved.')
        assert snapshot()['name']=='Renamed Café'
        choose('Reply mode'); option('Parallel')
        wait_for('Saved.')
        assert snapshot()['turnMode']=='parallel'
        choose('Expiry'); option('In 1 hour')
        wait_for('Saved.')
        assert snapshot()['expiresAt']>int(time.time()*1000)+3_500_000
        choose('Guest access'); option('Anyone with room ID')
        keys(b'\x1b')
        assert snapshot()['policy']['joinPolicy']=='invite_only'
        choose('Guest access'); option('Anyone with room ID'); confirm()
        assert snapshot()['policy']['joinPolicy']=='open_to_guests'
        choose('Admission lock'); option('Locked —')
        wait_for('Saved.')
        assert snapshot()['locked'] is True
        choose('Admission lock'); option('Unlocked —')
        wait_for('Saved.')
        assert snapshot()['locked'] is False
        choose('Admins and members')
        wait_for('Admins and members')
        choose('Helper')
        wait_for('Member — Helper')
        choose('Admin access'); option('Admin —'); confirm()
        assert next(p for p in snapshot()['participants'] if p['participantId']==helper['participantId'])['role']=='controller'
        choose('Mute'); confirm()
        assert next(p for p in snapshot()['participants'] if p['participantId']==helper['participantId'])['muted'] is True
        choose('Unmute'); confirm()
        choose('Admin access'); option('Member —'); confirm()
        assert next(p for p in snapshot()['participants'] if p['participantId']==helper['participantId'])['role']=='member'
        keys(b'\x1b'); keys(b'\x1b'); keys(b'\x1b')
        wait_for('my saved draft')
        command('/status')
        wait_for('Room status')
        assert 'Members' in text() and 'Messages (retained)' in text(), text()
        assert any('Messages (retained)' in line and re.search(r'\b0\b',line) for line in screen.display), text()
        keys(b'\x1b[6~')
        wait_for('Created (UTC)')
        keys(b'r')
        wait_for('Refreshed.')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 62, 0, 0))
        screen.resize(18, 62); terminal.send_signal(signal.SIGWINCH); pump(.4)
        assert 'Room status' in text(), text()
        keys(b'\x1b')
        command('/quit')
        terminal.wait(timeout=5)
        assert terminal.returncode==0
        print('PASS settings edit/cancel, Unicode input, turns/expiry/privacy/lock, admin grant/revoke, mute/unmute, draft restoration, structured status, refresh and resize.')
    finally:
        if terminal and terminal.poll() is None:
            terminal.kill(); terminal.wait(timeout=5)
        if master is not None: os.close(master)
        relay.terminate(); relay.wait(timeout=5)
