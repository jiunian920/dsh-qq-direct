import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directSessionBinding, openDirectStore } from '../qq-bridge/src/direct-store.mjs';
import { QQ_SAFETY, renderQQContext } from './qq-direct-context.mjs';
import { assertDirectSend, checkedMediaPath } from '../qq-bridge/src/direct-permissions.js';

export const name = 'qq-direct';
export const inject = ['agents', 'tools', 'timer', 'sessionPersistence'];
const PREVIEW = 'qq-preview:';

function tokenReader(stateFile) {
  let cache;
  return channel => {
    try {
      const stat = fs.statSync(stateFile);
      const version = `${stat.mtimeMs}:${stat.size}`;
      if (cache?.version !== version) cache = { version, data: JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
      return String(cache.data?.conversations?.[channel]?.agentToken || '');
    } catch { cache = undefined; return ''; }
  };
}

export function apply(ctx, config) {
  if (!config?.sessionId || !config?.database) return;
  const store = openDirectStore(config.database);
  const budget = config.qqDirect?.contextBudgetChars;
  const contextBudgetChars = Number.isSafeInteger(budget) && budget >= 0 ? Math.min(budget, 20_000) : 4000;
  ctx.effect(() => () => store.close());
  const configuredSessionId = String(config.sessionId);
  const startedAt = Date.now();
  let binding = directSessionBinding(store, configuredSessionId);
  let target = binding.sessionId;
  const follow = config.followDesktop;
  const workspace = typeof follow?.cwd === 'string' && path.isAbsolute(follow.cwd) && path.resolve(follow.cwd);
  const preset = typeof follow?.agentPreset === 'string' && follow.agentPreset;
  let pendingBinding;

  function bindWhenIdle() {
    if (scene || !pendingBinding) return;
    try {
      store.publish('session-binding', pendingBinding);
    } catch (error) {
      console.error('[qq-direct] 会话绑定写入失败:', error.message);
      return;
    }
    binding = pendingBinding;
    target = binding.sessionId;
    pendingBinding = undefined;
    publishedAt = 0;
  }

  if (workspace && preset) {
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      const source = message?.source;
      // Current desktop prompts carry both fields; plain user-kind events do not.
      if (source?.kind !== 'user' || typeof source.rpcId !== 'string' || !source.rpcId
        || typeof source.clientTimeZone !== 'string' || !source.clientTimeZone || source.principal != null) return;
      const header = agent?.session?.header;
      const id = String(agent?.id ?? '');
      if (!/^session-[\w-]+$/.test(id) || id === target || header?.id !== id
        || header.parentSession || header.origin || header.isSeeded || header.agentPreset !== preset
        || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd) || path.relative(workspace, header.cwd) !== ''
        || !Number.isSafeInteger(header.createdAt)) return;
      const baseline = binding.createdAt || ctx.agents.get(target)?.session?.header?.createdAt || startedAt;
      if (header.createdAt <= baseline || (pendingBinding && id !== pendingBinding.sessionId
        && header.createdAt <= pendingBinding.createdAt)) return;
      pendingBinding = { configuredSessionId, sessionId: id, createdAt: header.createdAt };
      bindWhenIdle();
    });
  }
  const exportsDir = fileURLToPath(new URL('../qq-bridge/state/exports/', import.meta.url));
  const stateFile = config.socialState ?? fileURLToPath(new URL('../qq-bridge/state/social-v2.json', import.meta.url));
  const agentTokenFor = tokenReader(stateFile);
  const message = (item, wake = false) => renderQQContext(item, { wake, token: wake ? agentTokenFor(item.channel) : '' });
  let scene;
  let pumping = false;
  let initializedAgent;
  let publishedAt = 0;
  let lastDesktopAt = 0;
  const admitted = new Set();
  let contextTurn;
  const qqTools = new Set(['qq_direct_recent', 'qq_direct_reply', 'qq_direct_revisit', 'read_memory',
    'mcp__memory__search_memory', 'mcp__memory__read_memory_context',
    // ⭐ 2026-11-08 群聊回合也能看图和收藏表情（主人要求：碰到好玩的自己收着用）
    // ⚠️ MCP 工具在 DSH 里的全名带 `mcp__snowluma__` 前缀，写成短名会永远匹配不上
    'mcp__snowluma__qq_get_message_images', 'mcp__snowluma__qq_collect_sticker',
    'mcp__snowluma__qq_list_stickers', 'mcp__snowluma__qq_send_sticker',
    // ⭐ 2026-11-08 读取类工具全放开（主人：QQ 能发出来的种类都要能读）
    'mcp__snowluma__qq_get_forward_msg', 'mcp__snowluma__qq_get_message_detail',
    'mcp__snowluma__qq_get_recent_messages', 'mcp__snowluma__qq_get_unread_messages',
    'mcp__snowluma__qq_get_group_history', 'mcp__snowluma__qq_get_active_members',
    'mcp__snowluma__qq_social_state', 'mcp__snowluma__qq_slang_query',
    'mcp__snowluma__qq_memory_query', 'mcp__snowluma__qq_memory_append']);
  const qzoneTools = new Set(['mcp__snowluma__qq_publish_self_qzone', 'mcp__snowluma__qq_self_account_status',
    'read_memory', 'mcp__memory__search_memory', 'mcp__memory__read_memory_context']);
  const allowed = (channel, bridge = store.runtime('bridge')) =>
    bridge?.sessionId === target && Date.now() - bridge.at < 10_000 && !bridge.paused
    && Array.isArray(bridge.channels) && bridge.channels.includes(channel);
  const writeTool = (name, description, properties, execute, required = []) => ctx.tools.register({
    name, description, timeoutMs: 85_000, parameters: { type: 'object', additionalProperties: false, properties, required },
    output: { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute,
  });
  const current = exec => {
    if (!scene || String(exec?.agent?.id) !== target) throw new Error('当前没有绑定 QQ 的回合。');
    return scene;
  };
  // ⭐ 2026-11-08 主人 QQ（从桥发布的 channels 里取）
  const ownerId = () => {
    const bridge = store.runtime('bridge');
    const ch = Array.isArray(bridge?.channels) ? bridge.channels.find(c => c.startsWith('private:')) : null;
    return ch ? ch.slice('private:'.length) : null;
  };

  ctx.tools.guard(exec => {
    if (String(exec.agent?.id) !== target) return;
    if (scene && !allowed(scene.channel)) return 'QQ 桥已暂停，或当前渠道授权已失效。';
    if (scene?.qzone && (!qzoneTools.has(exec.name)
      || (exec.name.startsWith('mcp__snowluma__') && exec.arguments?.key !== scene.channel))) return '当前回合只处理这次 QQ 空间机会。';
    if (scene && exec.name === 'qq_direct_reply') {
      const args = exec.arguments ?? {};
      try { assertDirectSend(scene, args.channel || scene.channel, args.format, ownerId()); }
      catch (error) { return error.message; }
    }
    // ⭐ 2026-11-08 主人本人发起的群聊回合 → 放开全部工具（电脑检索/改文件/发文件）；
    //    群友发起的回合仍然只给 QQ 对话和记忆工具。私聊本来就不拦。
    if (scene?.channel.startsWith('group:') && String(scene.senderId) !== String(ownerId())) {
      if (!qqTools.has(exec.name)) return 'QQ群回合仅可使用 QQ 对话和记忆工具（群友发起的回合不授予电脑操作）。';
      if (exec.name.startsWith('mcp__snowluma__') && exec.arguments?.key !== scene.channel) return '请使用当前 QQ 群的渠道键。';
    }
  });

  writeTool('qq_direct_recent', '查看本轮 QQ 渠道的发言人、原消息 ID 和引用。指定消息 ID 时优先查该条及它引用的原句。', {
    messageId: { type: 'string', maxLength: 24 },
  }, (args, exec) => {
    const { channel } = current(exec);
    const selected = args.messageId ? store.find(channel, args.messageId) : null;
    const items = args.messageId ? [selected, selected?.quote && store.find(channel, selected.quote.messageId)] : store.recent(channel, 8);
    return { text: items.filter(item => item && !item.opportunity).map((item, i) => renderQQContext(item, { compact: !args.messageId, safety: i === 0 }).content[0].text).join('\n') || '本渠道未找到这条消息。' };
  });
  writeTool('qq_direct_reply', '在原 QQ 渠道发文字、收藏表情、语音、图片或文件。发出即算回复。多人交错或指代不明时引用原消息。', {
    format: { enum: ['text', 'sticker', 'voice', 'image', 'file'] }, text: { type: 'string', maxLength: 500 },
    imagePath: { type: 'string', maxLength: 500, description: '批准目录 state/exports 内的图片路径' },
    filePath: { type: 'string', maxLength: 500, description: '批准目录 state/exports 内的文件路径' },
    channel: { type: 'string', maxLength: 30, description: '可选：改发到主人私聊（private:<主人QQ>），不填就回原渠道' },
    stickerId: { type: 'string', maxLength: 150 }, mood: { type: 'string', maxLength: 40 },
    replyTo: { type: 'string', maxLength: 24 }, toSender: { type: 'string', maxLength: 24 }, mention: { type: 'boolean' },
    replyToCurrent: { type: 'boolean', description: '已核对说话人后，引用触发当前回合的原句。回复其他人请填原消息 ID 和发送者 ID。' },
    broadcast: { type: 'boolean', description: '仅当你要面向全群发言，而非回答某人时填 true' },
  }, async (args, exec) => {
    const active = current(exec);
    exec?.signal?.throwIfAborted();
    const payload = { ...args };
    // ⭐ 2026-11-08 可选跨渠道：主人私聊 ↔ 白名单群 互相发；别的渠道一律不许
    const outChannel = args.channel ? String(args.channel) : active.channel;
    assertDirectSend(active, outChannel, args.format, ownerId());
    if (args.format === 'image') payload.imagePath = checkedMediaPath(exportsDir, args.imagePath);
    if (args.format === 'file') payload.filePath = checkedMediaPath(exportsDir, args.filePath);
    if (args.channel) {
      const bridge = store.runtime('bridge');
      const channels = Array.isArray(bridge?.channels) ? bridge.channels : [];
      const okPrivate = String(outChannel) === 'private:' + ownerId();
      const okGroup = /^group:\d+$/.test(String(outChannel)) && channels.includes(String(outChannel));
      if (!okPrivate && !okGroup) throw new Error('只能改发到主人本人私聊或本群。');
    }
    if (args.replyToCurrent) {
      const original = store.get(active.id);
      if (args.replyTo || args.toSender || args.broadcast || !original?.messageId) throw new Error('请先确定要回复哪一条原消息。');
      payload.replyTo = original.messageId;
      payload.toSender = original.senderId;
    }
    const id = store.enqueue(outChannel, { ...payload, trigger: active.id, sessionId: target, expires: Date.now() + 75_000 },
      exec?.callId ? `${active.id}:${exec.callId}` : undefined);
    const until = Date.now() + 75_000;
    try {
      while (Date.now() < until) {
        exec?.signal?.throwIfAborted();
        const result = store.result(id);
        if (result?.state === 'sent') return { text: `QQ 已确认发送，消息 ID：${result.messageId ?? '网关未提供'}` };
        if (result?.state === 'failed') throw new Error('QQ 发送未完成，诊断见本机桥接日志。');
        if (result?.state === 'unknown') return { text: '发送结果待核实。请先查聊天记录，避免重复发送。' };
        await new Promise(resolve => setTimeout(resolve, 180));
      }
      return { text: '尚未取得发送回执。请先核实聊天记录。' };
    } finally {
      store.cancel(id);
    }
  }, ['format']);
  writeTool('qq_direct_revisit', '如果你想稍后再来看这个群，可以选择大致隔多久。不填或填 0 表示暂不预约。', {
    minutes: { type: 'integer', minimum: 0, maximum: 1440 },
  }, (args, exec) => {
    const channel = current(exec).channel;
    if (channel.startsWith('group:') && args.minutes > 0) store.defer(channel, Date.now() + args.minutes * 60_000);
    return { text: args.minutes > 0 ? '已记下你想稍后再看。' : '这次先潜水。' };
  });

  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const incoming = decision.messages.map(input => store.get(input.id)).find(item => item?.wake);
    if (incoming && (String(agent.id) !== target || !allowed(incoming.channel)
      || (incoming.qzone && Date.now() >= incoming.expiresAt))) return { kind: 'reject' };
    if (String(agent.id) !== target) return decision;
    if (incoming) scene = { id: incoming.id, channel: incoming.channel, turn, senderId: incoming.senderId, qzone: incoming.qzone === true };
    else if (scene?.turn !== turn) scene = undefined;
    if (!scene && step === 1) lastDesktopAt = Date.now();
    const inputs = decision.messages.filter(input => {
      if (!scene || input.source?.kind !== 'user' || input.id === scene.id || store.get(input.id)) return true;
      if (!agent.inbox.nextTurn.some(queued => queued.id === input.id)) agent.followup(input);
      return false;
    });
    if (step !== 1 || contextTurn === turn || contextBudgetChars === 0 || scene?.qzone) return { ...decision, messages: inputs };
    const bridge = store.runtime('bridge') ?? null;
    const channels = (scene ? [scene.channel] : Array.isArray(bridge?.channels) ? bridge.channels : [])
      .filter(channel => allowed(channel, bridge));
    const since = Date.now() - 2 * 60 * 60_000;
    const candidates = channels.flatMap(channel => store.contextCandidates(channel, since, !scene, 12))
      .sort((a, b) => (!scene ? Number(b.channel.startsWith('private:')) - Number(a.channel.startsWith('private:')) : 0) || b.at - a.at);
    const existing = new Set(inputs.map(input => input.id));
    const passive = [];
    let used = QQ_SAFETY.length + 1;
    for (const item of candidates) {
      if (passive.length >= 12) break;
      const id = item.wake ? PREVIEW + item.id : item.id;
      if (existing.has(item.id) || existing.has(id) || admitted.has(id)) continue;
      // Put the boundary in the first actual text block, not in source metadata.
      const block = renderQQContext(item, { compact: true, safety: false });
      const length = block.content[0].text.length;
      if (used + length > contextBudgetChars) continue;
      used += length;
      passive.push({ item, block: { ...block, id } });
    }
    if (passive.length === 0) return { ...decision, messages: inputs };
    contextTurn = turn;
    const selected = passive.sort((a, b) => a.item.at - b.item.at).map(row => row.block);
    selected[0].content[0].text = QQ_SAFETY + '\n' + selected[0].content[0].text;
    return { ...decision, messages: [...selected, ...inputs] };
  });

  ctx.on('session/event', (session, event) => {
    if (String(session.id) !== target) return;
    if (event.type === 'turn/end') {
      contextTurn = undefined;
      if (!scene) lastDesktopAt = Date.now();
      scene = undefined;
      bindWhenIdle();
    }
    if (event.type !== 'user/message') return;
    const id = String(event.data.id);
    if (!id.startsWith('qq:') && !id.startsWith(PREVIEW)) return;
    admitted.add(id);
    void ctx.sessionPersistence.flush().then(() => {
      if (id.startsWith(PREVIEW)) store.markContext(id.slice(PREVIEW.length));
      else store.mark(id);
      admitted.delete(id);
    })
      .catch(error => console.error('[qq-direct] checkpoint:', error.message));
  });

  async function pump() {
    const agent = ctx.agents.get(target);
    if (Date.now() - publishedAt >= 1500) {
      publishedAt = Date.now();
      store.publish('dsh', { at: publishedAt, sessionId: target, available: Boolean(agent) });
    }
    if (pumping || !agent || agent.status !== 'idle') return;
    const item = store.waking();
    if (!item) return;
    if (!allowed(item.channel)) {
      const bridge = store.runtime('bridge');
      if (bridge?.sessionId === target && Date.now() - bridge.at < 10_000 && Array.isArray(bridge.channels) && !bridge.channels.includes(item.channel)) store.mark(item.id);
      return;
    }
    pumping = true;
    try {
      if (initializedAgent !== agent) {
        await ctx.sessionPersistence.flush();
        await using handle = await ctx.sessionPersistence.open(agent.id, 'read');
        if (String(agent.id) !== target) return;
        for (let offset = 0; ; ) {
          const { events } = await handle.read(offset, 512);
          if (String(agent.id) !== target) return;
          if (!events.length) break;
          for (const event of events) {
            if (event.type !== 'user/message') continue;
            const id = String(event.data.id);
            if (id.startsWith(PREVIEW)) store.markContext(id.slice(PREVIEW.length));
            else if (id.startsWith('qq:')) store.mark(id);
          }
          offset += events.length;
        }
        initializedAgent = agent;
      }
      if (String(agent.id) !== target) return;
      const next = store.waking();
      if (next?.opportunity && Date.now() >= (next.expiresAt ?? next.at + 10 * 60_000)) { store.mark(next.id); return; }
      if (next && admitted.has(next.id)) {
        await ctx.sessionPersistence.flush();
        store.mark(next.id);
        admitted.delete(next.id);
        return;
      }
      if (next && next.wakeClass !== 'direct' && Date.now() - lastDesktopAt < 20_000) return;
      if (next && allowed(next.channel) && agent.status === 'idle' && !agent.inbox.nextTurn.length) {
        agent.followup(message(next, true));
      }
    } finally { pumping = false; }
  }
  ctx.setInterval(() => { void pump().catch(error => console.error('[qq-direct] intake:', error.message)); }, 300);
}
