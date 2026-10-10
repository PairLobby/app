"""Real PTY and isolated relay: sortable room/session navigation and safe lifecycle actions."""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, tempfile, termios, time
import pyte
cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', os.path.abspath('packages/cli/dist/main.js'))]
with tempfile.TemporaryDirectory(prefix='pairlobby-room-browser-') as directory:
    shutil.copyfile('scripts/fixtures/codex-receiver.mjs', directory+'/codex')
    os.chmod(directory+'/codex', 0o755)
    env = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory+'/device', 'PAIRLOBBY_ROOM': '', 'PAIRLOBBY_SESSION': '', 'CODEX_THREAD_ID': '', 'CODEX_SESSION_ID': '', 'CLAUDE_CODE_SESSION_ID': '', 'TERM': 'xterm-256color', 'PAIRLOBBY_GRAPHICS': 'cells', 'PATH': directory+os.pathsep+os.environ['PATH'], 'PAIRLOBBY_TEST_RECORD': directory+'/calls', 'PAIRLOBBY_NO_NETWORK_SEARCH': '1'}
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
        agent_only = run('create', '--name', 'Room 20', '--agent', '--runtime', 'codex', '--as', 'Solo Agent', '--server', server)
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
        assert [room['name'] for room in listed['rooms']] == ['Room 20', 'Room 10', 'Room 2']
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
        assert 'Room 20' in screen.display[4], text()
        keys(b's')
        wait_for('name ascending')
        choose('Room 2'); keys(b'i')
        wait_for('Local sessions')
        choose('Helper'); keys(b'i')
        wait_for('Session — Helper')
        assert 'Session ID' in text(), text()
        assert 'Inactivity limit' in text() and 'Absolute limit' in text(), text()
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
        choose('Room 10'); keys(b'\r'); wait_for('registered in this room')
        keys(b'/quit\r'); wait_for('PairLobby rooms')
        assert 'Room 10' in selected(), text()
        choose('Room 10'); keys(b'i'); wait_for('Local sessions')
        choose('Zed'); keys(b'\r'); wait_for('registered in this room')
        keys(b'/quit\r'); wait_for('Local sessions')
        assert 'Left' in text(), text()
        choose('Zed'); keys(b'\r'); wait_for('registered in this room')
        keys(b'/quit\r'); wait_for('Local sessions')
        keys(b'\x1b'); wait_for('PairLobby rooms')
        choose('Room 20'); keys(b'\r'); wait_for('registered in this room')
        keys(b'/quit\r'); wait_for('PairLobby rooms')
        saved = next(room for room in run('list')['rooms'] if room['roomId']==agent_only['roomId'])
        assert sorted(session['kind'] for session in saved['sessions']) == ['agent', 'human'], saved
        choose('Room 2'); keys(b'c'); wait_for('Close room for everyone')
        keys(b'\x1b'); wait_for('PairLobby rooms')
        assert state(first)['lifecycle']=='open'
        keys(b'c'); wait_for('Close room for everyone')
        keys(b'\x1b[B\r'); wait_for('Room closed for everyone')
        assert state(first)['lifecycle']=='closed'
        # Backspace: back out of a room's sessions, but on the room list it deletes, and only after asking.
        choose('Room 10'); keys(b'i'); wait_for('Local sessions')
        keys(b'\x7f'); wait_for('PairLobby rooms')
        assert any(room['roomId']==second['roomId'] for room in run('list')['rooms']), 'Backspace inside a room only goes back'
        choose('Room 10'); keys(b'\x7f'); wait_for('Delete room for everyone')
        assert 'cannot be undone' in text(), text()
        keys(b'\r'); wait_for('PairLobby rooms')
        assert state(second)['lifecycle']=='open', 'Cancel is the default answer'
        choose('Room 10'); keys(b'\x1b[3~'); wait_for('Delete room for everyone')
        keys(b'\x1b[B\r'); wait_for('Deleted Room 10 for everyone')
        assert all(room['roomId']!=second['roomId'] for room in run('list')['rooms'])
        assert 'Room 10' not in '\n'.join(screen.display[4:-3]), text()
        gone = subprocess.run(cli+['join', second['invite']['code'], '--human', '--as', 'Late', '--server', server, '--json'], env=env, capture_output=True, text=True, timeout=10)
        assert gone.returncode!=0, 'a deleted room admits nobody'
        # A room this device does not own is only removed from this device.
        other = {**env, 'PAIRLOBBY_DATA_DIR': directory+'/other-device'}
        theirs = json.loads(subprocess.check_output(cli+['create', '--name', 'Room 30', '--human', '--as', 'Host', '--server', server, '--json'], env=other, text=True, timeout=10))
        visitor = run('join', theirs['invite']['code'], '--human', '--as', 'Visitor', '--server', server)
        keys(b'r'); wait_for('Room 30')
        choose('Room 30'); keys(b'\x7f'); wait_for('Remove room from this device')
        assert 'from this device? You leave the room' in text(), text()
        keys(b'\x1b[B\r'); wait_for('Removed Room 30 from this device')
        assert all(room['roomId']!=theirs['roomId'] for room in run('list')['rooms'])
        remaining = json.loads(subprocess.check_output(cli+['status', '--room', theirs['roomId'], '--session', theirs['sessionId'], '--json'], env=other, text=True, timeout=10))
        assert remaining['lifecycle']=='open', 'the room is untouched for its owner'
        assert next(p for p in remaining['participants'] if p['participantId']==visitor['participantId'])['left'] is True
        keys(b'\x1b'); terminal.wait(timeout=5)
        assert terminal.returncode==0, 'Escape still quits from the room list'
        master2, slave2 = pty.openpty()
        fcntl.ioctl(slave2, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 140, 0, 0))
        os.close(master); master = master2
        terminal = subprocess.Popen(cli+['list'], stdin=slave2, stdout=slave2, stderr=slave2, env=env)
        os.close(slave2)
        screen.reset(); wait_for('PairLobby rooms'); wait_for('Room 2')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH',18,62,0,0))
        screen.resize(18,62); terminal.send_signal(signal.SIGWINCH); pump(.4)
        keys(b'\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C')
        assert 'Room ID' in text() or 'Expires' in text(), text()
        keys(b'q')
        terminal.wait(timeout=5)
        assert terminal.returncode==0
        print('PASS Backspace deletes an owned room after asking and only removes one that is not owned, pure JSON in a TTY, natural sorting and clickable headers, Enter-to-chat including an agent-only room, I session inspection, close cancellation, exact-session leave, repeated chat/rejoin/return, owner room close and narrow-screen navigation.')
    finally:
        if terminal and terminal.poll() is None:
            terminal.kill(); terminal.wait(timeout=5)
        if master is not None: os.close(master)
        if helper:
            subprocess.run(cli+['receiver','stop','--room',first['roomId'],'--session',helper['sessionId'],'--json'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if 'agent_only' in locals():
            subprocess.run(cli+['receiver','stop','--room',agent_only['roomId'],'--session',agent_only['sessionId'],'--json'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        relay.terminate(); relay.wait(timeout=5)
