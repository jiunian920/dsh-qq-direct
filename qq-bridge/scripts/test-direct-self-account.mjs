import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QzonePolicy, dayKey } from '../src/qzone-policy.js';
import { SelfAccount } from '../src/self-account.js';

const sessionId = 'session-account-fixture';
const today = dayKey(Date.now());
let now = Date.parse(today + 'T13:00:00+08:00');
const gatewayCalls = [];
class FixedQzonePolicy extends QzonePolicy {
  constructor(root) {
    super(root, { now: () => now, random: () => 0, evidence: async () => ({ day: today, candidates: [{ id: 7, text: '完成了一次本地测试' }] }) });
  }
}
class FakeSelfAccount extends SelfAccount {
  async onebot(_cfg, action, args = {}) {
    gatewayCalls.push({ action, args });
    return { user_id: 999 };
  }
}

const h = await bridgeHarness({ config: { directSession: { enabled: true, sessionId } }, globals: {
  QzonePolicy: FixedQzonePolicy,
  SelfAccount: FakeSelfAccount,
} });
let server;
try {
  const stateDir = path.join(h.temp, 'state');
  const planFile = path.join(stateDir, 'qzone-plan.json');
  const imageDir = path.join(h.temp, 'assets', 'self-avatars');
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, 'approved.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(stateDir, 'self-account.json'), JSON.stringify({ expectedSelfId: '999', last: {} }));
  h.setMode('reserved2');
  await h.directQzoneOpportunity();
  assert.equal(h.directStore.waking(), undefined, 'an unavailable DSH host must not consume the opportunity');
  h.directStore.publish('dsh', { at: Date.now(), available: true, sessionId });
  const originalAppend = h.directStore.append;
  h.directStore.append = () => false;
  await h.directQzoneOpportunity();
  assert.equal(JSON.parse(fs.readFileSync(planFile, 'utf8')).prompted, false, 'failed enqueue must restore eligibility');
  h.directStore.append = originalAppend;
  await h.directQzoneOpportunity();
  await h.directQzoneOpportunity();
  const channel = 'private:123';
  const items = h.directStore.recent(channel).filter(item => item.qzone);
  assert.equal(items.length, 1);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  assert.equal(items[0].id, `qq:qzone:${plan.opportunityId}`);
  assert.equal(items[0].expiresAt, plan.expiresAt);
  assert.equal(gatewayCalls.length, 0, 'scheduling must not call QQ');

  server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const token = JSON.parse(fs.readFileSync(path.join(stateDir, 'social-v2.json'), 'utf8')).conversations[channel].agentToken;
  const run = async (operation, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/self-account`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken, 'x-agent-token': token },
      body: JSON.stringify({ key: channel, operation, ...args }),
    });
    return { status: response.status, result: await response.json() };
  };
  assert.deepEqual((await run('status')).result.avatarCandidates, ['approved.png']);
  assert.equal((await run('avatar', { imageId: '../private.png' })).status, 400);
  assert.equal((await run('avatar', { imageId: 'approved.png' })).status, 200);
  assert.equal((await run('avatar', { imageId: 'approved.png' })).status, 400);
  assert.equal((await run('signature', { text: '今天也在慢慢学' })).status, 200);
  assert.equal((await run('qzone', { text: '今天完成本地测试', opportunityId: plan.opportunityId, evidenceIds: [8] })).status, 400);
  const post = { text: '今天完成本地测试\r\n慢慢记下来', opportunityId: plan.opportunityId, evidenceIds: [7], imageIds: ['approved.png'] };
  now = plan.expiresAt + 1;
  assert.equal((await run('qzone', post)).status, 400);
  now = plan.expiresAt - 1000;
  assert.equal((await run('qzone', { ...post, text: '输入含\u0001控制字符' })).status, 400);
  assert.equal((await run('qzone', { ...post, imageIds: ['unknown.png'] })).status, 400);
  assert.equal((await run('qzone', post)).status, 200);
  assert.equal((await run('qzone', post)).status, 400);
  const writes = gatewayCalls.filter(call => call.action !== 'get_login_info');
  assert.deepEqual(writes.map(call => call.action), ['set_qq_avatar', 'set_self_longnick', 'send_qzone_msg']);
  assert.equal(writes[2].args.ugc_right, 4);
  assert.equal(writes[2].args.content, '今天完成本地测试\n慢慢记下来');
  assert.equal(writes[2].args.images.length, 1);
  console.log('Direct self-account: scheduling, retries, approved avatar, signature, friends-only post, expiry and replay guard passed. All writes used the fake gateway.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await h.close();
}
