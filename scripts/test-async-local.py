"""Real local relay + Codex App Server, with a localhost-only synthetic model.

Run after npm run build. No live model calls; no changes to user runtime settings.
This is a bounded integration experiment, not the production background service.
"""
import argparse
import http.server
import json
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
import tomllib
import uuid


ROOT = Path(__file__).resolve().parents[1]
PROVIDER = 'pairlobby_local_test'


class JsonProcess:
    def __init__(self, args, cwd):
        self.errors = tempfile.TemporaryFile(mode='w+t')
        self.process = subprocess.Popen(args, cwd=cwd, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.errors, text=True)
        self.messages = queue.Queue()
        self.observed = []
        self.lock = threading.Lock()
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            message = json.loads(line)
            self.observed.append(message)
            self.messages.put(message)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()

    def call(self, message):
        with self.lock:
            self.send(message)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    result = self.messages.get(timeout=max(.1, deadline - time.monotonic()))
                except queue.Empty as error:
                    self.errors.seek(0)
                    detail = self.errors.read() if self.process.poll() is not None else 'Process still running'
                    raise TimeoutError(f'Child exit={self.process.poll()}; observed methods/ids: '
                                       f'{[(item.get("method"), item.get("id")) for item in self.observed]}; {detail}') from error
                if message.get('id') != result.get('id'):
                    continue
                if 'error' in result:
                    raise RuntimeError(result['error'])
                return result.get('result')
        raise TimeoutError('Local child did not respond')

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.errors.close()


class FakeProvider(http.server.BaseHTTPRequestHandler):
    calls = []
    event_id = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"models":[]}')

    def do_POST(self):
        # Read the request, but never log its context or forward it anywhere.
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.calls.append(self.path)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        response_id = 'resp_' + uuid.uuid4().hex
        self.emit('response.created', response={'id': response_id, 'status': 'in_progress', 'output': []})
        output = []
        for index, (channel, text) in enumerate([
            ('commentary', f'ACK:{self.event_id}'),
            ('final', f'Local synthetic answer for {self.event_id}')
        ]):
            item_id = 'msg_' + uuid.uuid4().hex
            item = {'id': item_id, 'type': 'message', 'role': 'assistant',
                    'channel': channel, 'status': 'in_progress', 'content': []}
            self.emit('response.output_item.added', output_index=index, item=item)
            self.emit('response.content_part.added', output_index=index, item_id=item_id,
                      content_index=0, part={'type': 'output_text', 'text': '', 'annotations': []})
            self.emit('response.output_text.delta', output_index=index, item_id=item_id,
                      content_index=0, delta=text)
            self.emit('response.output_text.done', output_index=index, item_id=item_id,
                      content_index=0, text=text)
            item = {**item, 'status': 'completed', 'content': [
                {'type': 'output_text', 'text': text, 'annotations': []}]}
            self.emit('response.output_item.done', output_index=index, item=item)
            output.append(item)
            # Leave time to verify receipt before the final answer is emitted.
            time.sleep(.3)
        self.emit('response.completed', response={
            'id': response_id, 'status': 'completed', 'output': output,
            'usage': {'input_tokens': 10, 'output_tokens': 10, 'total_tokens': 20,
                      'input_tokens_details': {'cached_tokens': 0}}})

    def emit(self, event, **fields):
        self.wfile.write(f'event: {event}\ndata: {json.dumps({"type": event, **fields})}\n\n'.encode())
        self.wfile.flush()


def wait_until(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.05)
    raise TimeoutError('Local integration assertion timed out')


def main():
    parser = argparse.ArgumentParser(description='PairLobby local asynchronous prototype: synthetic model only, no paid inference. Runs checks and exits; does not connect your existing agents.')
    parser.add_argument('--idle-seconds', type=float, default=10)
    options = parser.parse_args()
    assert options.idle_seconds >= 1
    print('PairLobby prototype — local synthetic model; automatic test, not a live agent connection.', flush=True)
    provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeProvider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    children = []
    stopped = threading.Event()
    enabled = threading.Event()
    failures = []
    receipts_before_reply = []
    bridge = None
    with tempfile.TemporaryDirectory(prefix='pairlobby-async-local-') as directory:
        try:
            relay = JsonProcess(['node', str(ROOT / 'scripts/async-local-relay.mjs'),
                                 str(Path(directory) / 'relay.sqlite')], ROOT)
            children.append(relay)
            assert relay.messages.get(timeout=10)['ready']

            args = ['codex', 'app-server', '--stdio', '-c', f'model_provider="{PROVIDER}"',
                    '-c', 'model="local-synthetic-model"',
                    '-c', f'model_providers.{PROVIDER}.name="PairLobby local test"',
                    '-c', f'model_providers.{PROVIDER}.base_url="http://127.0.0.1:{provider.server_port}/v1"',
                    '-c', f'model_providers.{PROVIDER}.wire_api="responses"',
                    '-c', f'model_providers.{PROVIDER}.requires_openai_auth=false']
            config_path = Path.home() / '.codex/config.toml'
            config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
            for name in config.get('mcp_servers', {}):
                if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
                    raise ValueError('Unsupported MCP name for isolated CLI override')
                args.extend(['-c', f'mcp_servers.{name}.enabled=false'])
            runtime = JsonProcess(args, ROOT)
            children.append(runtime)
            runtime.call({'id': 1, 'method': 'initialize', 'params': {
                'clientInfo': {'name': 'pairlobby_local_test', 'version': '0.1.0'}}})
            runtime.send({'method': 'initialized', 'params': {}})
            thread = runtime.call({'id': 2, 'method': 'thread/start', 'params': {
                'cwd': directory, 'ephemeral': True, 'modelProvider': PROVIDER,
                'model': 'local-synthetic-model', 'sandbox': 'read-only',
                'approvalPolicy': 'never', 'baseInstructions': 'Local transport test. Do not use tools.'}})
            assert thread['modelProvider'] == PROVIDER, 'Refusing unexpected provider'

            def room(operation, **fields):
                return relay.call({'operation': operation, **fields})

            def run_bridge():
                identifier = 10
                try:
                    while not stopped.wait(.1):
                        if not enabled.is_set():
                            continue
                        for request in room('pending'):
                            event_id = request['eventId']
                            if request['responseEventId'] or request.get('failureAt'):
                                continue
                            FakeProvider.event_id = event_id
                            cursor = len(runtime.observed)
                            identifier += 1
                            result = runtime.call({'id': identifier, 'method': 'turn/start', 'params': {
                                'threadId': thread['thread']['id'],
                                'input': [{'type': 'text', 'text': f'Request {event_id}: {request["text"]}'}]}})
                            turn_id = result['turn']['id']
                            acknowledged = False
                            answer = None
                            completed = False
                            deadline = time.monotonic() + 20
                            while time.monotonic() < deadline and not completed:
                                for message in runtime.observed[cursor:]:
                                    cursor += 1
                                    params = message.get('params', {})
                                    if params.get('turnId') == turn_id and message.get('method') == 'item/completed':
                                        item = params['item']
                                        if item['type'] != 'agentMessage':
                                            continue
                                        text = item['text']
                                        if text == f'ACK:{event_id}':
                                            room('ack', eventId=event_id)
                                            state = room('request', eventId=event_id)
                                            assert state['receivedAt'] is not None and state['responseEventId'] is None
                                            receipts_before_reply.append(event_id)
                                            acknowledged = True
                                        elif text.startswith('Local synthetic answer for '):
                                            answer = text
                                    if message.get('method') == 'turn/completed' and params['turn']['id'] == turn_id:
                                        assert params['turn']['status'] == 'completed', params['turn'].get('error')
                                        completed = True
                                time.sleep(.01)
                            assert completed and acknowledged and answer, 'Missing completion, explicit ACK, or final answer'
                            room('reply', eventId=event_id, text=answer)
                except Exception as error:
                    failures.append(error)

            def idle(label):
                before = (len(FakeProvider.calls), sum(
                    message.get('method') in ('turn/started', 'thread/tokenUsage/updated')
                    for message in runtime.observed))
                time.sleep(options.idle_seconds)
                assert not failures, failures
                after = (len(FakeProvider.calls), sum(
                    message.get('method') in ('turn/started', 'thread/tokenUsage/updated')
                    for message in runtime.observed))
                assert before == after, 'Unexpected generation/turn/usage event while idle'
                print(f'PASS {label}: {options.idle_seconds:g}s, zero new model requests/turns/usage events', flush=True)

            def send_and_wait(key):
                sent = room('send', key=key, text='Please answer this local test request.')
                event_id = sent['event']['eventId']
                wait_until(lambda: bool(failures) or room('request', eventId=event_id)['responseEventId'])
                assert not failures, failures
                assert event_id in receipts_before_reply
                print('PASS automatic wake, explicit synthetic ACK, correlated final reply', flush=True)
                return event_id

            enabled.set()
            bridge = threading.Thread(target=run_bridge, daemon=True)
            bridge.start()
            idle('initial idle')
            first = send_and_wait('first-message')
            assert len(FakeProvider.calls) == 1
            duplicate = room('send', key='first-message', text='Please answer this local test request.')
            assert duplicate['event']['eventId'] == first
            room('send', key='broadcast', text='Unaddressed chatter', broadcast=True)
            idle('duplicate, broadcast, receipts and reply do not wake model')
            second = send_and_wait('second-message')
            assert len(FakeProvider.calls) == 2
            enabled.clear()
            time.sleep(.2)
            queued = room('send', key='offline-message', text='Wait until the receiver reconnects.')
            queued_id = queued['event']['eventId']
            time.sleep(.5)
            state = room('request', eventId=queued_id)
            assert state['receivedAt'] is None and state['responseEventId'] is None
            assert len(FakeProvider.calls) == 2
            enabled.set()
            wait_until(lambda: bool(failures) or room('request', eventId=queued_id)['responseEventId'])
            assert not failures, failures
            assert len(FakeProvider.calls) == 3 and queued_id in receipts_before_reply
            print('PASS paused receiver: request retained without false ACK, answered after resume', flush=True)
            idle('final idle')
            events = room('events')['events']
            replies = [event for event in events if event.get('replyTo') in (first, second, queued_id)]
            assert len(replies) == 3
            assert len({event['replyTo'] for event in replies}) == 3
            assert sum(message.get('method') == 'turn/started' for message in runtime.observed) == 3
            assert sum(message.get('method') == 'turn/completed' for message in runtime.observed) == 3
            print('PASS three requests, three synthetic generations; no paid inference or deployment', flush=True)
        finally:
            stopped.set()
            if bridge:
                bridge.join(timeout=25)
            for child in reversed(children):
                child.close()
            provider.shutdown()
            provider.server_close()


if __name__ == '__main__':
    main()
