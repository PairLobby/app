# Isolated transport/idle probe: never connects to a real model provider.
import json, subprocess, tempfile, threading, time, http.server, tomllib, queue
from pathlib import Path
requests=[]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append({'method':self.command,'path':self.path}); self.send_response(200 if self.command=='GET' else 503); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"models": []}')
    def do_POST(self):
        requests.append({'method':self.command,'path':self.path}); self.send_response(200 if self.command=='GET' else 503); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"models": []}')
    def log_message(self,*args): pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
config=tomllib.loads((Path.home() / '.codex/config.toml').read_text())
args=['codex','app-server','--stdio','-c','model_provider="pairlobby_idle_probe"','-c','model="unused-idle-probe"','-c','model_providers.pairlobby_idle_probe.name="PairLobby idle probe"','-c',f'model_providers.pairlobby_idle_probe.base_url="http://127.0.0.1:{server.server_port}/v1"','-c','model_providers.pairlobby_idle_probe.wire_api="responses"','-c','model_providers.pairlobby_idle_probe.requires_openai_auth=false']
for name in config.get('mcp_servers',{}): args.extend(['-c',f'mcp_servers.{json.dumps(name)}.enabled=false'])
messages=queue.Queue();observed=[]
with tempfile.TemporaryDirectory(prefix='pairlobby-idle-thread-') as cwd:
    process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    def read():
        for line in process.stdout:
            try: message=json.loads(line)
            except ValueError: continue
            observed.append(message.get('method')); messages.put(message)
    threading.Thread(target=read,daemon=True).start()
    def send(message): process.stdin.write(json.dumps(message)+'\n');process.stdin.flush()
    def response(identifier):
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            item=messages.get(timeout=max(.1,deadline-time.monotonic()))
            if item.get('id')==identifier:
                if 'error' in item:raise RuntimeError(item['error'])
                return item['result']
        raise TimeoutError('App Server did not respond')
    try:
        send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'pairlobby_idle_probe','version':'0.1.0'}}});response(1)
        send({'method':'initialized','params':{}})
        send({'id':2,'method':'thread/start','params':{'cwd':cwd,'ephemeral':True,'modelProvider':'pairlobby_idle_probe','model':'unused-idle-probe','sandbox':'read-only'}})
        result=response(2)
        print(json.dumps({'initialized':True,'ephemeral_thread_created':bool(result.get('thread',{}).get('id'))}),flush=True)
        time.sleep(20)
        turns=observed.count('turn/started');tokens=sum(method=='thread/tokenUsage/updated' for method in observed)
        print(json.dumps({'idle_seconds':20,'mock_provider_requests':requests,'turn_started_events':turns,'token_usage_events':tokens}),flush=True)
        assert not any(request['method']=='POST' for request in requests) and turns==0 and tokens==0
        assert result.get('modelProvider')=='pairlobby_idle_probe', 'Unexpected provider; refusing to start a probe turn'
        send({'id':3,'method':'turn/start','params':{'threadId':result['thread']['id'],'input':[{'type':'text','text':'Controlled PairLobby wake probe; fake provider only.'}]}})
        response(3)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline and not any(request['method']=='POST' for request in requests):time.sleep(.05)
        assert any(request['method']=='POST' for request in requests), 'No model dispatch after turn/start'
        print(json.dumps({'wake_event_started_turn':True,'generation_dispatched_only_after_input':True,'provider_is_local_test_stub':True}),flush=True)

    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        server.shutdown();server.server_close()
