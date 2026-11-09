import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { groupWake } from '../src/qq-wake.js';

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=';
const segments = [{ type: 'image', data: { file: '0123456789ABCDEF0123456789ABCDEF.png' } },
  { type: 'forward', data: { res_id: 'forward-seen' } }];
const h = await bridgeHarness({ config: { directSession: { enabled: true, sessionId: 'session-media-fixture' },
  allow: { groups: ['456', '457'], private: ['123'] } },
savedState: { unified: { sessionId: 'session-retired-qq', activeKey: 'group:456' } }, bot: {
  async getImage() { return { base64: tinyPng }; },
  async getMessage(id) { return { group_id: id === -5 ? 456 : 457, user_id: 12, message: segments }; },
  async raw(action, args) {
    assert.equal(action, 'get_forward_msg');
    assert.equal(args.id, 'forward-seen');
    return { messages: [{ sender: { nickname: '群友', user_id: 12 }, message: [{ type: 'text', data: { text: '转发样本' } }] }] };
  },
}, globals: {
  readBiliMedia: async (id, preview) => ({ text: `${id}:${preview ? 'preview' : 'metadata'}` }),
  previewVideo: async url => ({ text: url === 'https://public.invalid/sample.mp4' ? 'video fixture' : 'unexpected' }),
} });

let server;
try {
  h.setMode('reserved2');
  const event = (id, parts) => ({ message_id: id, user_id: 12, self_id: 999, sender: { nickname: '同名' }, message: parts });
  await h.handleIncoming('group', '456', event(-1, segments), h.cfg);
  await h.handleIncoming('group', '457', event(-2, [{ type: 'text', data: { text: '另一个群' } }]), h.cfg);
  await h.handleIncoming('group', '456', event(-3, [{ type: 'text', data: { text: 'https://www.bilibili.com/video/BV1whnM62ECg/' } }]), h.cfg);
  await h.handleIncoming('group', '456', event(-4, [{ type: 'video', data: { url: 'https://public.invalid/sample.mp4' } }]), h.cfg);
  await h.handleIncoming('private', '123', { ...event(-7, [{ type: 'video', data: { url: 'https://public.invalid/sample.mp4' } }]), user_id: 123 }, h.cfg);
  for (const id of [-5, -6]) h.directStore.append({ id: `qq:group:456:${id}`, channel: 'group:456', messageId: String(id),
    at: Date.now(), text: '[图片]', wake: false, media: [{ type: 'image', ref: '' }] });
  const legacy = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  assert.deepEqual(legacy.conversations['group:456'].recentMessages, []);
  server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, params, key = 'group:456', token = legacy.conversations[key]?.agentToken) => {
    const response = await fetch(`${root}${route}?${new URLSearchParams({ key, ...params })}`, {
      headers: { 'x-console-token': h.cfg.consoleToken, ...(token ? { 'x-agent-token': token } : {}) },
    });
    return { status: response.status, data: await response.json() };
  };
  const image = id => call('/api/images/message', { messageId: String(id) });
  assert.equal((await image(-1)).data.images[0].mimeType, 'image/png');
  assert.equal((await image(-5)).data.images[0].mimeType, 'image/png');
  assert.deepEqual((await image(-6)).data.images, []);
  assert.deepEqual((await call('/api/images/message', { messageId: '-1' }, 'group:457')).data.images, []);
  assert.equal((await call('/api/socialV2/forward-message', { id: 'forward-seen' })).status, 200);
  assert.equal((await call('/api/socialV2/forward-message', { id: 'forward-seen' }, 'group:457')).status, 404);
  assert.equal((await call('/api/socialV2/message-detail', { messageId: '-1' })).data.info.sender, '同名');
  assert.equal((await call('/api/socialV2/recent', { limit: '20' })).data.messages.length, 5);
  assert.equal((await image(-3)).data.images[0].text, 'BV1whnM62ECg:metadata');
  assert.equal((await call('/api/images/message', { messageId: '-3', biliPreview: 'true' })).data.images[0].text, 'BV1whnM62ECg:preview');
  assert.equal((await image(-4)).data.images[0].text, 'video fixture');
  assert.equal((await call('/api/images/message', { messageId: '-7' }, 'private:123')).data.images[0].text, 'video fixture');
  assert.equal((await call('/api/images/message', { messageId: '-7' }, 'private:123', legacy.conversations['group:456'].agentToken)).status, 403);

  const now = 1_000_000;
  const recent = [{ text: '我们讨论蓝鲸模型的骨骼绑定', senderId: '12', messageId: '-1', at: now - 5000 }];
  assert.equal(groupWake({ text: '在吗', addressed: true, recent, now }), 'direct');
  assert.equal(groupWake({ text: '蓝鲸模型的骨骼绑定继续吗', recent, lastWake: now - 5000, now }), 'continuation');
  assert.equal(groupWake({ text: '今天天气真好', recent, lastWake: now - 5000, now }), null);
  assert.equal(groupWake({ text: '蓝鲸模型的骨骼绑定怎么做？', recent, now, random: () => 0.12 }), 'opportunity');
  console.log('Direct media, old gateway fallback, cross-channel denial, forward, media routes, recent and wake scoring passed.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await h.close();
}
