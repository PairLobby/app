"""PTY integration check; requires Python pyte (install in an isolated virtualenv)."""
import os, pty, fcntl, termios, struct, subprocess, select, time, signal
import pyte
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
process = subprocess.Popen(['node', 'scripts/fixtures/terminal-receipts.mjs'], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM':os.environ.get('PAIRLOBBY_TEST_TERM', 'xterm-256color')})
os.close(slave)
screen=pyte.Screen(100,24); stream=pyte.Stream(screen)
raw_output = bytearray()
def pump(seconds=.3):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try: data=os.read(master,65536)
   except OSError: break
   if not data: break
   raw_output.extend(data)
   stream.feed(data.decode(errors='replace'))
def text(): return '\n'.join(screen.display)
def send(data): os.write(master,data); pump()
try:
 pump(.6)
 assert 'hey @codex' in text()
 assert 'Seen' not in '\n'.join(screen.display[:-2])
 send(b'draft stays here')
 pump(1.2)
 assert 'draft stays here' in text()
 row=next(i for i,line in enumerate(screen.display[:-2]) if 'Seen' in line)
 column=screen.display[row].index('Seen')
 assert column>=92, (column, screen.display[row])
 assert 'hey @codex' in screen.display[row]
 send(f'\x1b[<35;{column+1};{row+1}M'.encode())
 assert 'Confirmed receipts' in text()
 assert 'Acknowledged 9/19/2026' in text() and 'codex' in text()
 assert 'Esc to close' not in text()
 receipt_line=next(line for line in screen.display if 'Acknowledged' in line)
 assert 'codex' in receipt_line
 assert receipt_line.index('Acknowledged') > receipt_line.index('codex') + len('codex')
 assert receipt_line.rstrip().endswith('PM x'), receipt_line
 send(b'\x1b[<35;1;20M')
 assert 'Confirmed receipts' not in text()
 send(f'\x1b[<0;{column+1};{row+1}M'.encode())
 send(f'\x1b[<0;{column+1};{row+1}m'.encode())
 send(b'\x1b[<35;1;20M')
 assert 'Confirmed receipts' in text()
 # A pinned popup survives clicks inside it, but any outside click dismisses it.
 popup_row=next(i for i,line in enumerate(screen.display) if 'Confirmed receipts' in line)
 popup_column=screen.display[popup_row].index('Confirmed receipts')
 send(f'\x1b[<0;{popup_column+1};{popup_row+1}M'.encode())
 send(f'\x1b[<0;{popup_column+1};{popup_row+1}m'.encode())
 assert 'Confirmed receipts' in text()
 for outside_row in [1, 20, 23, 24]:
  send(f'\x1b[<0;1;{outside_row}M'.encode())
  send(f'\x1b[<0;1;{outside_row}m'.encode())
  assert 'Confirmed receipts' not in text(), outside_row
  assert 'draft stays here' in text()
  send(f'\x1b[<0;{column+1};{row+1}M'.encode())
  send(f'\x1b[<0;{column+1};{row+1}m'.encode())
  assert 'Confirmed receipts' in text()
 send(b'\x1b')
 send(b'\x1bOQ')
 assert 'Confirmed receipts' in text()
 send(b'\x1b')
 assert 'Confirmed receipts' not in text()
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,60,0,0))
 screen.resize(24,60)
 process.send_signal(signal.SIGWINCH)
 pump(.5)
 assert any('Seen' in line and line.index('Seen')>=52 for line in screen.display[:-2])
 assert 'draft stays here' in text()
 send(b'\x01\x0bhellX\x1b[D\x1b[3~o\r')
 assert 'Input received: hello' in text()
 send(b'\x1b[A')
 assert '> hello' in text()
 send(b'\x01\x0b/fill\r')
 assert 'History row 39' in text(), text()
 send(b'\x1b[5~\x1b[5~\x1b[5~')
 assert 'hey @codex' in text()
 assert any('Seen' in line for line in screen.display[:-3])
 send(b'\x1b[6~\x1b[6~\x1b[6~')
 assert 'History row 39' in text(), text()
 send(b'\x01\x0b/exchange\r')
 for sender, reader in [('codex', 'claude'), ('claude', 'codex')]:
  exchange_row=next(i for i,line in enumerate(screen.display[:-3]) if f'{sender} to {reader}' in line)
  exchange_column=screen.display[exchange_row].index('Seen')
  send(f'\x1b[<0;{exchange_column+1};{exchange_row+1}M'.encode())
  send(f'\x1b[<0;{exchange_column+1};{exchange_row+1}m'.encode())
  receipt_lines=[line for line in screen.display if 'Acknowledged' in line]
  assert any(reader in line for line in receipt_lines), text()
  assert any('hjoncour' in line for line in receipt_lines), text()
  send(b'\x1b[<0;1;23M\x1b[<0;1;23m')
  assert 'Confirmed receipts' not in text()
 send(b'\x01\x0b/quit\r')
 process.wait(timeout=3)
 assert process.returncode==0
 assert b'Error on ' not in raw_output and b'stack.push' not in raw_output, 'Internal terminal compiler output leaked'
 print('PASS real terminal: delayed inline receipt, right alignment, hover/click/outside-click/F2/Escape, draft preservation, resize, exit')
finally:
 if process.poll() is None:
  process.kill()
  process.wait(timeout=3)
 os.close(master)
