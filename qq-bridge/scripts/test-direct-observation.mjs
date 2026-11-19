import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../../plugins/qq-direct.mjs';
import { createTurnUsage } from '../../plugins/qq-direct-usage.mjs';
import { tariffAt } from './deepseek-rates.mjs';
import { renderQQContext } from '../../plugins/qq-direct-context.mjs';
import { createDirectRuntime } from '../src/direct-runtime.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sid = 'session-observation-fixture';
const group = 'group:456';
const other = 'group:457';
const privateChannel = 'private:123';
const h = await bridgeHarness({ config: { directSession: { enabled: true, sessionId: sid } } });
const store = h.directStore;
const realNow = Date.now;
const realRandom = Math.random;
const minute = 60_000;
let now = realNow();
let dispose;
try {
  Date.now = () => now;
  Math.random = () => 0;
  let tick;
  let roll = 1;
  const chances = [];
  const sends = [];
  const runtime = createDirectRuntime({
    cfg: { ...h.cfg, allow: { groups: [456, 457] }, directSession: {
      sessionId: sid, automaticObservation: { autonomousChoice: true, maxPer24Hours: 2, freePer24Hours: 0 },
    } },
    directStore: store, directAllowed: channel => [group, other, privateChannel].includes(channel),
    isPaused: () => false, ensureChannelState() {}, randInt(min, max) {
      if (min === 1) {
        assert.equal(max, 10_000);
        chances.push(roll);
        return roll;
      }
      return min;
    }, log() {},
    archiveMemory(callback) { callback(); },
    observationLogDir: path.join(h.temp, 'observations'),
    stickerEnabled: () => true, stickerEntries: () => [], slangEntries: () => [], buildMemeHint: () => '',
    redactSensitiveText: text => text, redactKnownTokensOnly: text => text,
    async onebotSend(kind, id, text, replyTo, atUserId) {
      sends.push({ kind, id, text, replyTo, atUserId });
      return { message_id: 101 };
    },
    async sendStickerV2(channel, id, options) {
      options.assertDirectAllowed();
      options.onTransportStart();
      sends.push({ channel, stickerId: id });
      return { messageId: 102 };
    },
    schedule(fn, ms) { if (ms === 500) tick = fn; return { unref() {} }; },
  });
  store.publish('automatic-observation-stats', { quiet: 2 });
  runtime.start();
  assert.deepEqual(store.runtime('automatic-observation-stats'), { quiet: 2, bySource: { scheduled: {}, activity: {} } });
  const heartbeat = (overrides = {}) => store.publish('dsh', { sessionId: sid, available: true, bindingCreatedAt: 0,
    at: now, supportsObservationEvidence: true, supportsAutonomousChoice: true, ...overrides });
  const clock = () => store.runtime('automatic-observation-clock');
  const counts = () => [clock().totalScans, clock().emptyScans];
  const stats = () => store.runtime('automatic-observation-stats');
  const receive = (channel, id, sender, text) => {
    const [kind, key] = channel.split(':');
    return runtime.receiveDirect(channel, kind, key, {
      message_id: id, user_id: sender, self_id: 999,
      message: [{ type: 'text', data: { text } }],
    }, text, async () => null);
  };

  now += 24 * minute;
  heartbeat();
  tick();
  assert.equal(stats().quiet, 2, 'five minutes of quiet precede the first 20-minute chance');
  now += minute;
  roll = 50;
  heartbeat();
  tick();
  roll = 1;
  assert.equal(stats().quiet, 3, 'the previous total is retained');
  assert.equal(stats().bySource.scheduled.quiet, 1, 'a quiet scheduled check does not wake DSH');
  assert.equal(stats().lastSource, 'scheduled');
  assert.equal(store.waking(), undefined);
  assert.deepEqual(counts(), [1, 1]);
  await receive(other, 11, 21, '另一个群');
  await receive(group, 12, 22, '嗯');
  await receive(group, 13, 23, '嗯');
  assert.equal(store.waking(), undefined, 'passive chat only gets logged');
  now += 20 * minute;
  heartbeat();
  tick();
  const first = store.waking();
  assert.equal(first.observationSource, 'scheduled');
  assert.equal(first.observationVersion, 2);
  assert.deepEqual(first.evidenceIds, ['qq:group:456:13', 'qq:group:456:12']);
  assert.equal(first.focusId, 'qq:group:456:13');
  assert.deepEqual(counts(), [2, 0]);

  const handlers = new Map();
  let guard;
  const tools = new Map();
  const agent = { id: sid, inbox: { nextTurn: [] }, followup(input) { this.inbox.nextTurn.push(input); } };
  apply({
    agents: new Map([[sid, agent]]),
    tools: { register(tool) { tools.set(tool.name, tool); }, guard(fn) { guard = fn; } },
    on(name, fn) { handlers.set(name, fn); },
    effect(fn) { dispose = fn(); }, setInterval() {},
  }, { sessionId: sid, database: path.join(h.temp, 'state', 'direct-qq.sqlite3') });
  const preStep = (item, turn, otherMessages = []) => handlers.get('agent/pre-step')(
    { agent, turn, step: 1 }, async () => ({ kind: 'enter', messages: [renderQQContext(item, { wake: true }), ...otherMessages] }),
  );
  const act = await preStep(first, 1);
  assert.equal(act.kind, 'enter');
  assert.deepEqual(new Set(act.messages.slice(0, -1).map(message => message.id)), new Set(first.evidenceIds));
  assert.match(act.messages[0].content[0].text, /^QQ资料/);
  assert.match(act.messages[0].content[0].text, /"时间":"[\d-]+ [\d:]+ \+08:00"/u);
  assert.equal(act.messages.some(message => message.id.endsWith(':14') || message.id.endsWith(':11')), false);
  const queued = tools.get('qq_direct_reply').execute({ format: 'text', text: '试喝', replyToCurrent: true }, { agent });
  await runtime.sendDirect();
  await queued;
  assert.deepEqual(sends, [{ kind: 'group', id: '456', text: '试喝', replyTo: '13', atUserId: null }]);
  const event = handlers.get('session/event');
  event({ id: sid }, { type: 'assistant/message', data: { turn: 1, step: 1,
    usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 4, totalTokens: 114 } } });
  event({ id: sid }, { type: 'turn/end', data: { turn: 1 } });
  const usage = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'turn-usage.jsonl'), 'utf8'));
  assert.equal(usage.observationSource, 'scheduled');
  assert.equal(usage.modelResponses, 1);
  assert.equal(usage.confirmedReplies, 1);
  store.mark(first.id);

  await receive(group, 15, 23, '岸岸，这句有个问题');
  assert.equal(store.waking().wakeClass, 'direct');
  now += minute;
  await receive(group, 19, 23, '我想继续说这个问题');
  assert.equal(store.get('qq:group:456:19').wakeClass, 'continuation');
  store.mark('qq:group:456:15');
  store.mark('qq:group:456:19');
  const resetAt = now;
  assert.equal(store.runtime('automatic-observation-clock').startAt, resetAt + 5 * minute);
  await receive(group, 16, 24, '……');
  for (const [elapsed, miss] of [[24, 10_000], [25, 51], [26, 53], [85, 151], [90, 767], [104, 10_000]]) {
    roll = miss;
    now = resetAt + elapsed * minute;
    heartbeat();
    tick();
    assert.equal(store.waking(), undefined, 'a missed chance does not wake before the end of the window');
  }
  assert.deepEqual(chances.slice(-5), [51, 53, 151, 767, 10_000], 'early and accelerated probability boundaries');
  now = resetAt + 105 * minute;
  heartbeat();
  tick();
  const cancelledLook = store.waking();
  assert.equal(cancelledLook.observationSource, 'scheduled', 'minute 100 must scan');
  assert.deepEqual(cancelledLook.evidenceIds, ['qq:group:456:16']);
  await receive(privateChannel, 20, 123, '私聊接上了');
  assert.equal(store.waking().channel, privateChannel);
  assert.equal(store.get(cancelledLook.id).observationCancelled, true);
  assert.deepEqual(counts(), [3, 0], 'real chats reset the empty streak but preserve total scans');
  assert.equal(store.runtime('automatic-observation-clock').startAt, now + 5 * minute);
  const desktop = { id: 'simultaneous-desktop', role: 'user', content: [{ type: 'text', text: '桌面句子' }],
    source: { kind: 'user', rpcId: 'fixture', clientTimeZone: 'UTC' } };
  assert.equal((await preStep(cancelledLook, 2, [desktop])).kind, 'reject');
  assert.deepEqual(agent.inbox.nextTurn, [desktop], 'a simultaneous desktop input is retained');
  store.mark('qq:private:123:20');
  agent.inbox.nextTurn = [];
  roll = 1;
  now += 25 * minute;
  heartbeat();
  tick();
  const third = store.waking();
  assert.deepEqual(third.evidenceIds, cancelledLook.evidenceIds, 'interruption does not hide unviewed material');
  store.mark(third.id);
  store.mark('qq:group:456:16');
  now += 20 * minute;
  heartbeat();
  tick();
  const fourth = store.waking();
  assert.equal(fourth.channel, other, 'each group keeps its own unread scan boundary');
  assert.deepEqual(fourth.evidenceIds, ['qq:group:457:11']);
  assert.deepEqual(counts(), [5, 0]);
  assert.equal(clock().choiceDue, 'five-scans');
  assert.equal(store.pending().some(row => row.autonomousChoice), false, 'new group material is seen first');
  store.mark(fourth.id);
  store.mark('qq:group:457:11');
  assert.equal(stats().bySource.scheduled.queued, 4, 'old maxPer24Hours=2 is ignored');
  assert.equal(stats().dailyCap, undefined);
  heartbeat({ readyForObservation: false });
  tick();
  assert.equal(store.waking(), undefined, 'keep the fifth-scan choice due while the model reads new messages');
  heartbeat();
  tick();
  const free = store.waking();
  assert.ok(free.free && free.autonomousChoice && free.sessionId === sid);
  assert.equal(free.choiceReason, 'five-scans');
  assert.deepEqual(counts(), [0, 0]);
  const extra = renderQQContext(store.get('qq:group:456:15'), { wake: true });
  const freeStep = await preStep(free, 3, [extra]);
  assert.equal(freeStep.kind, 'enter');
  assert.deepEqual(freeStep.messages.map(row => row.id), [free.id]);
  assert.deepEqual(agent.inbox.nextTurn, [extra], 'a privileged free turn cannot absorb another group input');
  agent.inbox.nextTurn = [];
  assert.match(freeStep.messages[0].content[0].text, /自主选择/u);
  assert.equal(guard({ agent, name: 'qq_direct_reply', arguments: { format: 'text', channel: group } }), undefined);
  assert.ok(guard({ agent, name: 'qq_direct_reply', arguments: { format: 'file', channel: group } }));
  assert.ok(guard({ agent, name: 'pwsh' }));
  assert.ok(guard({ agent, name: 'read_image' }));
  assert.ok(guard({ agent, name: 'write' }));
  assert.equal(guard({ agent, name: 'mcp__web-search-safe__web_fetch' }), undefined);
  const reply = tools.get('qq_direct_reply');
  await assert.rejects(reply.execute({ format: 'text', text: 'fixture', channel: 'group:999' }, { agent }));
  const openTopic = reply.execute({ format: 'text', text: '新版回放开题', channel: group }, { agent });
  await runtime.sendDirect();
  await openTopic;
  assert.deepEqual(sends.at(-1), { kind: 'group', id: '456', text: '新版回放开题', replyTo: undefined, atUserId: undefined });
  const sticker = reply.execute({ format: 'sticker', stickerId: 'fixture', channel: privateChannel }, { agent });
  await runtime.sendDirect();
  await sticker;
  assert.deepEqual(sends.at(-1), { channel: privateChannel, stickerId: 'fixture' });
  const draw = tools.get('qq_free_draw');
  assert.throws(() => draw.execute({ strokes: [{ path: 'M 0 0 <script>', color: '#111111', width: 3 }] }, { agent }));
  const art = draw.execute({ strokes: [{ path: 'M 15 15 L 100 100', color: '#324c68', width: 3 }] }, { agent });
  assert.match(art.text, /保存/u);
  assert.equal(fs.readdirSync(path.join(h.temp, 'state', 'free-art')).length, 1);
  event({ id: sid }, { type: 'turn/end', data: { turn: 3 } });
  const rows = fs.readFileSync(path.join(h.temp, 'state', 'turn-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).origin, 'free');
  assert.equal(rows.at(-1).confirmedReplies, 2);
  store.mark(free.id);

  const nextScan = async (text, id) => {
    if (text) await receive(group, id, 99, text);
    now = clock().nextChanceAt;
    heartbeat();
    tick();
    const item = store.waking();
    if (text) {
      assert.equal(item.observationSource, 'scheduled');
      assert.deepEqual(item.evidenceIds, [`qq:${group}:${id}`]);
      store.mark(item.id);
      store.mark(item.evidenceIds[0]);
    }
    return item;
  };
  assert.equal(await nextScan(), undefined);
  assert.deepEqual(counts(), [1, 1]);
  const emptyChoice = await nextScan();
  assert.equal(emptyChoice.choiceReason, 'two-empty');
  assert.deepEqual(counts(), [0, 0], 'two-empty trigger clears both counters');
  store.mark(emptyChoice.id);

  await nextScan('一条简短群消息', 31);
  await nextScan('今天天气还行', 32);
  await nextScan('一小块蛋糕', 33);
  assert.equal(await nextScan(), undefined);
  assert.deepEqual(counts(), [4, 1]);
  const both = await nextScan();
  assert.equal(both.choiceReason, 'both');
  assert.deepEqual(counts(), [0, 0], 'both causes coalesce into one new round');
  assert.equal(store.pending().filter(r => r.autonomousChoice).length, 1);
  assert.equal(store.recentFreeTime(10).length, 3, 'autonomous choices have no daily cap');
  store.mark(both.id);

  assert.equal(await nextScan(), undefined);
  assert.deepEqual(counts(), [1, 1]);
  await receive(privateChannel, 34, 123, '我有个问题');
  assert.deepEqual(counts(), [1, 0]);
  store.mark('qq:private:123:34');
  store.defer(group, now);
  tick();
  assert.ok(store.waking().opportunity);
  assert.equal(store.waking().observationSource, undefined, 'explicit revisit remains available');
  store.mark(store.waking().id);
  // Simulate a restart after an operator disables the optional choice feature.
  store.publish('automatic-observation-clock', { ...clock(), totalScans: 5, emptyScans: 2, choiceDue: 'both' });
  let disabledTick;
  createDirectRuntime({
    cfg: { ...h.cfg, allow: { groups: [456, 457] }, directSession: { sessionId: sid,
      automaticObservation: { freePer24Hours: 4 } } },
    directStore: store, directAllowed: channel => [group, other, privateChannel].includes(channel),
    isPaused: () => false, randInt: min => min, log() {},
    ensureChannelState() {}, stickerEnabled: () => false, slangEntries: () => [], buildMemeHint: () => '',
    schedule(fn, ms) { if (ms === 500) disabledTick = fn; return { unref() {} }; },
  }).start();
  assert.deepEqual(counts(), [0, 0], 'a legacy cap value cannot opt in to unlimited choices');
  assert.equal(clock().choiceDue, null);
  now = clock().nextChanceAt;
  heartbeat();
  disabledTick();
  assert.equal(store.waking(), undefined, 'default-off scan remains local with no new messages');
  assert.equal(stats().lastResult, 'quiet');
  assert.equal(store.runtime('bridge').autonomousChoiceEnabled, false);
  assert.equal((await preStep(free, 5)).kind, 'reject', 'disabled feature discards a queued choice');
  const checksDir = path.join(h.temp, 'observations');
  const checks = fs.readdirSync(checksDir).flatMap(file => fs.readFileSync(path.join(checksDir, file), 'utf8')
    .trim().split('\n').map(JSON.parse));
  assert.ok(checks.some(item => item.source === 'free' && item.result === 'queued'));
  assert.ok(checks.every(item => Object.keys(item).sort().join(',') === 'at,result,source'));

  const journal = path.join(h.temp, 'usage-fixture.jsonl');
  const lost = createTurnUsage(journal);
  lost.enter(8, 'qq-group', []);
  lost.response({ turn: 8, step: 1, usage: { inputTokens: 13, outputTokens: 6, totalTokens: 19 } });
  assert.equal(JSON.parse(fs.readFileSync(journal + '.pending', 'utf8')).state, 'pending');
  createTurnUsage(journal);
  createTurnUsage(journal);
  const interrupted = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.modelResponses, 1);
  assert.equal(interrupted.totalTokens, 19);
  assert.equal(fs.existsSync(journal + '.pending'), false);
  const price = at => tariffAt(Date.parse(at), 'deepseek-flash')?.bucket;
  assert.equal(price('2026-11-19T09:00:00+08:00'), 'peak');
  assert.equal(price('2026-11-19T12:00:00+08:00'), 'offPeak');
  assert.equal(price('2027-02-05T10:30:00+08:00'), 'offPeak');
  assert.equal(price('2027-05-08T14:00:00+08:00'), 'offPeak');
  assert.equal(price('2028-05-08T14:00:00+08:00'), undefined);

  console.log('PASS QQ observation idle reset, random window, timestamps, source isolation, free time, interrupted usage and tariffs.');
} finally {
  dispose?.();
  Date.now = realNow;
  Math.random = realRandom;
  await h.close();
}