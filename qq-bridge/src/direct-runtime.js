import crypto from 'node:crypto';
import { directEvent, directSessionBinding, replyTarget } from './direct-store.mjs';
import { groupWake } from './qq-wake.js';
import { SLANG_STATUS } from './slang-learner.js';
import { assertDirectSend, checkedMediaPath } from './direct-permissions.js';

export function createDirectRuntime({
  cfg, directStore, directAllowed, isPaused, ensureChannelState, slangEntries, exportsDir,
  stickerEntries, stickerEnabled, buildMemeHint, sharedQzonePolicy, redactSensitiveText,
  redactKnownTokensOnly, sendStickerV2, synthesizeVoiceToFile, voiceConfig,
  onebotSend, onebotSendSegments, randInt, log, schedule, archiveMemory,
}) {
  const directWakeAt = new Map();
  let directMemoryDirty = true;
  const sessionId = () => directSessionBinding(directStore, cfg.directSession.sessionId).sessionId;

  function appendDirect(item) {
    const inserted = directStore.append(item);
    if (inserted) directMemoryDirty = true;
    return inserted;
  }

  async function receiveDirect(key, kind, id, event, body, resolveReply) {
    if (!directAllowed(key) || String(event.user_id) === String(event.self_id)) return;
    const segments = Array.isArray(event.message) ? event.message : [];
    const reply = segments.find(part => part.type === 'reply');
    const original = reply?.data?.id != null ? await resolveReply(String(reply.data.id)) : null;
    const quote = reply?.data?.id != null ? { messageId: String(reply.data.id), senderId: original?.userId ?? null,
      sender: original?.sender ?? null, text: original ? redactSensitiveText(original.text) : null } : null;
    const directMention = segments.some(part => part.type === 'at' && String(part.data?.qq) === String(event.self_id))
      || quote?.senderId === String(event.self_id) || /岸岸|岸鲸/.test(body);
    const wakeClass = kind === 'private' ? 'direct' : groupWake({ text: body, replyTo: quote?.messageId,
      sender: String(event.user_id), recent: directStore.recent(key, 8), lastWake: directWakeAt.get(key), addressed: directMention });
    const wake = !isPaused() && Boolean(wakeClass);
    const context = [body, quote?.text].filter(Boolean).join('\n');
    const hints = wake ? [buildMemeHint(context), directSlangHint(key, context), directStickerHint(context)].filter(Boolean).join('\n') : '';
    const item = directEvent(key, event, redactSensitiveText(body), quote, wake, hints);
    if (item && wake) item.wakeClass = wakeClass;
    if (item && appendDirect(item)) {
      if (wake && wakeClass !== 'continuation') directWakeAt.set(key, Date.now());
      ensureChannelState(key);
    }
  }

  function directSlangHint(key, text) {
    const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
    const sentence = normalize(text);
    const known = slangEntries().filter(entry => entry.status === SLANG_STATUS.CONFIRMED && entry.meaning
      && (!entry.sources.length || entry.sources.includes(key)) && normalize(entry.content).length >= 2
      && sentence.includes(normalize(entry.content))).slice(0, 3);
    return known.map(entry => `本群或已确认梗「${entry.content}」：${entry.meaning} ${entry.example || entry.usage}`).join('\n');
  }

  function directStickerHint(text) {
    if (!stickerEnabled() || cfg.socialV2?.tools?.sendSticker === false) return '';
    const needle = text.toLowerCase();
    const candidates = stickerEntries().filter(entry => entry.url).map(entry => ({ entry,
      score: [...entry.tags, entry.desc, entry.localNote].filter(label => label?.length >= 2 && needle.includes(label.toLowerCase())).length }))
      .sort((a, b) => b.score - a.score || Number(b.entry.useCount ?? 0) - Number(a.entry.useCount ?? 0)).slice(0, 5);
    return candidates.length ? `可用收藏表情（可以单发）：${candidates.map(({ entry }) => `${entry.id} ${entry.desc || entry.localNote || entry.tags.join('/')}`).join('；')}` : '';
  }

  function directOpportunity(channel) {
    if (!directAllowed(channel) || isPaused()) return;
    directStore.append({ id: `qq:check:${crypto.randomUUID()}`, channel, at: Date.now(), wake: true, opportunity: true, wakeClass: 'opportunity',
      hints: directStickerHint(directStore.recent(channel, 4).map(item => item.text ?? '').join('\n')) });
  }

  async function directQzoneOpportunity() {
    const channel = `private:${cfg.ownerQQ}`;
    const host = directStore.runtime('dsh');
    if (!directAllowed(channel) || isPaused()
      || cfg.socialV2?.tools?.selfAccount === false || host?.sessionId !== sessionId()
      || !host.available || Date.now() - host.at >= 10_000) return;
    ensureChannelState(channel);
    await sharedQzonePolicy.opportunity(channel, cfg, ({ id, expiresAt, hint }) => {
      if (!directAllowed(channel) || isPaused()) return false;
      return directStore.append({ id: `qq:qzone:${id}`, channel, at: Date.now(), wake: true, wakeClass: 'opportunity',
        opportunity: true, qzone: true, expiresAt, hints: hint });
    });
  }

  async function sendDirect() {
    const job = directStore.take();
    if (!job) return;
    let mayHaveSent = false;
    try {
      const verify = () => {
        if (!directAllowed(job.channel) || isPaused() || job.expires < Date.now()) {
          throw new Error('当前 QQ 回合已过期或暂停。');
        }
        if (job.sessionId !== sessionId()) throw new Error('发送请求与主会话不匹配。');
      };
      verify();
      const trigger = directStore.get(job.trigger);
      // ⭐ 2026-11-08 跨渠道：主人私聊 ↔ 白名单群 可以互相发；别的渠道不许
      const crossAllowed = [`private:${cfg.ownerQQ}`, ...cfg.allow.groups.map(id => `group:${id}`)];
      if (!trigger?.wake
        || !directAllowed(trigger.channel)
        || (trigger.channel !== job.channel && !crossAllowed.includes(job.channel))) {
        throw new Error('发送请求与主会话或原 QQ 渠道不匹配。');
      }
      assertDirectSend(trigger, job.channel, job.format, cfg.ownerQQ);
      const [kind, id] = job.channel.split(':');
      const selected = job.replyTo ? directStore.find(job.channel, job.replyTo) : null;
      const { replyToMessageId, atUserId } = replyTarget(job.channel, selected, job);
      // ⭐ 2026-11-08 语音（会乱码）、表情（占地方）、图片都不带引用，群聊校验对它们豁免
      if (kind === 'group' && !replyToMessageId && job.broadcast !== true && job.format !== 'voice' && job.format !== 'sticker' && job.format !== 'image') throw new Error('请核对原消息和发送者，或明确选择面向全群。');
      const body = String(job.text ?? '').trim();
      if (body && (redactKnownTokensOnly(body) !== body || redactSensitiveText(body) !== body)) throw new Error('消息含疑似凭据。');
      let data;
      let output = { format: job.format, text: body, replyTo: replyToMessageId ?? null };
      if (job.format === 'sticker') {
        if (!stickerEnabled() || cfg.socialV2?.tools?.sendSticker === false || !job.stickerId) throw new Error('没有可用的收藏表情。');
        // ⭐ 2026-11-08 表情不带引用（引用会占很大一块地方，主人要求）
        const sent = await sendStickerV2(job.channel, job.stickerId, {
          assertDirectAllowed: verify, onTransportStart: () => { mayHaveSent = true; }
        });
        data = { message_id: sent.messageId };
        output = { ...output, text: `[表情包:${sent.entry?.desc || sent.entry?.localNote || '收藏表情'}]`, stickerId: job.stickerId };
      } else if (job.format === 'voice') {
        if (cfg.socialV2?.tools?.sendVoice === false || !body || body.length > 300) throw new Error('语音不可用或文字长度无效。');
        const audio = await synthesizeVoiceToFile(body, voiceConfig().timeoutMs, job.mood);
        verify();
        // ⭐ 2026-11-08 语音不带 reply/at：QQ 语音消息附带引用会显示成乱码（主人反馈）
        const parts = [{ type: 'record', data: { file: 'file:///' + audio.replace(/\\/g, '/') } }];
        mayHaveSent = true;
        data = await onebotSendSegments(kind, id, parts);
        output.audio = audio;
      } else if (job.format === 'image') {
        // ⭐ 2026-11-08 发本地图片（只允许图片扩展名，防误发任意文件）
        const p = String(job.imagePath ?? '').trim();
        if (!p || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(p)) throw new Error('图片路径无效，或不是图片格式（png/jpg/gif/webp/bmp）。');
        const abs = checkedMediaPath(exportsDir, p);
        verify();
        const parts = [{ type: 'image', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }];
        mayHaveSent = true;
        data = await onebotSendSegments(kind, id, parts);
        output.image = abs;
      } else if (job.format === 'file') {
        // ⭐ 2026-11-08 发任意本地文件（主人要求）；凭据/密钥类一律拒发（红线：不外发凭据）
        const p = String(job.filePath ?? '').trim();
        if (!p) throw new Error('文件路径为空。');
        const abs = checkedMediaPath(exportsDir, p);
        verify();
        const parts = [{ type: 'file', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }];
        mayHaveSent = true;
        data = await onebotSendSegments(kind, id, parts);
        output.file = abs;
      } else {
        if (job.format !== 'text' || !body || body.length > 500) throw new Error('文字长度无效。');
        verify();
        mayHaveSent = true;
        data = await onebotSend(kind, id, body, replyToMessageId, atUserId);
      }
      directStore.finish(job.id, 'sent', { ...output, messageId: data?.message_id ?? null, at: Date.now() });
    } catch (error) {
      directStore.finish(job.id, mayHaveSent && !error.definitive ? 'unknown' : 'failed', { error: String(error.message).slice(0, 160) });
    } finally {
      directMemoryDirty = true;
    }
  }

  function start() {
    if (!directStore) return;
    directStore.recover();
    schedule(() => { void directQzoneOpportunity().catch(() => log('[qq-direct] 动态资料暂不可用，稍后复查')); }, 60_000).unref();
    let sending = false;
    let archiving = false;
    let nextCheck = Date.now() + randInt(20, 100) * 60_000;
    let lastHeartbeat = 0;
    schedule(() => {
      const now = Date.now();
      if (now - lastHeartbeat >= 1500) {
        const channels = [`private:${cfg.ownerQQ}`, ...cfg.allow.groups.map(id => `group:${id}`)].filter(directAllowed);
        directStore.publish('bridge', { at: now, sessionId: sessionId(),
          channels, paused: isPaused() });
        lastHeartbeat = now;
      }
      const revisit = directStore.due(now);
      if (revisit) {
        directStore.removeDue(revisit);
        if (now - revisit.due < 10 * 60_000) directOpportunity(revisit.channel);
      }
      if (now >= nextCheck) {
        nextCheck = now + randInt(20, 100) * 60_000;
        const groups = cfg.allow.groups;
        if (groups.length) directOpportunity(`group:${groups[randInt(0, groups.length - 1)]}`);
      }
      if (!sending) {
        sending = true;
        void sendDirect().catch(error => log('[qq-direct] 发送处理失败:', error.message)).finally(() => { sending = false; });
      }
    }, 500).unref();
    schedule(() => {
      if (archiving || !directMemoryDirty) return;
      archiving = true;
      directMemoryDirty = false;
      archiveMemory(error => {
          archiving = false;
          if (error) {
            directMemoryDirty = true;
            log('[qq-direct] 记忆增量写入暂未完成，将重试');
          }
      });
    }, 5000).unref();
  }

  return { start, receiveDirect, sendDirect, directQzoneOpportunity, appendDirect };
}
