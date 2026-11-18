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
  const sends = [];
  const runtime = createDirectRuntime({
    cfg: { ...h.cfg, allow: { groups: [456, 457] }, directSession: {
      sessionId: sid, automaticObservation: { maxPer24Hours: 2, cooldownMinutes: 20, freePer24Hours: 1 },
    } },
    directStore: store, directAllowed: channel => [group, other, privateChannel].includes(channel),
    isPaused: () => false, ensureChannelState() {}, randInt: min => min, log() {},
    observationLogDir: path.join(h.temp, 'observations'),
    stickerEnabled: () => false, slangEntries: () => [], buildMemeHint: () => '',
    redactSensitiveText: text => text, redactKnownTokensOnly: text => text,
    async onebotSend(kind, id, text, replyTo, atUserId) {
      sends.push({ kind, id, text, replyTo, atUserId });
      return { message_id: 101 };
    },
    schedule(fn, ms) { if (ms === 500) tick = fn; return { unref() {} }; },
  });
  store.publish('automatic-observation-stats', { quiet: 2 });
  runtime.start();
  assert.deepEqual(store.runtime('automatic-observation-stats'), { quiet: 2, bySource: { scheduled: {}, activity: {} } });
  const heartbeat = () => store.publish('dsh', { sessionId: sid, available: true, bindingCreatedAt: 0, at: now, supportsObservationEvidence: true });
  const stats = () => store.runtime('automatic-observation-stats');
  const receive = (channel, id, sender, text) => {
    const [kind, key] = channel.split(':');
    return runtime.receiveDirect(channel, kind, key, {
      message_id: id, user_id: sender, self_id: 999,
      message: [{ type: 'text', data: { text } }],
    }, text, async () => null);
  };

  now += 20 * minute;
  heartbeat();
  tick();
  assert.equal(stats().quiet, 3, 'the previous total is retained');
  assert.equal(stats().bySource.scheduled.quiet, 1, 'a quiet scheduled check does not wake DSH');
  assert.equal(stats().lastSource, 'scheduled');
  assert.equal(store.waking(), undefined);
  await receive(other, 11, 21, '周末下雨带充电器');
  await receive(group, 12, 22, '桂花乌龙开箱第一泡');
  assert.equal(store.waking(), undefined, 'unrelated and split-channel chatter stays passive');
  await receive(group, 13, 23, '桂花乌龙确实有很明显的花香');
  const first = store.waking();
  assert.equal(first.observationSource, 'activity');
  assert.deepEqual(new Set(first.evidenceIds), new Set(['qq:group:456:12', 'qq:group:456:13']));
  assert.equal(first.focusId, 'qq:group:456:13');
  assert.equal(store.get(first.focusId).wake, false);
  await receive(group, 14, 24, '桂花乌龙另外一包也很香');
  assert.equal(stats().pending, 1);
  assert.deepEqual(stats().bySource.activity, { quiet: 2, queued: 1, pending: 1 });
  assert.equal(stats().lastSource, 'activity');
  assert.equal(store.observationBudget(10).length, 1);

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
  assert.equal(usage.observationSource, 'activity');
  assert.equal(usage.modelResponses, 1);
  assert.equal(usage.confirmedReplies, 1);
  store.mark(first.id);

  await receive(group, 15, 23, '桂花乌龙第三泡怎么样？');
  assert.equal(store.waking().wakeClass, 'continuation', 'an actual sent reply can be followed normally');
  store.mark('qq:group:456:15');
  now += 4 * minute;
  heartbeat();
  await receive(group, 20, 24, '有没有闲置的磁带随身听？');
  assert.equal(stats().cooldown, 1, 'completed checks still count towards the cooldown');

  Math.random = () => 1;
  now += 20 * minute;
  heartbeat();
  await receive(group, 16, 24, '旧镜头转接环最近会降价吗？');
  tick();
  const second = store.waking();
  assert.equal(second.observationSource, 'scheduled');
  assert.deepEqual(second.evidenceIds, ['qq:group:456:16']);
  store.mark(second.evidenceIds[0]);
  const desktop = { id: 'simultaneous-desktop', role: 'user', content: [{ type: 'text', text: '桌面句子' }],
    source: { kind: 'user', rpcId: 'fixture', clientTimeZone: 'UTC' } };
  assert.equal((await preStep(second, 2, [desktop])).kind, 'reject', 'read evidence does not trigger a paid model call');
  assert.deepEqual(agent.inbox.nextTurn, [desktop], 'a simultaneous desktop input is retained');
  assert.equal(store.waking(), undefined);

  now += 20 * minute;
  heartbeat();
  await receive(group, 17, 24, '有没有用得住的旧镜头转接环？');
  tick();
  assert.equal(stats().dailyCap, 1);
  assert.deepEqual(stats().bySource.scheduled, { quiet: 1, queued: 1, dailyCap: 1 });
  assert.deepEqual(stats().bySource.activity, { quiet: 2, queued: 1, pending: 1, cooldown: 1 });
  assert.equal(store.waking(), undefined);
  await receive(group, 18, 24, '岸岸，看这里');
  await receive(privateChannel, 19, 123, '你好呀');
  assert.deepEqual(store.pending().filter(row => row.wake).map(row => row.wakeClass), ['direct', 'direct']);
  store.mark('qq:group:456:18');
  store.mark('qq:private:123:19');
  store.defer(group, now);
  tick();
  assert.ok(store.waking().opportunity);
  assert.equal(store.waking().observationSource, undefined, 'explicit revisit is unaffected by the automatic budget');
  assert.equal(store.observationBudget(10).length, 2);
  store.mark(store.waking().id);
  agent.inbox.nextTurn = [];
  now += 24 * 60 * minute;
  store.publish('dsh', { sessionId: sid, available: true, bindingCreatedAt: 0, at: now,
    supportsObservationEvidence: true, supportsFreeTime: true });
  tick();
  const free = store.waking();
  assert.ok(free.free && free.sessionId === sid);
  assert.equal((await preStep(free, 3)).kind, 'enter');
  assert.ok(guard({ agent, name: 'qq_direct_reply' }));
  assert.ok(guard({ agent, name: 'pwsh' }));
  assert.equal(guard({ agent, name: 'mcp__web-search-safe__web_fetch' }), undefined);
  const draw = tools.get('qq_free_draw');
  assert.throws(() => draw.execute({ strokes: [{ path: 'M 0 0 <script>', color: '#111111', width: 3 }] }, { agent }));
  draw.execute({ strokes: [{ path: 'M 15 15 L 100 100', color: '#324c68', width: 3 }] }, { agent });
  assert.equal(fs.readdirSync(path.join(h.temp, 'state', 'free-art')).length, 1);
  event({ id: sid }, { type: 'turn/end', data: { turn: 3 } });
  const rows = fs.readFileSync(path.join(h.temp, 'state', 'turn-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).origin, 'free');
  assert.equal(rows.at(-1).confirmedReplies, 0);
  store.mark(free.id);

  now += 10 * minute;
  await receive(group, 35, 99, '刚拆开了桌上新的茶包');
  now += 30 * minute;
  heartbeat();
  tick();
  const wideWindow = store.waking();
  assert.equal(wideWindow.observationSource, 'scheduled');
  assert.deepEqual(wideWindow.evidenceIds, ['qq:group:456:35'], 'scheduled checks show older unread statements for the agent to judge');
  assert.equal((await preStep(wideWindow, 4)).kind, 'enter');
  event({ id: sid }, { type: 'turn/end', data: { turn: 4 } });
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

  console.log('PASS QQ observation, window coverage, source isolation, free time, interrupted usage and tariffs.');
} finally {
  dispose?.();
  Date.now = realNow;
  Math.random = realRandom;
  await h.close();
}
