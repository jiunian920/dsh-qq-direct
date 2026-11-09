import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../../plugins/qq-direct.mjs';
import { directSessionBinding } from '../src/direct-store.mjs';
import { createDirectRuntime } from '../src/direct-runtime.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const initial = 'session-fixture-old';
const next = 'session-fixture-new';
const sends = [];
const h = await bridgeHarness({
  config: { directSession: { enabled: true, sessionId: initial } },
  globals: { fetch: async (url, request) => {
    sends.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 901 } }) };
  } },
});
const store = h.directStore;
const db = path.join(h.temp, 'state', 'direct-qq.sqlite3');
const desktop = { kind: 'user', rpcId: 'desktop-request', clientTimeZone: 'UTC' };
const stamp = Date.now();
const workspace = path.join(h.temp, 'workspace');
const makeAgent = (id, changes = {}) => ({ id, status: 'idle', inbox: { nextTurn: [] }, session: {
  id, header: { id, cwd: workspace, agentPreset: 'standard', createdAt: stamp, ...changes },
} });
const old = makeAgent(initial, { createdAt: stamp - 1000 });
const fresh = makeAgent(next);
const agents = new Map([[initial, old], [next, fresh]]);

function mount(followDesktop) {
  const handlers = new Map();
  let guard;
  let dispose;
  apply({
    agents,
    tools: { register() {}, guard(fn) { guard = fn; } },
    on(name, fn) { handlers.set(name, fn); },
    effect(fn) { dispose = fn(); },
    setInterval() {},
  }, { database: db, sessionId: initial, followDesktop });
  return { handlers, guard, dispose };
}

const group = 'group:456';
const id = 'qq:group:456:-4';
const input = { id, source: { kind: 'qq-direct' } };
const preStep = plugin => (agent) => plugin.handlers.get('agent/pre-step')(
  { agent, turn: 'qq-fixture-turn', step: 1 },
  async () => ({ kind: 'enter', messages: [input] }),
);
const bound = () => directSessionBinding(store, initial).sessionId;
let plugin;
try {
  h.setMode('reserved2');
  const fixed = mount();
  assert.equal(fixed.handlers.has('agent/inbox/inserted'), false);
  fixed.dispose();

  plugin = mount({ cwd: workspace, agentPreset: 'standard' });
  const offer = (agent, source = desktop) => plugin.handlers.get('agent/inbox/inserted')({ agent, message: { source } });
  offer(fresh, { kind: 'user' });
  offer(fresh, { kind: 'qq-direct' });
  offer(fresh, { ...desktop, principal: { id: 'shared-visitor' } });
  offer(makeAgent(next, { agentPreset: 'other' }));
  offer(makeAgent(next, { cwd: path.join(workspace, 'other') }));
  offer(makeAgent(next, { parentSession: initial }));
  offer(makeAgent(next, { isSeeded: true }));
  offer(makeAgent(next, { createdAt: stamp - 2000 }));
  assert.equal(bound(), initial);

  await h.handleIncoming('group', '456', { message_id: -4, user_id: 12, self_id: 999,
    sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: '岸岸，测试' } }] }, h.cfg);
  assert.ok(store.get(id).wake);
  const heartbeat = sessionId => store.publish('bridge', { sessionId, at: Date.now(), channels: [group, 'private:123'] });
  heartbeat(initial);
  assert.equal((await preStep(plugin)(old)).kind, 'enter');
  offer(fresh);
  assert.equal(bound(), initial, 'active QQ turn retains its binding');
  assert.match(plugin.guard({ agent: old, name: 'shell' }), /不授予电脑操作/);

  let finishVoice;
  const runtime = createDirectRuntime({
    cfg: h.cfg, directStore: store, directAllowed: () => true, isPaused: () => false,
    voiceConfig: () => ({ timeoutMs: 5000 }),
    synthesizeVoiceToFile: () => new Promise(resolve => { finishVoice = resolve; }),
    onebotSendSegments: async () => assert.fail('old voice must not reach the gateway after rebinding'),
    redactKnownTokensOnly: body => body, redactSensitiveText: body => body,
  });
  const route = { trigger: id, expires: Date.now() + 60_000, replyTo: '-4', toSender: '12' };
  const voice = store.enqueue(group, { ...route, sessionId: initial, format: 'voice', text: '合成中' });
  const sending = runtime.sendDirect();
  assert.equal(typeof finishVoice, 'function');
  const fault = new DatabaseSync(db);
  try {
    fault.exec("CREATE TRIGGER deny_binding BEFORE INSERT ON runtime WHEN NEW.name = 'session-binding' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    plugin.handlers.get('session/event')(old.session, { type: 'turn/end' });
    assert.equal(bound(), initial, 'a failed write leaves both sides on the old binding');
    assert.equal((await preStep(plugin)(fresh)).kind, 'reject');
    fault.exec('DROP TRIGGER deny_binding');
  } finally {
    fault.close();
  }
  offer(fresh);
  assert.equal(bound(), next, 'a fresh prompt can retry the same binding');
  finishVoice('fixture.wav');
  await sending;
  assert.equal(store.result(voice).state, 'failed');

  const older = makeAgent('session-fixture-older', { createdAt: stamp - 500 });
  offer(older);
  assert.equal(bound(), next);
  assert.equal((await preStep(plugin)(old)).kind, 'reject');
  assert.equal((await preStep(plugin)(fresh)).kind, 'reject', 'wait for bridge acknowledgement');
  const passiveId = 'qq:group:456:-5';
  store.append({ ...store.get(id), id: passiveId, messageId: '-5', wake: false });
  const desktopStep = async () => plugin.handlers.get('agent/pre-step')(
    { agent: fresh, turn: 'desktop-fixture-turn', step: 1 },
    async () => ({ kind: 'enter', messages: [{ id: 'fixture-desktop', source: desktop }] }),
  );
  assert.deepEqual((await desktopStep()).messages.map(message => message.id), ['fixture-desktop']);
  assert.equal(store.waking().id, id, 'rejected intake leaves its ledger row pending');
  let bridgeTick;
  createDirectRuntime({
    cfg: h.cfg, directStore: store, directAllowed: () => true, isPaused: () => false, randInt: () => 100,
    schedule(fn, ms) {
      if (ms === 500) bridgeTick = fn;
      return { unref() {} };
    },
  }).start();
  bridgeTick();
  assert.equal(store.runtime('bridge').sessionId, next, 'bridge startup uses the persisted binding');
  assert.ok((await desktopStep()).messages.some(message => message.id === passiveId));
  assert.equal((await preStep(plugin)(fresh)).kind, 'enter');

  const send = async sessionId => {
    const job = store.enqueue(group, { ...route, sessionId, format: 'text', text: '测试回复' });
    await h.sendDirect();
    return store.result(job).state;
  };
  assert.equal(await send(initial), 'failed');
  assert.equal(await send(next), 'sent');
  assert.equal(sends.length, 1);
  plugin.dispose();
  plugin = mount({ cwd: workspace, agentPreset: 'standard' });
  assert.equal((await preStep(plugin)(fresh)).kind, 'enter', 'binding survives plugin restart');
  assert.equal((await preStep(plugin)(old)).kind, 'reject');
  console.log('QQ binding: scoped desktop input, active-turn guards, handoff, stale send rejection and restart passed.');
} finally {
  plugin?.dispose();
  await h.close();
}
