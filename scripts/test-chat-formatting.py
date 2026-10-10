"""Real PTY and isolated relay: Markdown in the chat transcript is drawn styled, and a long answer folds to one line and back."""
import fcntl, json, os, pty, re, select, struct, subprocess, tempfile, termios, time
import pyte
cli = ['node', os.environ.get('PAIRLOBBY_TEST_CLI', os.path.abspath('packages/cli/dist/main.js'))]
with tempfile.TemporaryDirectory(prefix='pairlobby-chat-format-') as directory:
    env = {**os.environ, 'PAIRLOBBY_DATA_DIR': directory+'/device', 'PAIRLOBBY_ROOM': '', 'PAIRLOBBY_SESSION': '', 'CODEX_THREAD_ID': '', 'CODEX_SESSION_ID': '', 'CLAUDE_CODE_SESSION_ID': '', 'TERM': 'xterm-256color', 'PAIRLOBBY_NO_UPDATE_CHECK': '1'}
    other = {**env, 'PAIRLOBBY_DATA_DIR': directory+'/other'}
    relay = subprocess.Popen(cli+['serve', '--port', '0', '--data-dir', directory+'/relay'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    terminal = None
    master = None
    try:
        assert select.select([relay.stdout], [], [], 10)[0]
        server = re.search(r'http://\S+', relay.stdout.readline()).group(0)
        def run(environment, *args): return json.loads(subprocess.check_output(cli+list(args)+['--json'], env=environment, text=True, timeout=15))
        room = run(env, 'create', '--name', 'Formatting', '--human', '--as', 'Owner', '--server', server)
        peer = run(other, 'join', room['invite']['code'], '--human', '--as', 'Peer', '--server', server)
        def say(text): return run(other, 'send', text, '--room', peer['roomId'], '--session', peer['sessionId'])
        say('Done: **heavy** and *leaning* with `snippet`\n```json\n{"ok":true,"name":"room"}\n```\n- listed')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
        terminal = subprocess.Popen(cli+['chat', '--room', room['roomId'], '--session', room['sessionId']], stdin=slave, stdout=slave, stderr=slave, env=env)
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
        wait_for('listed')
        # The markers are gone and the styling is real terminal attributes, not characters.
        assert '**' not in text() and '`' not in text() and '```' not in text(), text()
        assert cell('heavy')[0].bold and not cell('heavy')[0].underscore
        assert cell('leaning')[0].underscore and not cell('leaning')[0].bold
        assert cell('snippet')[0].fg == 'cyan'
        assert cell('"ok"')[0].fg == 'brightblue' and cell('true')[0].fg == 'magenta' and cell('"room"')[0].fg == 'green'
        assert '"ok": true,' in text() and '• listed' in text(), 'JSON is re-indented and list items get a bullet\n'+text()
        assert not cell('Done:')[0].bold
        # A new long answer arrives fully shown; folding is only ever the person's choice.
        say('Summary line\n'+'\n'.join(f'detail {n}' for n in range(1, 13)))
        wait_for('detail 12')
        assert '… +' not in text(), text()
        keys(b'/collapse\r'); wait_for('Summary line … +12 lines'); wait_for('detail 3', False)
        assert '"ok": true,' in text(), 'only the latest message folds'
        keys(b'/expand\r'); wait_for('detail 12')
        # Clicking the marker beside a message folds and unfolds it.
        marker, x, y = cell('▾')
        os.write(master, f'\x1b[<0;{x+1};{y+1}M'.encode()); pump(.2); os.write(master, f'\x1b[<0;{x+1};{y+1}m'.encode()); pump(.4)
        wait_for('▸')
        folded = text().count('… +')
        assert folded == 1, text()
        marker, x, y = cell('▸')
        os.write(master, f'\x1b[<0;{x+1};{y+1}M'.encode()); pump(.2); os.write(master, f'\x1b[<0;{x+1};{y+1}m'.encode()); pump(.4)
        wait_for('… +', False)
        keys(b'/collapse all\r'); wait_for('Summary line … +12 lines'); wait_for('"ok": true,', False)
        assert 'Done: heavy and leaning with snippet … +' in text(), text()
        # Something that arrives while others are folded is still shown in full.
        say('Fresh\nanswer body')
        wait_for('answer body')
        keys(b'/expand all\r'); wait_for('detail 12'); wait_for('"ok": true,')
        # Folding is display only: the room still holds the whole message.
        stored = json.dumps(run(other, 'read', '--room', peer['roomId'], '--session', peer['sessionId'], '--after', '0'))
        assert '**heavy**' in stored and 'detail 12' in stored, 'agents and JSON output keep the text as written'
        keys(b'/quit\r')
        terminal.wait(timeout=5)
        print('PASS bold, emphasis, code and JSON drawn with real attributes; long answers arrive open; /collapse, /expand, all, and the click marker fold and unfold; stored text unchanged')
    finally:
        if terminal and terminal.poll() is None:
            terminal.kill(); terminal.wait(timeout=5)
        if master is not None: os.close(master)
        relay.terminate(); relay.wait(timeout=5)
