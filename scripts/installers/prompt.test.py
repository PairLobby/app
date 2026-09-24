"""Exercise installer prompts with piped stdin and a real controlling terminal."""
import errno
import http.server
import os
from pathlib import Path
import pty
import select
import shutil
import tempfile
import multiprocessing
import time
import unittest


class PromptTests(unittest.TestCase):
    def test_prompt_choices_with_redirected_stdin(self):
        public = Path(os.environ.get('PAIRLOBBY_TEST_INSTALLER_DIR', '../frontend/public')).resolve()
        installer = public / 'install.mjs'
        node = shutil.which('node')

        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(public), **kwargs)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server_process = multiprocessing.get_context('fork').Process(target=server.serve_forever)
        server_process.start()
        try:
            for answer, choice, agent in [('n', None, None), ('y', '1', 'claude'), ('y', '2', 'codex'), ('y', '3', 'qwen')]:
                with self.subTest(agent=agent), tempfile.TemporaryDirectory(prefix='pairlobby-prompt-') as directory:
                    root = Path(directory)
                    args = [node, str(installer)]
                    if agent:
                        args.extend(['--skills-dir', str(root / 'skills')])
                    env = dict(os.environ, PAIRLOBBY_DOWNLOAD_BASE=f'http://127.0.0.1:{server.server_port}', PAIRLOBBY_INSTALL_DIR=str(root / 'app'), PAIRLOBBY_BIN_DIR=str(root / 'bin'), PAIRLOBBY_SKIP_PATH='1')
                    child, terminal = pty.fork()
                    if child == 0:
                        # curl | sh gives the installer non-terminal stdin.
                        with open(os.devnull, 'rb') as pipe:
                            os.dup2(pipe.fileno(), 0)
                        os.execvpe(node, args, env)
                    output = ''
                    answered = selected = False
                    try:
                        deadline = time.monotonic() + 30
                        while time.monotonic() < deadline:
                            if not select.select([terminal], [], [], 1)[0]:
                                continue
                            try:
                                data = os.read(terminal, 65536)
                            except OSError as error:
                                if error.errno == errno.EIO:
                                    break
                                raise
                            if not data:
                                break
                            output += data.decode(errors='replace')
                            if not answered and 'Install agent skills?' in output:
                                os.write(terminal, (answer + '\n').encode())
                                answered = True
                            if choice and not selected and 'Which agents?' in output:
                                os.write(terminal, (choice + '\n').encode())
                                selected = True
                        else:
                            os.kill(child, 15)
                            self.fail('Installer prompt timed out: ' + output)
                        _, status = os.waitpid(child, 0)
                        self.assertEqual(os.waitstatus_to_exitcode(status), 0, output)
                        self.assertTrue(answered, output)
                        self.assertEqual((root / 'skills/pairlobby/SKILL.md').exists(), bool(agent), output)
                        if agent:
                            self.assertIn(f'Installed {agent} skill.', output)
                        else:
                            self.assertNotIn('Which agents?', output)
                    finally:
                        os.close(terminal)
        finally:
            server_process.terminate()
            server_process.join()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
