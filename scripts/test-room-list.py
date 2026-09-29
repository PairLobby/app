"""Real PTY and isolated relay: sortable room/session navigation and safe lifecycle actions."""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, tempfile, termios, time
import pyte
cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', os.path.abspath('packages/cli/dist/main.js'))]
with tempfile.TemporaryDirectory(prefix='pairlobby-room-browser-') as directory:
    shutil.copyfile('scripts/fixtures/codex-receiver.mjs', directory+'/codex')
    os.chmod(directory+'/codex', 0o755)
    env = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory+'/device', 'PAIRLOBBY_ROOM': '', 'PAIRLOBBY_SESSION': '', 'CODEX_THREAD_ID': '', 'CODEX_SESSION_ID': '', 'CLAUDE_CODE_SESSION_ID': '', 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells', 'PATH': directory+os.pathsep+os.environ['PATH'], 'PAIRLOBBY_TEST_RECORD': directory+'/calls'}
    relay = subprocess.Popen(cli+['serve', '--port', '0', '--data-dir', directory+'/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    terminal = None
    master = None
    helper = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        server = re.search(r'http://\S+', relay.stdout.readline()).group(0)
        def run(*args): return json.loads(subprocess.check_output(cli+list(args)+['--json'], env=env, text=True, timeout=10))
        first = run('create', '--name', 'Room 2', '--human', '--as', 'Owner', '--server', server)
        second = run('create', '--name', 'Room 10', '--human', '--as', 'Zed', '--server', server)
        helper = run('join', first['invite']['code'], '--agent', '--runtime', 'codex', '--model', 'fixture-model', '--as', 'Helper', '--server', server)
        def state(room): return run('status', '--room', room['roomId'], '--session', room['sessionId'])
        # JSON stays machine-readable even when stdout is a terminal.
        output, slave = pty.openpty()
        process = subprocess.Popen(cli+['list', '--json', '--sort', 'name', '--desc'], stdin=slave, stdout=slave, stderr=subprocess.PIPE, env=env)
        os.close(slave)
        raw = bytearray()
        while select.select([output], [], [], 5)[0]:
            try: data = os.read(output, 65536)
            except OSError: break
            if not data: break
            raw.extend(data)
        process.wait(timeout=5)
        os.close(output)
        assert process.returncode == 0, process.stderr.read().decode()
        assert b'\x1b' not in raw
        listed = json.loads(raw)
        assert [room['name'] for room in listed['rooms']] == ['Room 10', 'Room 2']
        assert all(room['reachable'] for room in listed['rooms'])
        assert len(next(room for room in listed['rooms'] if room['roomId']==first['roomId'])['sessions']) == 2
        before = state(first)['latestSeq']
        run('list')
        assert state(first)['latestSeq'] == before, 'listing must not acknowledge or join'
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 140, 0, 0))
        terminal = subprocess.Popen(cli+['list'], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        screen = pyte.Screen(140, 28)
        stream = pyte.Stream(screen)
        def pump(seconds=.15):
            end=time.monotonic()+seconds
            while time.monotonic()<end:
                if select.select([master], [], [], .025)[0]:
                    try: stream.feed(os.read(master, 65536).decode(errors='replace'))
                    except OSError: return
        def text(): return '\n'.join(screen.display)
        def keys(value): os.write(master, value); pump()
        def wait_for(value):
            end=time.monotonic()+10
            while time.monotonic()<end:
                pump(.1)
                if value in text(): return
            raise AssertionError(value+'\n'+text())
        def selected(): return '\n'.join(screen.display[y] for y in range(4,screen.lines-3) if any(cell.bg=='cyan' for cell in screen.buffer[y].values()))
        def choose(label):
            keys(b'\x1b[H')
            for _ in range(20):
                if label in selected(): return
                keys(b'\x1b[B')
            raise AssertionError('No row '+label+'\n'+text())
        wait_for('Snapshot updated')
        assert 'Room 2' in screen.display[4], text()
        keys(b'\x1b[<0;3;4M\x1b[<0;3;4m')
        wait_for('name descending')
        assert 'Room 10' in screen.display[4], text()
        keys(b's')
        wait_for('name ascending')
        choose('Room 2'); keys(b'\r')
        wait_for('Local sessions')
        choose('Helper'); keys(b'i')
        wait_for('Session — Helper')
        assert 'Session ID' in text(), text()
        keys(b'\x1b'); wait_for('Local sessions')
        choose('Helper'); keys(b'c')
        wait_for('Close local session')
        keys(b'\x1b'); wait_for('Local sessions')
        assert next(p for p in state(first)['participants'] if p['participantId']==helper['participantId'])['left'] is False
        keys(b'c'); wait_for('Close local session')
        keys(b'\x1b[B\r')
        wait_for('Session left')
        assert 'Left' in selected(), text()
        assert next(p for p in state(first)['participants'] if p['participantId']==helper['participantId'])['left'] is True
        assert next(p for p in state(first)['participants'] if p['participantId']==first['participantId'])['left'] is False
        assert run('receiver', 'status', '--room', first['roomId'], '--session', helper['sessionId'])['state']=='stopped'
        keys(b'i'); wait_for('Session — Helper')
        keys(b'\x1b[F\r'); wait_for('process queued requests')
        keys(b'\x1b[B\r'); wait_for('Receiver started.')
        assert next(p for p in state(first)['participants'] if p['participantId']==helper['participantId'])['left'] is False
        keys(b'i'); wait_for('Session — Helper')
        keys(b'\x1b[F\x1b[A\r'); wait_for('It stays joined')
        keys(b'\x1b[B\r'); wait_for('Receiver stopped; room membership unchanged.')
        assert next(p for p in state(first)['participants'] if p['participantId']==helper['participantId'])['left'] is False
        assert run('receiver', 'status', '--room', first['roomId'], '--session', helper['sessionId'])['state']=='stopped'
        assert not os.path.exists(directory+'/calls'), 'navigation and idle receiver lifecycle must not invoke a model'
        keys(b'\x1b'); wait_for('PairLobby rooms')
        choose('Room 10'); keys(b'\r'); wait_for('Local sessions')
        choose('Zed'); keys(b'\r'); wait_for('registered in this room')
        keys(b'/quit\r'); wait_for('Local sessions')
        assert 'Left' in text(), text()
        choose('Zed'); keys(b'\r'); wait_for('registered in this room')
        keys(b'/quit\r'); wait_for('Local sessions')
        keys(b'\x1b'); wait_for('PairLobby rooms')
        choose('Room 2'); keys(b'c'); wait_for('Close room for everyone')
        keys(b'\x1b'); wait_for('PairLobby rooms')
        assert state(first)['lifecycle']=='open'
        keys(b'c'); wait_for('Close room for everyone')
        keys(b'\x1b[B\r'); wait_for('Room closed for everyone')
        assert state(first)['lifecycle']=='closed'
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH',18,62,0,0))
        screen.resize(18,62); terminal.send_signal(signal.SIGWINCH); pump(.4)
        keys(b'\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C')
        assert 'Room ID' in text() or 'Expires' in text(), text()
        keys(b'q')
        terminal.wait(timeout=5)
        assert terminal.returncode==0
        print('PASS pure JSON in a TTY, natural sorting and clickable headers, sessions/details, close cancellation, exact-session leave, repeated chat/rejoin/return, owner room close and narrow-screen navigation.')
    finally:
        if terminal and terminal.poll() is None:
            terminal.kill(); terminal.wait(timeout=5)
        if master is not None: os.close(master)
        if helper:
            subprocess.run(cli+['receiver','stop','--room',first['roomId'],'--session',helper['sessionId'],'--json'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        relay.terminate(); relay.wait(timeout=5)
