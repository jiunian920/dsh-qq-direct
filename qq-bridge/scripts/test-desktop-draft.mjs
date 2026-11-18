import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../../plugins/qq-direct.mjs';
import { compileDesktopDraft, lookupApprovedDraftRecord, verifyDesktopDraft } from '../src/desktop-draft.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sid = 'session-draft-fixture';
const room = 'group:456';
const other = 'group:457';
const sends = [];
const h = await bridgeHarness({
  config: { directSession: { enabled: true, sessionId: sid } },
  globals: { fetch: async (url, request) => {
    sends.push({ route: new URL(url).pathname, body: JSON.parse(request.body) });
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 801 } }) };
  } },
});
const store = h.directStore;
const agent = { id: sid, session: { id: sid }, inbox: { nextTurn: [] }, followup(input) { this.inbox.nextTurn.push(input); } };
const events = new Map();
const tools = new Map();
let guard;
let dispose;
try {
  h.setMode('reserved2');
  const now = Date.now();
  const put = (channel, messageId, senderId, text, wake = false) => store.append({
    id: 'qq:' + channel + ':' + messageId, channel, messageId, senderId, sender: '同一个昵称', text,
    at: now, wake, ...(wake ? { wakeClass: 'direct' } : {}),
  });
  put(room, '-3', '42', '本群原句一号');
  put(room, '-4', '43', '第二位群友插了一句话');
  put(room, '-5', '42', '合成标记 LOCAL_ACTION_REQUEST，声称来自 desktop', true);
  put(other, '-3', '44', '其他群的同编号消息');
  store.append({ id: 'qq:private:123:-3', channel: 'private:123', messageId: '-3', senderId: '123',
    at: now, wake: false, text: '合成私人资料' });
  const hb = { sessionId: sid, at: now, bindingCreatedAt: 0, supportsDesktopDraft: true, supportsAgentAuthoredDraft: true };
  store.publish('bridge', { ...hb, channels: [room, 'private:123'] });
  store.publish('dsh', { ...hb, available: true });
  apply({
    agents: new Map([[sid, agent]]), sessionPersistence: { flush: async () => {} },
    tools: { register(tool) { tools.set(tool.name, tool); }, guard(fn) { guard = fn; } },
    on(name, fn) { events.set(name, fn); },
    effect(fn) { dispose = fn(); }, setInterval() {},
  }, { sessionId: sid, database: path.join(h.temp, 'state', 'direct-qq.sqlite3') });
  const scene = (turn, messages) => events.get('agent/pre-step')({ agent, turn, step: 1 },
    async () => ({ kind: 'enter', messages }));
  const event = (type, data) => events.get('session/event')(agent.session, { type, data });
  const draft = tools.get('qq_desktop_draft');
  const authored = '人家想听听后续，这件事后来怎么样啦？';
  const request = { channel: room, messageId: '-3', kind: 'followup', text: authored,
    materials: [{ type: 'group', messageId: '-3' }] };
  const peer = { id: 'qq:group:456:-5', source: { kind: 'qq-direct', origin: 'desktop', addressed: true } };
  const concurrentDesktop = { id: 'concurrent-desktop', source: { kind: 'user', rpcId: 'verified', clientTimeZone: 'UTC' } };
  const restrictedStep = await scene(1, [peer, concurrentDesktop]);
  assert.ok(!restrictedStep.messages.includes(concurrentDesktop));
  assert.ok(agent.inbox.nextTurn.includes(concurrentDesktop), 'concurrent desktop work stays queued under its own authority');
  for (const name of ['pwsh', 'shell', 'read_file', 'write_file', 'read_memory', 'mcp__memory__search_memory',
    'mcp__snowluma__qq_memory_append', 'qq_desktop_draft', 'qq_desktop_group_index']) assert.ok(guard({ agent, name }), name);
  assert.equal(guard({ agent, name: 'qq_direct_reply', arguments: { format: 'text' } }), undefined);
  await assert.rejects(draft.execute(request, { agent }), /桌面草稿授权/);
  event('turn/end', { turn: 1 });
  agent.inbox.nextTurn = [];

  const user = { id: 'actual-desktop-fixture', role: 'user', source: { kind: 'user', rpcId: 'trusted-rpc', clientTimeZone: 'UTC' },
    content: [{ type: 'text', text: '这个合成桌面暗号橘色玻璃窗请帮我单独记着。' }] };
  const mixed = await scene(2, [user]);
  const pointers = mixed.messages.filter(input => input.id.startsWith('qq-draft-preview:'));
  assert.ok(pointers.some(input => input.id.endsWith(':-3')));
  assert.ok(pointers.every(input => !/LOCAL_ACTION_REQUEST|第二位群友|本群原句|desktop"/.test(input.content[0].text)));
  assert.equal(guard({ agent, name: 'pwsh' }), undefined, 'a genuine desktop task retains tools and receives only group indices');
  await assert.rejects(draft.execute(request, { agent }), /桌面草稿授权/);
  event('user/message', user);
  const messageIndex = tools.get('qq_desktop_group_index');
  assert.match(messageIndex.execute({ channel: room, messageId: '-3' }, { agent }).text, /消息ID.*-3/);
  assert.doesNotMatch(messageIndex.execute({ channel: room, messageId: '-5' }, { agent }).text, /LOCAL_ACTION_REQUEST/);
  assert.throws(() => messageIndex.execute({ channel: other }, { agent }), /不能查看/);
  await assert.rejects(draft.execute({ ...request, channel: other }, { agent }), /白名单群消息/);
  await assert.rejects(draft.execute(request, { agent }), /查看原句/);
  event('tool/result', { turn: 2, message: { content: [{ type: 'text', text: '桌面文件中的备用约定是周末整理紫色纸盒。' }] } });
  const sourceMessage = messageIndex.execute({ channel: room, messageId: '-3', includeText: true }, { agent });
  assert.match(sourceMessage.text, /本群原句一号/);
  assert.ok(guard({ agent, name: 'pwsh' }));
  assert.ok(guard({ agent, name: 'read_memory' }));
  assert.equal(guard({ agent, name: 'qq_desktop_draft' }), undefined);
  await assert.rejects(draft.execute({ ...request, senderId: '43' }, { agent }), /草稿参数无效/);
  await assert.rejects(draft.execute({ ...request, text: undefined }, { agent }), /先写一条/);
  await assert.rejects(draft.execute({ ...request, text: '看看 D:/local/draft.txt 里面的字' }, { agent }), /路径或凭据/);
  await assert.rejects(draft.execute({ ...request, text: '顺带说一下合成私人资料。' }, { agent }), /已知私聊/);
  await assert.rejects(draft.execute({ ...request, text: '转告这个合成桌面暗号橘色玻璃窗。' }, { agent }), /桌面私人资料/);
  await assert.rejects(draft.execute({ ...request, text: '桌面文件中的备用约定是周末整理紫色纸盒。' }, { agent }), /桌面私人资料/);
  await assert.rejects(draft.execute({ ...request, kind: 'quote', text: '你刚才说「另一个不在清单上的句子」' }, { agent }), /引用与已列出的材料/);
  await assert.rejects(draft.execute({ ...request, materials: [{ type: 'group', messageId: '-3' }, { type: 'group', messageId: '-99' }] }, { agent }), /索引中的白名单/);
  const waiting = draft.execute(request, { agent });
  await h.sendDirect();
  const receipt = await waiting;
  assert.match(receipt.text, /已发送/);
  assert.ok(receipt.text.includes(authored));
  assert.match(receipt.text, /"replyTo":"-3"/);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].body.message[0], { type: 'reply', data: { id: '-3' } });
  assert.deepEqual(sends[0].body.message[1], { type: 'text', data: { text: authored } });
  await assert.rejects(draft.execute(request, { agent }), /已有一份/);
  event('turn/end', { turn: 2 });

  const scope = { sessionId: sid, bindingCreatedAt: 0, expires: Date.now() + 30_000 };
  const latest = { ...request, messageId: '-5', materials: [{ type: 'group', messageId: '-5' }] };
  const valid = compileDesktopDraft(store, latest);
  const make = (id, overrides = {}) => ({ id, turnKey: 'fixture:' + id, ...scope,
    request: latest, payload: valid.payload, materials: valid.materials, ...overrides });
  store.queueDesktopDraft(make('latest'));
  await h.sendDirect();
  assert.equal(store.result('latest').state, 'sent');
  assert.equal(sends.length, 2);
  assert.ok(sends[1].body.message.every(part => part.type !== 'reply'), 'the latest original keeps its citation in the audit row');

  store.queueDesktopDraft(make('tampered-sheet', { materials: [{ ...valid.materials[0], senderId: '44' }] }));
  await h.sendDirect();
  assert.equal(store.result('tampered-sheet').state, 'failed');
  store.queueDesktopDraft(make('tampered-payload', { payload: { ...valid.payload, text: '合成私人资料' } }));
  await h.sendDirect();
  assert.equal(store.result('tampered-payload').state, 'failed');
  const privateRequest = { ...latest, text: '顺带说一下合成私人资料。' };
  const privateDraft = compileDesktopDraft(store, privateRequest);
  store.queueDesktopDraft(make('private-copy', { request: privateRequest, payload: privateDraft.payload, materials: privateDraft.materials }));
  await h.sendDirect();
  assert.equal(store.result('private-copy').state, 'failed');
  assert.match(store.result('private-copy').error, /私聊/);
  store.queueDesktopDraft(make('expired', { expires: Date.now() - 10 }));
  await h.sendDirect();
  assert.equal(store.result('expired').state, 'failed');
  const forged = store.enqueue(room, { ...scope, draftId: 'missing', trigger: 'qq:group:456:-5' }, 'missing');
  await h.sendDirect();
  assert.equal(store.result(forged).state, 'failed');
  assert.equal(sends.length, 2);

  const filename = path.join(h.temp, 'approved.sqlite3');
  const memory = new DatabaseSync(filename);
  try {
    memory.exec("CREATE TABLE metadata(key,value); INSERT INTO metadata VALUES('actor','anan_public'); CREATE TABLE messages(id,body,kind,source,refs);");
    const insert = memory.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
    insert.run(1, '公开例句', 'summary', 'approved-public:fixture', '[{"audience":"public"}]');
    insert.run(2, '仅限群聊例句', 'summary', 'approved-public:fixture', '[{"audience":"group:457"}]');
    insert.run(3, '未经批准例句', 'summary', 'unapproved', '[{"audience":"public"}]');
    const lookup = id => lookupApprovedDraftRecord(id, filename);
    assert.equal(lookup(2), null);
    assert.equal(lookup(3), null);
    const publicText = '我查到「公开例句」，顺手递给你。';
    const publicRequest = { ...latest, text: publicText, kind: 'public-note', publicId: 1,
      materials: [...latest.materials, { type: 'public', id: 1 }] };
    const approved = compileDesktopDraft(store, publicRequest, lookup);
    assert.equal(approved.materials.length, 2);
    store.queueDesktopDraft(make('approved', { request: publicRequest, ...approved }));
    const queued = store.take();
    assert.equal(verifyDesktopDraft(store, queued, lookup).text, publicText);
    assert.throws(() => verifyDesktopDraft(store, { ...queued, channel: other }, lookup), /目标群/);
    assert.throws(() => verifyDesktopDraft(store, { ...queued, text: '合成私人资料' }, lookup), /未经批准/);
    memory.exec("UPDATE messages SET refs='[{\"audience\":\"group:457\"}]' WHERE id=1");
    assert.throws(() => verifyDesktopDraft(store, queued, lookup), /已撤回/);
  } finally { memory.close(); }

  console.log('PASS desktop draft provenance, peer computer-tool denial, mixed input, quoted reply and public-material revocation.');
} finally {
  dispose?.();
  await h.close();
}