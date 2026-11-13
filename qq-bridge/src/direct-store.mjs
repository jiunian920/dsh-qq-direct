import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { attachmentFields } from './message-media.js';

const QQ_ID = /^-?[1-9]\d*$/;
const CHANNEL = /^(group|private):[1-9]\d*$/;

function cardText(parts) {
  // ⭐ 2026-11-08 卡片/XML/视频消息的文本提取（原来只取 text 段，卡片内容全丢）
  const out = [];
  for (const part of parts) {
    if (part?.type === 'json' && part.data?.data) {
      try {
        const j = JSON.parse(String(part.data.data));
        const m = j?.meta || {};
        const d = m.news || m.detail_1 || m.music || m.video || m.audio || {};
        const title = [d.title, d.desc, d.summary].filter(Boolean).join(' / ');
        const url = d.qqdocurl || d.jumpUrl || d.url || '';
        if (title || url) out.push(`[卡片] ${title}${url ? ' ' + url : ''}`.trim());
      } catch {}
    } else if (part?.type === 'xml' && part.data?.data) {
      const s = String(part.data.data).replace(/&amp;/g, '&');
      const title = (s.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      const url = (s.match(/<url>([^<]*)<\/url>/i) || [])[1] || '';
      if (title || url) out.push(`[卡片/XML] ${title}${url ? ' ' + url : ''}`.trim());
    } else if (part?.type === 'video' && (part.data?.url || part.data?.file)) {
      out.push(`[视频] ${part.data.url || part.data.file}`);
    }
  }
  return out.join('\n');
}

export function directEvent(channel, event, text, quote, wake, hints = '') {
  const messageId = String(event.message_id ?? event.msg_id ?? '');
  const senderId = String(event.user_id ?? '');
  if (!CHANNEL.test(channel) || !QQ_ID.test(messageId) || !/^[1-9]\d*$/.test(senderId)) return null;
  const parts = Array.isArray(event.message) ? event.message : [];
  const card = cardText(parts);
  return {
    id: `qq:${channel}:${messageId}`, channel, messageId, senderId,
    sender: String(event.sender?.card || event.sender?.nickname || senderId),
    at: Number(event.time) > 0 ? Number(event.time) * 1000 : Date.now(),
    text: card ? `${text}\n${card}` : text, quote, wake: Boolean(wake), hints,
    mentions: parts.filter(part => part?.type === 'at').map(part => String(part.data?.qq ?? '')),
    ...attachmentFields(parts),
    media: parts.filter(part => ['image', 'record', 'video', 'file', 'forward', 'face'].includes(part?.type))
      .map(part => {
        const ref = String(part.data?.file_id ?? part.data?.id ?? part.data?.file ?? '');
        return { type: part.type, ref: ref.length <= 512 && !/^base64:\/\//i.test(ref) ? ref : '' };
      }),
  };
}

export function replyTarget(channel, selected, { replyTo, toSender, mention = false, atUserId } = {}) {
  // 2026-11-12：支持「只 @ 指定的人、不引用」。
  // 原来 atUserId 根本不在解构里 —— 插件传进来会被直接丢掉（消息发得出去，但没有 @ 段）；
  // 而 mention 也必须配着引用才不抛错。
  const wantAt = atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '';
  if (!replyTo && !toSender && !mention && !wantAt) return {};
  if (replyTo || toSender) {
    if (!selected || selected.channel !== channel || selected.messageId !== replyTo || selected.senderId !== toSender) {
      throw new Error('说话人与原消息对不上。请重新核对原句和发送者 ID。');
    }
  }
  let at = null;
  if (channel.startsWith('group:')) {
    if (wantAt) at = String(atUserId).trim();
    else if (mention && selected) at = selected.senderId;
  }
  return { replyToMessageId: replyTo || null, atUserId: at };
}

export function directSessionBinding(store, configuredSessionId) {
  const saved = store.runtime('session-binding');
  if (saved?.configuredSessionId !== configuredSessionId) return { sessionId: configuredSessionId, createdAt: 0 };
  if (typeof saved.sessionId !== 'string' || !/^session-[\w-]+$/.test(saved.sessionId)
    || !Number.isSafeInteger(saved.createdAt) || saved.createdAt <= 0) {
    throw new Error('QQ 直连的主会话绑定无效，请核对账本。');
  }
  return saved;
}

export function openDirectStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA busy_timeout=2500; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS input (
      seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, channel TEXT NOT NULL,
      wake INTEGER NOT NULL, payload TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS input_pending ON input(consumed, seq);
    CREATE INDEX IF NOT EXISTS input_channel_seq ON input(channel, seq);
    CREATE TABLE IF NOT EXISTS outgoing (
      seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, channel TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', result TEXT);
    CREATE TABLE IF NOT EXISTS revisit (
      channel TEXT PRIMARY KEY, due INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime (
      name TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS context_seen (id TEXT PRIMARY KEY);`);
  const put = db.prepare('INSERT OR IGNORE INTO input(id,channel,wake,payload) VALUES (?,?,?,?)');
  const find = db.prepare('SELECT payload FROM input WHERE id=?');
  const pending = db.prepare('SELECT payload FROM input WHERE consumed=0 ORDER BY seq LIMIT ?');
  const waking = db.prepare(`SELECT payload FROM input WHERE consumed=0 AND wake=1
    ORDER BY CASE json_extract(payload, '$.wakeClass') WHEN 'direct' THEN 0 WHEN 'continuation' THEN 1 ELSE 2 END, seq LIMIT 1`);
  const byChannel = db.prepare('SELECT payload FROM input WHERE channel=? ORDER BY seq DESC LIMIT ?');
  const recentMessages = db.prepare(`SELECT payload FROM (
    SELECT payload, json_extract(payload, '$.at') AS at, seq FROM input
      WHERE channel=? AND json_extract(payload, '$.opportunity') IS NULL
    UNION ALL SELECT json_set(result, '$.sender', '岸岸', '$.isSelf', json('true')), json_extract(result, '$.at'), seq FROM outgoing
      WHERE channel=? AND state='sent' AND result IS NOT NULL
    ) ORDER BY at DESC, seq DESC LIMIT ? OFFSET ?`);
  const unreadMessages = db.prepare(`SELECT payload FROM input WHERE channel=? AND consumed=0
    AND json_extract(payload, '$.opportunity') IS NULL ORDER BY seq DESC LIMIT ?`);
  const contextCandidates = db.prepare(`SELECT payload FROM input
    WHERE channel=? AND consumed=0 AND json_extract(payload, '$.opportunity') IS NULL
      AND json_extract(payload, '$.at') >= ?
      AND (wake=0 OR (? AND NOT EXISTS (SELECT 1 FROM context_seen WHERE context_seen.id=input.id)))
    ORDER BY seq DESC LIMIT ?`);
  const unreadCount = db.prepare(`SELECT count(*) AS total FROM input WHERE channel=? AND consumed=0
    AND json_extract(payload, '$.opportunity') IS NULL`);
  const seenForward = db.prepare(`SELECT 1 FROM input WHERE channel=? AND (
    EXISTS (SELECT 1 FROM json_each(payload, '$.forwardIds') WHERE value=?) OR
    EXISTS (SELECT 1 FROM json_each(payload, '$.media') WHERE json_extract(value, '$.type')='forward' AND json_extract(value, '$.ref')=?)
    ) LIMIT 1`);
  const mark = db.prepare('UPDATE input SET consumed=1 WHERE id=?');
  const putSend = db.prepare('INSERT OR IGNORE INTO outgoing(id,channel,payload) VALUES (?,?,?)');
  const nextSend = db.prepare("UPDATE outgoing SET state='sending' WHERE seq=(SELECT seq FROM outgoing WHERE state='pending' ORDER BY seq LIMIT 1) RETURNING id, channel, payload");
  const readSend = db.prepare('SELECT state,result FROM outgoing WHERE id=?');
  const finish = db.prepare("UPDATE outgoing SET state=?,result=? WHERE id=? AND state='sending'");
  const cancel = db.prepare("UPDATE outgoing SET state='failed',result=? WHERE id=? AND state='pending'");
  const defer = db.prepare('INSERT INTO revisit VALUES (?,?) ON CONFLICT(channel) DO UPDATE SET due=excluded.due');
  const due = db.prepare('SELECT channel,due FROM revisit WHERE due<=? ORDER BY due LIMIT 1');
  const removeDue = db.prepare('DELETE FROM revisit WHERE channel=? AND due=?');
  const readRuntime = db.prepare('SELECT payload FROM runtime WHERE name=?');
  const writeRuntime = db.prepare('INSERT OR REPLACE INTO runtime VALUES (?,?)');
  const readContext = db.prepare('SELECT 1 FROM context_seen WHERE id=?');
  const markContext = db.prepare('INSERT OR IGNORE INTO context_seen VALUES (?)');
  const parse = row => row && JSON.parse(row.payload);
  return {
    close: () => db.close(),
    append: item => Boolean(put.run(item.id, item.channel, Number(item.wake), JSON.stringify(item)).changes),
    get: id => typeof id === 'string' && id.startsWith('qq:') ? parse(find.get(id)) : null,
    find: (channel, id) => parse(find.get(`qq:${channel}:${id}`)),
    pending: (limit = 50) => pending.all(limit).map(parse),
    waking: () => parse(waking.get()),
    recent: (channel, limit = 12) => byChannel.all(channel, limit).map(parse).reverse(),
    recentMessages: (channel, limit, offset) => recentMessages.all(channel, channel, limit, offset).map(parse).reverse(),
    unreadMessages: (channel, limit) => unreadMessages.all(channel, limit).map(parse).reverse(),
    contextCandidates: (channel, since, previews, limit) =>
      contextCandidates.all(channel, since, Number(previews), limit).map(parse),
    unreadCount: channel => unreadCount.get(channel).total,
    hasForward: (channel, id) => Boolean(seenForward.get(channel, id, id)),
    mark: id => mark.run(id),
    enqueue: (channel, payload, id = randomUUID()) => { putSend.run(id, channel, JSON.stringify(payload)); return id; },
    take: () => {
      const row = nextSend.get();
      return row && { id: row.id, channel: row.channel, ...parse(row) };
    },
    result: id => {
      const row = readSend.get(id);
      return row && { state: row.state, ...(row.result ? JSON.parse(row.result) : {}) };
    },
    finish: (id, state, result) => finish.run(state, JSON.stringify(result), id),
    cancel: id => cancel.run(JSON.stringify({ error: '原回合已取消。' }), id),
    recover: () => db.exec("UPDATE outgoing SET state='unknown' WHERE state='sending'"),
    defer: (channel, time) => defer.run(channel, time),
    due: now => due.get(now),
    removeDue: ({ channel, due: time }) => removeDue.run(channel, time),
    runtime: name => parse(readRuntime.get(name)),
    publish: (name, value) => writeRuntime.run(name, JSON.stringify(value)),
    sawContext: id => Boolean(readContext.get(id)),
    markContext: id => markContext.run(id),
  };
}
