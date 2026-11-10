import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sessionId = 'session-direct-fixture';
const sends = [];
const collectCalls = [];
const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
let sequence = 300;
const h = await bridgeHarness({
  config: { directSession: { enabled: true, sessionId } },
  bot: { async request(action, params) {
    collectCalls.push({ action, params });
    if (action === 'add_custom_face') return { status: 'ok', retcode: 0, data: { emoji_id: 'fixture-collected' } };
    return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
  } },
  globals: { safeFetchBuffer: async () => ({ buffer: image }), fetch: async (url, request) => {
    sends.push({ action: new URL(url).pathname, body: JSON.parse(request.body) });
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: ++sequence } }) };
  } },
});
let fakeTts;
try {
  h.setMode('reserved2');
  const event = (messageId, senderId, body) => ({ message_id: messageId, user_id: senderId,
    self_id: 999, sender: { nickname: '同昵称' }, message: [{ type: 'text', data: { text: body } }] });
  await h.handleIncoming('group', '456', event(-5, 12, '岸岸，先说甲话题'), h.cfg);
  await h.handleIncoming('group', '456', event(-6, 13, '这是乙话题'), h.cfg);
  await h.handleIncoming('group', '456', event(-6, 13, '重复事件'), h.cfg);
  await h.handleIncoming('private', '123', event(-7, 123, '帮我用电脑看一下文件'), h.cfg);
  assert.equal(h.directStore.recent('group:456').length, 2);
  assert.equal(h.directStore.recent('private:123')[0].wake, true);
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.calls.sent.length, 0);

  h.directStore.append({
    id: 'qq:group:456:808', channel: 'group:456', messageId: '808', senderId: '12', at: Date.now(),
    text: '', wake: false, attachments: [{ kind: 'image', url: 'https://public.invalid/fixture.png' }],
  });
  await assert.rejects(h.collectStickerV2('private:123', '808'), /找不到这条消息/);
  const collected = await h.collectStickerV2('group:456', '808');
  assert.equal(collected.emojiId, 'fixture-collected');
  assert.equal(collectCalls.find(x => x.action === 'add_custom_face').params.file, 'base64://' + image.toString('base64'));
  const route = { sessionId, trigger: 'qq:group:456:-5', expires: Date.now() + 60_000 };
  const send = async (params, channel = 'group:456') => {
    const id = h.directStore.enqueue(channel, { ...route, ...params });
    await h.sendDirect();
    return h.directStore.result(id);
  };
  assert.equal((await send({ format: 'text', text: '错人', replyTo: '-5', toSender: '13' })).state, 'failed');
  assert.equal((await send({ format: 'text', text: '错会话', sessionId: 'session-other', replyTo: '-5', toSender: '12' })).state, 'failed');
  assert.equal(sends.length, 0);
  assert.equal((await send({ format: 'text', text: '回应甲', replyTo: '-5', toSender: '12', mention: true })).state, 'sent');
  assert.deepEqual(sends[0].body.message.slice(0, 2), [{ type: 'reply', data: { id: '-5' } }, { type: 'at', data: { qq: '12' } }]);
  assert.equal((await send({ format: 'sticker', stickerId: 'fixture-sticker', replyTo: '-6', toSender: '13' })).state, 'sent');
  assert.equal(sends[1].action, '/send_custom_face');
  assert.equal(sends[1].body.reply_to, undefined);

  const queueDir = path.join(h.temp, 'voice');
  const outDir = path.join(queueDir, 'out');
  const receipts = path.join(queueDir, 'receipts');
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(queueDir, 'alive.json'), JSON.stringify({ ts: Date.now() / 1000 }));
  h.cfg.voice = { enabled: true, queueDir, outDir, timeoutMs: 3000 };
  fakeTts = setInterval(() => {
    for (const name of fs.readdirSync(queueDir).filter(name => name.startsWith('req-'))) {
      const job = JSON.parse(fs.readFileSync(path.join(queueDir, name), 'utf8'));
      fs.writeFileSync(job.out, 'fake WAV fixture');
      fs.writeFileSync(path.join(receipts, name), JSON.stringify({ status: 'completed', output: job.out }));
    }
  }, 20);
  assert.equal((await send({ format: 'voice', text: '晚安', replyTo: '-6', toSender: '13' })).state, 'sent');
  assert.deepEqual(sends[2].body.message.map(part => part.type), ['record']);
  assert.equal((await send({ format: 'text', text: '面向群' })).state, 'failed');
  assert.equal((await send({ format: 'text', text: '面向群', broadcast: true })).state, 'sent');
  const exportsDir = path.join(h.temp, 'state', 'exports');
  fs.mkdirSync(exportsDir);
  const imagePath = path.join(exportsDir, 'fixture.png');
  fs.writeFileSync(imagePath, 'image path fixture');
  const blocked = sends.length;
  assert.equal((await send({ format: 'image', imagePath })).state, 'failed');
  assert.equal((await send({ format: 'file', filePath: imagePath, broadcast: true })).state, 'failed');
  assert.equal((await send({ format: 'text', text: '跨渠道' }, 'private:123')).state, 'failed');
  assert.equal(sends.length, blocked);
  const owner = { trigger: 'qq:private:123:-7' };
  assert.equal((await send({ ...owner, format: 'image', imagePath })).state, 'sent');
  assert.equal(sends.at(-1).body.message[0].type, 'image');
  const filePath = path.join(exportsDir, 'readme.txt');
  fs.writeFileSync(filePath, 'file fixture');
  assert.equal((await send({ ...owner, format: 'file', filePath, broadcast: true })).state, 'sent');
  assert.equal(sends.at(-1).body.message[0].type, 'file');
  const secretPath = path.join(exportsDir, 'fixture.pem');
  fs.writeFileSync(secretPath, 'fake sensitive file fixture');
  const before = sends.length;
  assert.equal((await send({ ...owner, format: 'file', filePath: secretPath, broadcast: true })).state, 'failed');
  const outside = path.join(h.temp, 'outside.txt');
  fs.writeFileSync(outside, 'outside fixture');
  assert.equal((await send({ ...owner, format: 'file', filePath: outside, broadcast: true })).state, 'failed');
  const alias = path.join(exportsDir, 'alias.txt');
  fs.linkSync(outside, alias);
  assert.equal((await send({ ...owner, format: 'file', filePath: alias, broadcast: true })).state, 'failed');
  assert.equal(sends.length, before);
  console.log('Direct bridge: intake, same-nickname binding, five send formats and credential-file guard passed.');
} finally {
  clearInterval(fakeTts);
  await h.close();
}
