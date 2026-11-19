import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directSessionBinding, openDirectStore } from '../qq-bridge/src/direct-store.mjs';
import { QQ_SAFETY, renderQQContext, renderDesktopGroupPointer } from './qq-direct-context.mjs';
import { createTurnUsage, isDesktopInput } from './qq-direct-usage.mjs';
import { assertDirectSend, checkedMediaPath } from '../qq-bridge/src/direct-permissions.js';
import { observationEvidence, scheduledObservationEvidence } from '../qq-bridge/src/qq-wake.js';

import { assertDesktopDraftPrivacy, compileDesktopDraft, desktopDraftKinds, desktopDraftLifetime, privateDraftTexts } from '../qq-bridge/src/desktop-draft.mjs';

export const name = 'qq-direct';
export const inject = ['agents', 'tools', 'timer', 'sessionPersistence'];
const PREVIEW = 'qq-preview:';
const DRAFT_PREVIEW = 'qq-draft-preview:';
const DESKTOP_DRAFT_TOOLS = new Set(['qq_desktop_draft', 'qq_desktop_group_index']);

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
  const observationContext = item => {
    if (item.observationCancelled) return [];
    const messages = store.observationContext(item);
    if (item.observationVersion === 2) return messages;
    return item.observationSource === 'scheduled' ? scheduledObservationEvidence(messages, item.topics)
      : observationEvidence(messages, item.focusId, item.topics);
  };
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
      if (!isDesktopInput(message?.source)) return;
      const header = agent?.session?.header;
      const id = String(agent?.id ?? '');
      if (!/^session-[\w-]+$/.test(id) || id === target || header?.id !== id
        || header.parentSession || header.origin || header.isSeeded || (header.delegationDepth ?? 0) !== 0
        || header.agentPreset !== preset
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
  let desktopDraftScope;
  let pumping = false;
  let initializedAgent;
  let publishedAt = 0;
  let lastDesktopAt = 0;
  const admitted = new Set();
  let contextTurn;
  const usage = createTurnUsage(path.join(path.dirname(config.database), 'turn-usage.jsonl'));
  const freeTools = new Set(['mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch', 'qq_free_draw']);
  const freeArtDir = path.join(path.dirname(config.database), 'free-art');
  const qqTools = new Set(['qq_direct_recent', 'qq_direct_reply', 'qq_direct_revisit',
    // ⭐ 2026-11-08 群聊回合也能看图和收藏表情（主人要求：碰到好玩的自己收着用）
    // ⚠️ MCP 工具在 DSH 里的全名带 `mcp__snowluma__` 前缀，写成短名会永远匹配不上
    'mcp__snowluma__qq_get_message_images', 'mcp__snowluma__qq_collect_sticker',
    'mcp__snowluma__qq_list_stickers', 'mcp__snowluma__qq_send_sticker',
    // ⭐ 2026-11-08 读取类工具全放开（主人：QQ 能发出来的种类都要能读）
    'mcp__snowluma__qq_get_forward_msg', 'mcp__snowluma__qq_get_message_detail',
    'mcp__snowluma__qq_get_recent_messages', 'mcp__snowluma__qq_get_unread_messages',
    'mcp__snowluma__qq_get_group_history', 'mcp__snowluma__qq_get_active_members',
    'mcp__snowluma__qq_social_state', 'mcp__snowluma__qq_slang_query']);
  const qzoneTools = new Set(['mcp__snowluma__qq_publish_self_qzone', 'mcp__snowluma__qq_self_account_status',
    'read_memory', 'mcp__memory__search_memory', 'mcp__memory__read_memory_context']);
  const allowed = (channel, bridge = store.runtime('bridge')) =>
    bridge?.sessionId === target && (bridge.bindingCreatedAt ?? 0) === binding.createdAt
    && Date.now() - bridge.at < 10_000 && !bridge.paused
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

  const draftScopeFor = exec => {
    const scope = desktopDraftScope;
    if (scene || !scope?.confirmed || scope.agent !== exec?.agent || scope.sessionId !== target ||
      scope.bindingCreatedAt !== binding.createdAt || scope.expires <= Date.now()) return undefined;
    return scope;
  };

  ctx.tools.guard(exec => {
    if (DESKTOP_DRAFT_TOOLS.has(exec.name) && !draftScopeFor(exec)) return '只有桌面本人发起的回合可以提交群聊草稿。';
    if (String(exec.agent?.id) !== target) return;
    if (desktopDraftScope?.readGroup && desktopDraftScope.agent === exec.agent && !DESKTOP_DRAFT_TOOLS.has(exec.name)) {
      return '本轮已打开群聊原句，只可查看或提交回群草稿。电脑操作可在下一轮继续。';
    }
    if (scene && !allowed(scene.channel)) return 'QQ 桥已暂停，或当前渠道授权已失效。';
    if (scene?.free && !freeTools.has(exec.name)) {
      if (!scene.autonomousChoice || exec.name !== 'qq_direct_reply' || store.runtime('bridge')?.autonomousChoiceEnabled !== true) {
        return '自主时段可浏览公开网页、画画或安静结束；启用自主选择时也可发文字或收藏表情。';
      }
    }
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

  writeTool('qq_desktop_group_index', '按群或消息 ID 查索引。选好一条后用 includeText 查看原句并在本轮亲自写草稿。', {
    channel: { type: 'string', pattern: '^group:[1-9][0-9]*$' },
    messageId: { type: 'string', pattern: '^-?[1-9][0-9]*$' },
    includeText: { type: 'boolean', description: '指定原消息 ID 时查看原句，本轮随后只能处理这个群的回信。' },
  }, (request, exec) => {
    const scope = draftScopeFor(exec);
    const bridge = store.runtime('bridge');
    if (!scope || !bridge?.supportsAgentAuthoredDraft || typeof request.channel !== 'string' ||
      !/^group:[1-9][0-9]*$/.test(request.channel) || !allowed(request.channel, bridge)
      || (scope.readGroup && scope.readGroup !== request.channel)) {
      throw new Error('当前不能查看这个群的桌面索引。');
    }
    const candidates = request.messageId ? [store.find(request.channel, request.messageId)] : store.recent(request.channel, 25);
    const indices = candidates.filter(item => item && !item.opportunity && item.channel === request.channel && item.messageId);
    for (const item of indices) scope.materials.add(item.id);
    if (request.includeText) {
      const item = request.messageId && indices[0];
      if (!item) throw new Error('查看原句时需要一个有效的原消息 ID。');
      scope.readGroup = request.channel;
      return { text: QQ_SAFETY + '\n' + JSON.stringify({ 渠道: item.channel, 消息ID: item.messageId,
        发言人ID: item.senderId, 正文: String(item.text ?? '').slice(0, 400) }) };
    }
    return { text: indices.length ? indices.map(item => renderDesktopGroupPointer(item, item.id).content[0].text).join('\n')
      : '该群账本里未找到对应消息。' };
  }, ['channel']);

  writeTool('qq_desktop_draft', '读过原句后自己写回群正文，列出实际参考的原群消息和批准公开资料，再交给桥核对。单发表情时填收藏编号。', {
    channel: { type: 'string', pattern: '^group:[1-9][0-9]*$' },
    messageId: { type: 'string', pattern: '^-?[1-9][0-9]*$' },
    kind: { enum: desktopDraftKinds },
    text: { type: 'string', maxLength: 240, description: '你亲自写的单行群聊正文。单发表情时省略。' },
    materials: { type: 'array', minItems: 1, maxItems: 6, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['type', 'messageId'],
        properties: { type: { const: 'group' }, messageId: { type: 'string', pattern: '^-?[1-9][0-9]*$' } } },
      { type: 'object', additionalProperties: false, required: ['type', 'id'],
        properties: { type: { const: 'public' }, id: { type: 'integer', minimum: 1 } } },
    ] } },
    publicId: { type: 'integer', minimum: 1, description: '仅 public-note 使用，经批准的公开资料 ID' },
    stickerId: { type: 'string', maxLength: 150, description: '仅 sticker 使用，现有收藏编号' },
  }, async (request, exec) => {
    const scope = draftScopeFor(exec);
    if (!scope) throw new Error('当前没有可用的桌面草稿授权。');
    exec?.signal?.throwIfAborted();
    const bridge = store.runtime('bridge');
    if (!bridge?.supportsAgentAuthoredDraft || !allowed(request.channel, bridge) ||
      !scope.materials.has(`qq:${request.channel}:${request.messageId}`) ||
      (Array.isArray(request.materials) && request.materials.some(item => item?.type === 'group'
        && !scope.materials.has(`qq:${request.channel}:${item.messageId}`)))) {
      throw new Error('草稿须引用本回合索引中的白名单群消息。');
    }
    if (request.kind !== 'sticker' && scope.readGroup !== request.channel) throw new Error('请先用群消息索引查看原句，再写正文。');
    const { payload, materials, excerpts } = compileDesktopDraft(store, request);
    assertDesktopDraftPrivacy(payload.text, excerpts,
      [...scope.privateTexts, ...privateDraftTexts(store, ownerId() ? `private:${ownerId()}` : undefined)]);
    const now = Date.now();
    const id = randomUUID();
    if (!store.queueDesktopDraft({ id, turnKey: scope.sessionId + ':' + scope.inputId, request, payload, materials,
      sessionId: scope.sessionId, bindingCreatedAt: scope.bindingCreatedAt, expires: now + desktopDraftLifetime })) {
      throw new Error('这条桌面输入已有一份群聊草稿。');
    }
    try {
      while (Date.now() < now + desktopDraftLifetime) {
        exec?.signal?.throwIfAborted();
        const receipt = store.result(id);
        if (receipt?.state === 'sent') {
          if (desktopDraftScope === scope) usage.confirm(1);
          return { text: '群聊草稿已发送。' + JSON.stringify({ format: receipt.format, text: receipt.text,
            replyTo: receipt.replyTo ?? null, messageId: receipt.messageId, materials: materials.map(item => item.type === 'group'
              ? { type: item.type, messageId: item.messageId } : { type: item.type, id: item.id }) }) };
        }
        if (receipt?.state === 'failed') return { text: '群聊草稿未送达。' + (receipt.error ?? '可在本机查看发送日志。') };
        if (receipt?.state === 'unknown') return { text: '群聊草稿结果待核实，请先查聊天记录。' };
        await new Promise(resolve => setTimeout(resolve, 180));
      }
      return { text: '群聊草稿尚未取得回执，请先查聊天记录。' };
    } finally {
      store.cancel(id);
    }
  }, ['channel', 'messageId', 'kind']);

  writeTool('qq_free_draw', '在自主时段用 SVG 路径画一幅图并保存到本机。画布为 512×512。', {
    strokes: { type: 'array', minItems: 1, maxItems: 40, items: {
      type: 'object', additionalProperties: false, required: ['path', 'color', 'width'],
      properties: {
        path: { type: 'string', maxLength: 1200 },
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        width: { type: 'number', minimum: 0.5, maximum: 32 },
      },
    } },
  }, (args, exec) => {
    if (!current(exec).free) throw new Error('此工具仅在自主时段可用。');
    if (!Array.isArray(args.strokes) || args.strokes.length < 1 || args.strokes.length > 40) throw new Error('画笔数量无效。');
    const strokes = args.strokes.map(({ path: drawing, color, width }) => {
      if (typeof drawing !== 'string' || drawing.length > 1200 || !/^[Mm][MmLlHhVvCcSsQqTtAaZz0-9.,+ -]+$/.test(drawing)
        || !/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isFinite(width) || width < 0.5 || width > 32) throw new Error('画笔参数无效。');
      return `<path d="${drawing}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    });
    fs.mkdirSync(freeArtDir, { recursive: true });
    const filename = checkedMediaPath(freeArtDir, `drawing-${randomUUID()}.svg`, { newFile: true });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#ffffff"/>${strokes.join('')}</svg>`;
    fs.writeFileSync(filename, svg, { encoding: 'utf8', flag: 'wx' });
    return { text: '画已保存到本机。' };
  }, ['strokes']);

  writeTool('qq_direct_recent', '查看本轮 QQ 渠道的发言人、原消息 ID 和引用。指定消息 ID 时优先查该条及它引用的原句。', {
    messageId: { type: 'string', maxLength: 24 },
  }, (args, exec) => {
    const { channel } = current(exec);
    const selected = args.messageId ? store.find(channel, args.messageId) : null;
    const items = args.messageId ? [selected, selected?.quote && store.find(channel, selected.quote.messageId)] : store.recent(channel, 8);
    return { text: items.filter(item => item && !item.opportunity).map((item, i) => renderQQContext(item, { compact: !args.messageId, safety: i === 0 }).content[0].text).join('\n') || '本渠道未找到这条消息。' };
  });
  writeTool('qq_direct_reply', '在原 QQ 渠道发文字、收藏表情、语音、图片或文件。多人交错或指代不明时引用原消息。最后一条发言填 final:true。', {
    final: { type: 'boolean', description: '仅当本轮全部事项已完成、这是最后一条回复时填 true。确认送达后结束本轮。仍需发多条或继续处理时留空。' },
    format: { enum: ['text', 'sticker', 'voice', 'image', 'file'] }, text: { type: 'string', maxLength: 500 },
    imagePath: { type: 'string', maxLength: 500, description: '批准目录 state/exports 内的图片路径' },
    filePath: { type: 'string', maxLength: 500, description: '批准目录 state/exports 内的文件路径' },
    channel: { type: 'string', maxLength: 30, description: 'QQ 渠道键。不填则用本回合渠道；自主选择可指定白名单群或授权私聊。' },
    stickerId: { type: 'string', maxLength: 150 }, mood: { type: 'string', maxLength: 40 },
    replyTo: { type: 'string', maxLength: 24 }, toSender: { type: 'string', maxLength: 24 }, mention: { type: 'boolean' },
    replyToCurrent: { type: 'boolean', description: '已核对说话人后，引用触发当前回合的原句。回复其他人请填原消息 ID 和发送者 ID。' },
    broadcast: { type: 'boolean', description: '可选的面向全群发言标记。普通群聊可以直接发文字。' },
    // ⭐ 2026-11-12 加：群聊里 @ 指定的人。桥本来就支持 atUserId（sendMessagesV2 的形参 / HTTP body），
    //    只是插件这一层以前没暴露 —— 结果传进来会被 schema 丢掉，消息发出去了却没有 @ 段。
    //    ⚠️ 单独给 atUserId、不给 replyTo/broadcast 时，桥会判「请核对原消息和发送者」而拒发；下面自动补 broadcast。
    atUserId: { type: 'string', maxLength: 24, description: '群聊时 @ 某位群成员的 QQ 号（不要填 all）' },
  }, async (args, exec) => {
    const active = current(exec);
    exec?.signal?.throwIfAborted();
    const { final, ...payload } = args;
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
      const original = store.get(active.focusId ?? active.id);
      if (args.replyTo || args.toSender || args.broadcast || !original?.messageId || original.channel !== active.channel) throw new Error('请先确定要回复哪一条原消息。');
      payload.replyTo = original.messageId;
      payload.toSender = original.senderId;
    }
    // ⭐ 2026-11-12：群聊 @ 指定的人（桥侧支持 atUserId，插件以前没透传）
    if (args.atUserId !== undefined && args.atUserId !== null && String(args.atUserId).trim() !== '') {
      const at = String(args.atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号（不能是 all）');
      payload.atUserId = at;
    }
    const id = store.enqueue(outChannel, { ...payload, trigger: active.id, sessionId: target,
      bindingCreatedAt: binding.createdAt, expires: Date.now() + 75_000 },
      exec?.callId ? `${active.id}:${exec.callId}` : undefined);
    const until = Date.now() + 75_000;
    try {
      while (Date.now() < until) {
        exec?.signal?.throwIfAborted();
        const result = store.result(id);
        if (result?.state === 'sent') {
          active.confirmedReplies.add(id);
          usage.confirm(active.confirmedReplies.size);
          if (final === true) exec.concludeTurn?.();
          return { text: `QQ 已确认发送，消息 ID：${result.messageId ?? '网关未提供'}` };
        }
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
    if (String(agent.id) !== target) return incoming ? { kind: 'reject' } : decision;
    if (incoming && (!allowed(incoming.channel) || (incoming.qzone && Date.now() >= incoming.expiresAt))) return { kind: 'reject' };
    const automatic = step === 1 && incoming?.observationSource != null;
    const knownEvidence = automatic && contextBudgetChars > 0 && Date.now() < incoming.expiresAt
      ? observationContext(incoming) : [];
    const deferInput = input => {
      if (!agent.inbox.nextTurn.some(queued => queued.id === input.id)) agent.followup(input);
    };
    const discardObservation = () => {
      store.mark(incoming.id);
      if (scene?.id === incoming.id) scene = undefined;
      for (const input of decision.messages) {
        if (['user', 'schedule', 'task'].includes(input.source?.kind)) deferInput(input);
      }
      return { kind: 'reject' };
    };
    if (automatic && !knownEvidence.length) return discardObservation();
    if (incoming?.free && ((incoming.autonomousChoice && store.runtime('bridge')?.autonomousChoiceEnabled !== true)
      || Date.now() >= incoming.expiresAt || incoming.sessionId !== target
      || incoming.bindingCreatedAt !== binding.createdAt)) return discardObservation();
    if (incoming && (scene?.id !== incoming.id || scene?.turn !== turn)) {
      scene = { id: incoming.id, channel: incoming.channel, turn, senderId: incoming.senderId, qzone: incoming.qzone === true,
        free: incoming.free === true, autonomousChoice: incoming.autonomousChoice === true, focusId: incoming.focusId, observationSource: incoming.observationSource ?? (incoming.opportunity && !incoming.qzone ? 'revisit' : undefined),
        origin: incoming.free ? 'free' : incoming.qzone ? 'qq-qzone' : incoming.opportunity ? 'qq-opportunity'
          : incoming.channel.startsWith('group:') ? 'qq-group' : 'qq-private', confirmedReplies: new Set() };
    } else if (!incoming && scene?.turn !== turn) scene = undefined;
    if (!scene && step === 1) lastDesktopAt = Date.now();
    if (incoming || desktopDraftScope?.turn !== turn) desktopDraftScope = undefined;
    const inputs = decision.messages.filter(input => {
      if (scene?.free && input.id !== scene.id && store.get(input.id)) {
        deferInput(input);
        return false;
      }
      const userInput = input.source?.kind === 'user' || (scene?.free && ['schedule', 'task'].includes(input.source?.kind));
      if (!scene || !userInput || input.id === scene.id || store.get(input.id)) return true;
      deferInput(input);
      return false;
    });
    const origin = scene?.origin ?? (inputs.some(input => isDesktopInput(input.source)) ? 'desktop' : undefined);
    const enter = (messages, draftMaterials = []) => {
      const desktopInput = step === 1 && !scene && inputs.find(input => isDesktopInput(input.source));
      if (desktopInput && typeof desktopInput.id === 'string' && !desktopDraftScope) {
        desktopDraftScope = { turn, agent, inputId: desktopInput.id, sessionId: target, bindingCreatedAt: binding.createdAt,
          expires: Date.now() + 5 * 60_000, confirmed: false,
          materials: new Set(draftMaterials), privateTexts: inputs.filter(input => isDesktopInput(input.source))
            .flatMap(input => (input.content ?? []).filter(part => part.type === 'text').map(part => String(part.text ?? '').slice(0, 8000))) };
      }
      usage.enter(turn, origin, messages, scene?.observationSource);
      return { ...decision, messages };
    };
    if (step !== 1 || contextTurn === turn || contextBudgetChars === 0 || scene?.qzone || scene?.free) return enter(inputs);
    const bridge = store.runtime('bridge') ?? null;
    const channels = (scene ? [scene.channel] : Array.isArray(bridge?.channels) ? bridge.channels : [])
      .filter(channel => allowed(channel, bridge));
    const since = Date.now() - 2 * 60 * 60_000;
    const candidates = (automatic ? knownEvidence : channels.flatMap(channel => store.contextCandidates(channel, since, !scene, 12)))
      .sort((a, b) => (!scene ? Number(b.channel.startsWith('private:')) - Number(a.channel.startsWith('private:')) : 0) || b.at - a.at);
    const existing = new Set(inputs.map(input => input.id));
    const passive = [];
    let used = QQ_SAFETY.length + 1;
    for (const item of candidates) {
      if (passive.length >= 12) break;
      const useIndex = !scene && origin === 'desktop' && item.channel.startsWith('group:') && bridge?.supportsDesktopDraft;
      const id = useIndex ? DRAFT_PREVIEW + item.id : item.wake ? PREVIEW + item.id : item.id;
      if (existing.has(item.id) || existing.has(id) || admitted.has(id) || (useIndex && store.sawContext(id))) continue;
      // Put the boundary in the first actual text block, not in source metadata.
      const block = useIndex ? renderDesktopGroupPointer(item, id) : renderQQContext(item, { compact: true, safety: false, showTime: automatic });
      const length = block.content[0].text.length;
      if (used + length > contextBudgetChars) continue;
      used += length;
      passive.push({ item, block: { ...block, id }, draftMaterial: useIndex ? item.id : undefined });
    }
    if (passive.length === 0) return automatic ? discardObservation() : enter(inputs);
    contextTurn = turn;
    const selected = passive.sort((a, b) => a.item.at - b.item.at).map(row => row.block);
    selected[0].content[0].text = QQ_SAFETY + '\n' + selected[0].content[0].text;
    return enter([...selected, ...inputs], passive.map(row => row.draftMaterial).filter(Boolean));
  });

  ctx.on('session/event', (session, event) => {
    if (String(session.id) !== target) return;
    if (event.type === 'tool/result' && desktopDraftScope?.confirmed && !desktopDraftScope.readGroup
      && event.data?.turn === desktopDraftScope.turn) {
      const blocks = event.data?.message?.content ?? [];
      const observed = blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text.slice(0, 8000));
      desktopDraftScope.privateTexts = [...desktopDraftScope.privateTexts, ...observed].slice(-16);
    }
    if (event.type === 'assistant/message') usage.response(event.data);
    if (event.type === 'turn/end') {
      usage.end(event.data, scene?.confirmedReplies.size ?? 0);
      contextTurn = undefined;
      if (!scene) lastDesktopAt = Date.now();
      scene = undefined;
      desktopDraftScope = undefined;
      bindWhenIdle();
    }
    if (event.type !== 'user/message') return;
    const id = String(event.data.id);
    if (desktopDraftScope?.inputId === id && isDesktopInput(event.data.source)) desktopDraftScope.confirmed = true;
    if (!id.startsWith('qq:') && !id.startsWith(PREVIEW) && !id.startsWith(DRAFT_PREVIEW)) return;
    admitted.add(id);
    void ctx.sessionPersistence.flush().then(() => {
      if (id.startsWith(DRAFT_PREVIEW)) store.markContext(id);
      else if (id.startsWith(PREVIEW)) store.markContext(id.slice(PREVIEW.length));
      else store.mark(id);
      admitted.delete(id);
    })
      .catch(error => console.error('[qq-direct] checkpoint:', error.message));
  });

  async function pump() {
    const agent = ctx.agents.get(target);
    if (Date.now() - publishedAt >= 1500) {
      publishedAt = Date.now();
      store.publish('dsh', { at: publishedAt, sessionId: target, bindingCreatedAt: binding.createdAt,
        available: Boolean(agent), readyForObservation: agent?.status === 'idle', supportsTimestampedObservation: true, supportsAutonomousChoice: true, supportsObservationEvidence: true, supportsFreeTime: true, supportsDesktopDraft: true, supportsAgentAuthoredDraft: true });
    }
    if (pumping || !agent || agent.status !== 'idle') return;
    const item = store.waking();
    if (!item) return;
    if (item.free && (item.sessionId !== target || item.bindingCreatedAt !== binding.createdAt)) {
      store.mark(item.id);
      return;
    }
    if (!allowed(item.channel)) {
      const bridge = store.runtime('bridge');
      if (bridge?.sessionId === target && (bridge.bindingCreatedAt ?? 0) === binding.createdAt
        && Date.now() - bridge.at < 10_000 && Array.isArray(bridge.channels) && !bridge.channels.includes(item.channel)) store.mark(item.id);
      return;
    }
    pumping = true;
    try {
      const stillTarget = () => String(agent.id) === target && ctx.agents.get(target) === agent;
      if (initializedAgent !== agent) {
        await ctx.sessionPersistence.flush();
        await using handle = await ctx.sessionPersistence.open(agent.id, 'read');
        if (!stillTarget()) return;
        for (let offset = 0; ; ) {
          const { events } = await handle.read(offset, 512);
          if (!stillTarget()) return;
          if (!events.length) break;
          for (const event of events) {
            if (event.type !== 'user/message') continue;
            const id = String(event.data.id);
            if (id.startsWith(DRAFT_PREVIEW)) store.markContext(id);
            else if (id.startsWith(PREVIEW)) store.markContext(id.slice(PREVIEW.length));
            else if (id.startsWith('qq:')) store.mark(id);
          }
          offset += events.length;
        }
        initializedAgent = agent;
      }
      if (!stillTarget()) return;
      const next = store.waking();
      if (next?.opportunity && (Date.now() >= (next.expiresAt ?? next.at + 10 * 60_000) ||
        (next.observationSource != null && (contextBudgetChars === 0 || !observationContext(next).length)))) {
        store.mark(next.id);
        return;
      }
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
