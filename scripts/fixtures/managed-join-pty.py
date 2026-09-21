import os,pty,subprocess,select,time,sys,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'TERM':'xterm-256color'})
os.close(slave);output=''
try:
 deadline=time.monotonic()+12
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try:output+=os.read(master,65536).decode(errors='replace')
   except OSError:break
 p.wait(timeout=1)
 assert p.returncode==0, output
 assert 'Automatic receiver available' in output, output
 assert '\x1b[?1049h' not in output, 'Managed join opened a chat observer'
 print('PASS managed TTY join returns without opening an agent observer')
finally:
 if p.poll() is None:p.kill();p.wait()
 os.close(master)
