"""Real PTY and isolated relay: a member is refused a room command, the owner allows it from the shell, and the member's chat shows the change and can use it."""
import fcntl, json, os, pty, re, select, struct, subprocess, tempfile, termios, time
import pyte
cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', os.path.abspath('packages/cli/dist/main.js'))]
with tempfile.TemporaryDirectory(prefix='pairlobby-room-permissions-') as directory:
    env = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory+'/device', 'PAIRLOBBY_ROOM': '', 'PAIRLOBBY_SESSION': '', 'CODEX_THREAD_ID': '', 'CODEX_SESSION_ID': '', 'CLAUDE_CODE_SESSION_ID': '', 'TERM': 'xterm-256color', 'PAIRLOBBY_NO_UPDATE_CHECK': '1'}
    other = {**env, 'PAIRLOBBY_DATA_DIR': directory+'/other'}
    relay = subprocess.Popen(cli+['serve', '--port', '0', '--data-dir', directory+'/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        server = re.search(r'http://\S+', relay.stdout.readline()).group(0)
        def run(environment, *args): return json.loads(subprocess.check_output(cli+list(args)+['--json'], env=environment, text=True, timeout=15))
        room = run(env, 'create', '--name', 'Permissions', '--human', '--as', 'Owner', '--server', server)
        peer = run(other, 'join', room['invite']['code'], '--human', '--as', 'Peer', '--server', server)
        def say(text): return run(other, 'send', text, '--room', peer['roomId'], '--session', peer['sessionId'])
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
        terminal = subprocess.Popen(cli+['chat', '--room', peer['roomId'], '--session', peer['sessionId']], stdin=slave, stdout=slave, stderr=slave, env=other)
        os.close(slave)
        screen = pyte.Screen(110, 30)
        stream = pyte.Stream(screen)
        def pump(seconds=.2):
            end = time.monotonic()+seconds
            while time.monotonic() < end:
                if select.select([master], [], [], .025)[0]:
                    try: stream.feed(os.read(master, 65536).decode(errors='replace'))
                    except OSError: return
        def text(): return '\n'.join(screen.display)
        def keys(value): os.write(master, value); pump(.4)
        def wait_for(value, present=True):
            end = time.monotonic()+10
            while time.monotonic() < end:
                pump(.1)
                if (value in text()) == present: return
            raise AssertionError(('missing ' if present else 'still shown ')+value+'\n'+text())
        wait_for('/help for commands')
        # Nothing was allowed yet: the relay refuses, and the chat says why.
        keys(b'/lock\r'); wait_for('does not let you lock')
        keys(b'/permissions allow lock\r'); wait_for('only the room owner and admins change command permissions')
        # The owner allows it from the shell; the member's transcript says who changed what.
        changed = run(env, 'permissions', 'allow', 'lock', 'turns', '--room', room['roomId'], '--session', room['sessionId'])
        assert changed['members']['lock'] is True and changed['members']['kick'] is False, changed
        wait_for('the owner changed command permissions: members may now lock and unlock the room')
        keys(b'/lock\r'); wait_for('Room locked.')
        keys(b'/unlock\r'); wait_for('Room unlocked.')
        keys(b'/permissions\r'); wait_for('lock    members'); wait_for('kick    owner and admins only (default)')
        # One member can be refused what the room allows, and sees that too.
        one = run(env, 'permissions', 'deny', 'lock', 'Peer', '--room', room['roomId'], '--session', room['sessionId'])
        assert [person['effective']['lock'] for person in one['participants'] if person['displayName'] == 'Peer'] == [False], one
        wait_for('Peer may no longer lock and unlock the room')
        refusals = text().count('does not let you lock')
        keys(b'/lock\r'); pump(1)
        assert text().count('does not let you lock') == refusals+1 and text().count('Room locked.') == 1, text()
        keys(b'/permissions\r'); wait_for('Peer: lock not allowed')
        # A preset is saved on this device from the room as it stands, and a matching room needs no change.
        keys(b'/preset save demo\r'); wait_for('Saved preset demo from this room.')
        keys(b'/preset apply demo\r'); wait_for('This room already matches preset demo.')
        saved = json.load(open(directory+'/other/presets.json'))
        assert saved['presets'][0]['permissions'] == {'lock': True, 'turns': True} and 'participant' not in json.dumps(saved), saved
        keys(b'/quit\r')
        terminal.wait(timeout=5)
        print('PASS a member is refused until the owner allows the command; the change appears in the transcript; one member can be refused; /permissions and /preset work in the real terminal')
    finally:
        if terminal and terminal.poll() is None:
            terminal.kill(); terminal.wait(timeout=5)
        if master is not None: os.close(master)
        relay.terminate(); relay.wait(timeout=5)
