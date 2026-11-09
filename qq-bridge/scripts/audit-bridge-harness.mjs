// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
import { SelfAccount } from '../src/self-account.js';
import { ComputerTasks, explicitComputerRequest } from '../src/computer-tasks.js';
import { QzonePolicy } from '../src/qzone-policy.js';
import * as unified from '../src/unified-qq.js';
import * as direct from '../src/direct-store.mjs';
import * as media from '../src/message-media.js';
import * as bridgeConfig from '../src/bridge-config.js';
import { segmentsToText } from '../src/qq-message.js';
import { createDirectRuntime } from '../src/direct-runtime.js';
import { unifiedPromptEnvelope } from '../src/qq-prompt-envelope.js';
import { PUBLIC_MEMORY_CORE } from '../src/public-memory-client.js';
import { prepareVisionMedia, previewVideo, sliceLongImage } from '../src/animation-media.js';
import { biliVideoId, readBiliMedia } from '../src/bili-media.js';
import { groupWake } from '../src/qq-wake.js';
import * as rollover from '../src/session-rollover.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, globals = {}, bot = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [] };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    constructor() { Object.assign(this, bot); }
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  source = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendBurstToQQ, auditAndSend, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    directStore, sendDirect, directQzoneOpportunity,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    process: { pid: process.pid, platform: process.platform, kill: process.kill, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    SelfAccount, ComputerTasks, explicitComputerRequest, QzonePolicy, unifiedPromptEnvelope, prepareVisionMedia,
    previewVideo, sliceLongImage, biliVideoId, readBiliMedia, groupWake,
    PUBLIC_MEMORY_CORE, publicMemoryQuery: async () => null,
    ...unified, ...direct, ...rollover, ...media, ...bridgeConfig, segmentsToText, createDirectRuntime,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...globals,
  });
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    bridge.directStore?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
