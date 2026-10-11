"""Real PTY and isolated relay: files are attached from chat, shown under their message, listed, opened as text or JSON and saved without replacing anything."""
import fcntl, json, os, pty, re, select, struct, subprocess, tempfile, termios, time
import pyte
cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', os.path.abspath('packages/cli/dist/main.js'))]
with tempfile.TemporaryDirectory(prefix='pairlobby-chat-files-') as directory:
    env = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory+'/device', 'PAIRLOBBY_ROOM': '', 'PAIRLOBBY_SESSION': '', 'CODEX_THREAD_ID': '', 'CODEX_SESSION_ID': '', 'CLAUDE_CODE_SESSION_ID': '', 'TERM': 'xterm-256color', 'PAIRLOBBY_NO_UPDATE_CHECK': '1'}
    other = {**env, 'PAIRLOBBY_DATA_DIR': directory+'/other'}
    relay = subprocess.Popen(cli+['serve', '--port', '0', '--data-dir', directory+'/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        server = re.search(r'http://\S+', relay.stdout.readline()).group(0)
        def run(environment, *args): return json.loads(subprocess.check_output(cli+list(args)+['--json'], env=environment, text=True, timeout=15))
        room = run(env, 'create', '--name', 'Files', '--human', '--as', 'Owner', '--server', server)
        peer = run(other, 'join', room['invite']['code'], '--human', '--as', 'Peer', '--server', server)
        def say(text): return run(other, 'send', text, '--room', peer['roomId'], '--session', peer['sessionId'])
        work = directory+'/work'; os.mkdir(work)
        open(work+'/notes.txt', 'w').write('first line\n')
        open(work+'/my data.json', 'w').write('{"kind":"data"}')
        open(directory+'/out.json', 'w').write('{"ok":true,"name":"room"}')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
        terminal = subprocess.Popen(cli+['chat', '--room', room['roomId'], '--session', room['sessionId']], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=work)
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
        def cell(word):
            for y, line in enumerate(screen.display):
                x = line.find(word)
                if x >= 0: return screen.buffer[y][x], x, y
            raise AssertionError('not on screen: '+word+'\n'+text())
        wait_for('/help for commands')
        # Two files and a message in one command; a quoted path keeps its space.
        keys(b'/attach notes.txt "my data.json" here they are\r')
        wait_for('here they are'); wait_for('\u25aa notes.txt ~ 11 B'); wait_for('\u25aa my data.json ~ 15 B')
        keys(b'/attach missing.txt oops\r'); wait_for('not sent'); wait_for('no file at missing.txt')
        assert 'oops' not in text().replace('missing.txt oops', ''), 'a mistyped path is not sent as text'
        # A file from someone else appears under their message as it arrives.
        sent = run(other, 'send', 'Result attached', '--file', directory+'/out.json', '--room', peer['roomId'], '--session', peer['sessionId'], '--no-wait')
        wait_for('Result attached'); wait_for('\u25aa out.json ~ 25 B')
        keys(b'/files\r'); wait_for('1  notes.txt'); wait_for('3  out.json ~ 25 B ~ from Peer')
        # Opening draws it like a fenced block: JSON is re-indented and coloured.
        keys(b'/open 3\r'); wait_for('"ok": true,')
        assert cell('"ok"')[0].fg == 'brightblue' and cell('"room"')[0].fg == 'green', 'an opened JSON file is coloured'
        keys(b'/open notes.txt\r'); wait_for('first line')
        # Saving never replaces: the second copy gets a number.
        keys(b'/save 3\r'); wait_for('Saved out.json ~ 25 B to'); assert open(work+'/out.json').read() == '{"ok":true,"name":"room"}'
        keys(b'/save out.json\r'); wait_for('out (1).json'); assert os.path.exists(work+'/out (1).json')
        assert not os.access(work+'/out.json', os.X_OK)
        keys(b'/save 9\r'); wait_for('No file 9 in this room')
        # The room holds the files, not this terminal: the other device lists and fetches them.
        listed = run(other, 'files', '--room', peer['roomId'], '--session', peer['sessionId'])['files']
        assert [entry['name'] for entry in listed] == ['notes.txt', 'my data.json', 'out.json'], listed
        got = run(other, 'files', 'get', 'my data.json', '--out', directory+'/got', '--room', peer['roomId'], '--session', peer['sessionId'])
        assert open(got['path']).read() == '{"kind":"data"}'
        keys(b'/quit\r')
        terminal.wait(timeout=5)
        print('PASS /attach sends several files with a message and refuses a mistyped path; files show under messages from both sides; /files, /open (text and coloured JSON) and /save (never replacing) work; another device lists and fetches them')
    finally:
        if terminal and terminal.poll() is None:
            terminal.kill(); terminal.wait(timeout=5)
        if master is not None: os.close(master)
        relay.terminate(); relay.wait(timeout=5)
