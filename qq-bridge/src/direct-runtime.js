import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { directEvent, directSessionBinding, replyTarget } from './direct-store.mjs';
import { groupWake, observationEvidence, scheduledObservationEvidence } from './qq-wake.js';
import { SLANG_STATUS } from './slang-learner.js';
import { assertDirectSend, checkedMediaPath } from './direct-permissions.js';
import { privateDraftTexts, verifyDesktopDraft } from './desktop-draft.mjs';

export function createDirectRuntime({
  cfg, directStore, directAllowed, isPaused, ensureChannelState, slangEntries, exportsDir,
  stickerEntries, stickerEnabled, buildMemeHint, sharedQzonePolicy, redactSensitiveText,
  redactKnownTokensOnly, sendStickerV2, synthesizeVoiceToFile, voiceConfig,
  onebotSend, onebotSendSegments, randInt, log, schedule, archiveMemory, observationLogDir,
}) {
  const directWakeAt = new Map();
  let directMemoryDirty = true;
  const binding = () => directSessionBinding(directStore, cfg.directSession.sessionId);
  const automatic = cfg.directSession?.automaticObservation;
  const dailyLimit = Number.isSafeInteger(automatic?.maxPer24Hours) ? Math.max(0, Math.min(24, automatic.maxPer24Hours)) : 8;
  const cooldownMs = (Number.isSafeInteger(automatic?.cooldownMinutes) ? Math.max(5, Math.min(120, automatic.cooldownMinutes)) : 20) * 60_000;
  const observationStatsKey = 'automatic-observation-stats';
  const minute = 60_000;
  const day = 24 * 60 * minute;
  const freeLimit = Number.isSafeInteger(automatic?.freePer24Hours) ? Math.max(0, Math.min(4, automatic.freePer24Hours)) : 0;
  const topics = (Array.isArray(automatic?.topics) ? automatic.topics : ['方舟', '崩铁', '猫咪', '手机', '编程', '音乐'])
    .filter(topic => typeof topic === 'string' && topic.trim().length >= 2)
    .slice(0, 12).map(topic => topic.trim().normalize('NFKC').toLowerCase().slice(0, 24));
  const observationStats = () => {
    const saved = directStore.runtime(observationStatsKey) ?? {};
    return { ...saved, bySource: saved.bySource ?? { scheduled: {}, activity: {} } };
  };

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
      sender: String(event.user_id), recent: directStore.recent(key, 8), lastWake: directWakeAt.get(key), addressed: directMention, topics });
    const wake = !isPaused() && (wakeClass === 'direct' || wakeClass === 'continuation');
    const context = [body, quote?.text].filter(Boolean).join('\n');
    const hints = wake ? [buildMemeHint(context), directSlangHint(key, context), directStickerHint(context)].filter(Boolean).join('\n') : '';
    const item = directEvent(key, event, redactSensitiveText(body), quote, wake, hints);
    if (item && wake) item.wakeClass = wakeClass;
    if (item && appendDirect(item)) {
      if (wake && wakeClass !== 'continuation') directWakeAt.set(key, Date.now());
      ensureChannelState(key);
      if (wakeClass === 'opportunity' && !isPaused()) automaticObservation('activity', [key], item.id);
    }
  }

  function directSlangHint(key, text) {
    if (cfg.slang?.enabled === false) return '';
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

  function logObservation(source, result, at) {
    if (!observationLogDir) return;
    const beijingDate = new Date(at + 8 * 60 * minute).toISOString().slice(0, 10);
    try {
      fs.mkdirSync(observationLogDir, { recursive: true });
      fs.appendFileSync(path.join(observationLogDir, beijingDate + '.jsonl'),
        JSON.stringify({ at, source, result }) + '\n', 'utf8');
    } catch (error) {
      log?.('[qq-direct] 主动检查日志写入失败:', error.code ?? 'write-failed');
    }
  }

  function automaticObservation(source, channels, focusId, now = Date.now(), since = now - 20 * minute) {
    const record = reason => {
      const stats = observationStats();
      const key = reason === 'queued' ? source : reason;
      const sourceCounts = stats.bySource[source];
      const bySource = { ...stats.bySource, [source]: { ...sourceCounts, [reason]: (sourceCounts[reason] ?? 0) + 1 } };
      directStore.publish(observationStatsKey, { ...stats, [key]: (stats[key] ?? 0) + 1,
        bySource, lastAt: now, lastResult: key, lastSource: source });
      logObservation(source, reason, now);
      return reason;
    };
    if (dailyLimit === 0) return record('disabled');
    if (isPaused()) return record('paused');
    const active = binding();
    const host = directStore.runtime('dsh');
    if (!host?.available || !host.supportsObservationEvidence || host.sessionId !== active.sessionId
      || (host.bindingCreatedAt ?? 0) !== active.createdAt
      || !Number.isFinite(host.at) || now - host.at >= 10_000) return record('unavailable');
    const recent = directStore.observationBudget(dailyLimit);
    if (recent.some(item => !item.consumed && item.expiresAt > now)) return record('pending');
    if (recent[0] && now - recent[0].at < cooldownMs) return record('cooldown');
    if (recent.length >= dailyLimit && now - recent.at(-1).at < 24 * 60 * 60_000) return record('dailyCap');
    const candidates = channels.filter(channel => channel.startsWith('group:') && directAllowed(channel))
      .map(channel => {
        const rows = directStore.observationCandidates(channel, since);
        const evidence = source === 'scheduled' ? scheduledObservationEvidence(rows, topics) : observationEvidence(rows, focusId, topics);
        return { channel, evidence };
      })
      .filter(candidate => candidate.evidence.length);
    if (!candidates.length) return record('quiet');
    const { channel, evidence } = candidates[randInt(0, candidates.length - 1)];
    const context = evidence.map(item => item.text ?? '').join('\n');
    const id = `qq:check:auto:${crypto.randomUUID()}`;
    directStore.append({ id, channel, at: now, wake: true, opportunity: true, wakeClass: 'opportunity',
      expiresAt: now + 4 * 60_000, observationSource: source, evidenceIds: evidence.map(item => item.id), focusId, topics,
      hints: [buildMemeHint(context), directSlangHint(channel, context), directStickerHint(context)].filter(Boolean).join('\n') });
    return record('queued');
  }

  function freeTime(now) {
    if (!freeLimit || isPaused() || directStore.waking()) return;
    const host = directStore.runtime('dsh');
    const active = binding();
    const channel = `private:${cfg.ownerQQ}`;
    if (!host?.available || !host.supportsFreeTime || host.sessionId !== active.sessionId
      || (host.bindingCreatedAt ?? 0) !== active.createdAt || now - host.at >= 10_000 || !directAllowed(channel)) return;
    const recent = directStore.recentFreeTime(freeLimit);
    if (recent.length >= freeLimit && now - recent.at(-1).at < day) return;
    const id = `qq:free:${crypto.randomUUID()}`;
    directStore.append({ id, channel, at: now, wake: true, opportunity: true, free: true,
      expiresAt: now + 4 * minute, sessionId: active.sessionId, bindingCreatedAt: active.createdAt });
    logObservation('free', 'queued', now);
  }

  async function directQzoneOpportunity() {
    const channel = `private:${cfg.ownerQQ}`;
    const host = directStore.runtime('dsh');
    if (!directAllowed(channel) || isPaused()
      || cfg.socialV2?.tools?.selfAccount === false || host?.sessionId !== binding().sessionId
      || !host.available || Date.now() - host.at >= 10_000) return;
    ensureChannelState(channel);
    await sharedQzonePolicy.opportunity(channel, cfg, ({ id, expiresAt, hint }) => {
      if (!directAllowed(channel) || isPaused()) return false;
      return directStore.append({ id: `qq:qzone:${id}`, channel, at: Date.now(), wake: true, wakeClass: 'opportunity',
        opportunity: true, qzone: true, expiresAt, hints: hint });
    });
  }

  async function sendDirect() {
    const queued = directStore.take();
    if (!queued) return;
    const fromDraft = queued.draftId !== undefined;
    let job = queued;
    let mayHaveSent = false;
    try {
      const verify = () => {
        const active = binding();
        if (job.sessionId !== active.sessionId || (job.bindingCreatedAt != null && job.bindingCreatedAt !== active.createdAt)) {
          throw new Error('发送请求与当前主会话绑定不匹配。');
        }
        if (job.bindingCreatedAt != null) {
          const host = directStore.runtime('dsh');
          if (!host?.available || host.sessionId !== active.sessionId || host.bindingCreatedAt !== active.createdAt
            || Date.now() - host.at >= 10_000) throw new Error('DSH 主会话暂不可用。');
        }
        if (!directAllowed(job.channel) || isPaused() || job.expires < Date.now()) {
          throw new Error('当前 QQ 回合已过期或暂停。');
        }
      };
      verify();
      const verifiedDraft = () => verifyDesktopDraft(directStore, queued, undefined,
        privateDraftTexts(directStore, `private:${cfg.ownerQQ}`));
      if (fromDraft) {
        if (!directStore.runtime('dsh')?.supportsAgentAuthoredDraft) throw new Error('桌面草稿入口尚未就绪。');
        job = { ...queued, ...verifiedDraft() };
      }
      const verifyTransport = () => {
        verify();
        if (fromDraft) verifiedDraft();
      };
      const trigger = directStore.get(job.trigger);
      // ⭐ 2026-11-08 跨渠道：主人私聊 ↔ 白名单群 可以互相发；别的渠道不许
      const crossAllowed = [`private:${cfg.ownerQQ}`, ...cfg.allow.groups.map(id => `group:${id}`)];
      if ((!fromDraft && !trigger?.wake) || !trigger
        || !directAllowed(trigger.channel)
        || (trigger.channel !== job.channel && !crossAllowed.includes(job.channel))) {
        throw new Error('发送请求与主会话或原 QQ 渠道不匹配。');
      }
      if (!fromDraft) assertDirectSend(trigger, job.channel, job.format, cfg.ownerQQ);
      const [kind, id] = job.channel.split(':');
      const selected = job.replyTo ? directStore.find(job.channel, job.replyTo) : null;
      const targetReply = replyTarget(job.channel, selected, job);
      const replyToMessageId = fromDraft && !directStore.hasInterveningSpeaker(job.channel, job.replyTo, job.toSender)
        ? null : targetReply.replyToMessageId;
      const { atUserId } = targetReply;
      // 2026-11-13 00:06 改：**群聊不再强制「引用或面向全群」**。
      //   原先是 2026-11-08 加的：群里发话必须 replyTo 或 broadcast，否则拒发。
      //   问题是这个措辞（broadcast =「面向全群」）把人误导成「那是喊话，引用才像聊天」，
      //   结果养成「每句都挂 replyToCurrent」的毛病（主人今天点了三次）。
      //   渠道本身已经绑定在 job.channel 上，裸发不会发错地方，这条硬闸没有必要。
      //   `broadcast: true` 仍然接受（向后兼容），但不再是必填。
      const body = fromDraft ? (job.text ?? '') : String(job.text ?? '').trim();
      if (body && (redactKnownTokensOnly(body) !== body || redactSensitiveText(body) !== body)) throw new Error('消息含疑似凭据。');
      let data;
      let output = { format: job.format, text: body, replyTo: replyToMessageId ?? null };
      if (job.format === 'sticker') {
        if (!stickerEnabled() || cfg.socialV2?.tools?.sendSticker === false || !job.stickerId) throw new Error('没有可用的收藏表情。');
        // ⭐ 2026-11-08 表情不带引用（引用会占很大一块地方，主人要求）
        const sent = await sendStickerV2(job.channel, job.stickerId, {
          assertDirectAllowed: verifyTransport, onTransportStart: () => { mayHaveSent = true; }
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
        if (job.format !== 'text' || !body.trim() || body.length > 500) throw new Error('文字长度无效。');
        verifyTransport();
        mayHaveSent = true;
        data = await onebotSend(kind, id, body, replyToMessageId, atUserId);
      }
      const sentAt = Date.now();
      directStore.finish(job.id, 'sent', { ...output, messageId: data?.message_id ?? null, at: sentAt });
      if (trigger.observationSource != null && trigger.channel === job.channel) directWakeAt.set(job.channel, sentAt);
    } catch (error) {
      const state = mayHaveSent && !error?.definitive ? 'unknown' : 'failed';
      const detail = redactSensitiveText(error?.message ?? String(error)).slice(0, 240);
      directStore.finish(job.id, state, { error: detail });
      log?.(`[qq-direct] 发送未确认 (${job.channel}, ${state}):`, detail);
    } finally {
      directMemoryDirty = true;
    }
  }

  function start() {
    if (!directStore) return;
    if (!directStore.runtime(observationStatsKey)?.bySource) {
      directStore.publish(observationStatsKey, observationStats());
    }
    directStore.recover();
    schedule(() => { void directQzoneOpportunity().catch(() => log('[qq-direct] 动态资料暂不可用，稍后复查')); }, 60_000).unref();
    let sending = false;
    let archiving = false;
    let nextCheck = Date.now() + randInt(20, 50) * minute;
    let lastCheck = directStore.runtime('automatic-observation-last-check')?.at ?? Date.now() - 20 * minute;
    let lastHeartbeat = 0;
    schedule(() => {
      const now = Date.now();
      if (now - lastHeartbeat >= 1500) {
        const channels = [`private:${cfg.ownerQQ}`, ...cfg.allow.groups.map(id => `group:${id}`)].filter(directAllowed);
        const active = binding();
        directStore.publish('bridge', { at: now, sessionId: active.sessionId, bindingCreatedAt: active.createdAt,
          channels, paused: isPaused(), supportsObservationEvidence: true, supportsFreeTime: true, supportsDesktopDraft: true, supportsAgentAuthoredDraft: true });
        lastHeartbeat = now;
      }
      const revisit = directStore.due(now);
      if (revisit) {
        directStore.removeDue(revisit);
        if (now - revisit.due < 10 * 60_000) directOpportunity(revisit.channel);
      }
      if (now >= nextCheck) {
        nextCheck = now + randInt(20, 50) * minute;
        const since = Math.min(now - 20 * minute, Math.max(lastCheck, now - 120 * minute));
        lastCheck = now;
        directStore.publish('automatic-observation-last-check', { at: lastCheck });
        if (cfg.allow.groups.length) {
          const result = automaticObservation('scheduled', cfg.allow.groups.map(id => `group:${id}`), undefined, now, since);
          if (result === 'quiet') freeTime(now);
        }
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
