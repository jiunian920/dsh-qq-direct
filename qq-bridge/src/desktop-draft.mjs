import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SENSITIVE_RE } from './sensitive.js';

const publicDatabase = path.join(process.env.AI_MEMORY_ROOT || fileURLToPath(new URL('../../memory-app/', import.meta.url)), '数据', '岸岸群聊公开记忆', '原文.sqlite3');
export const desktopDraftKinds = Object.freeze(['ack', 'followup', 'empathy', 'quote', 'public-note', 'sticker']);
export const desktopDraftLifetime = 75_000;
const GROUP = /^group:[1-9]\d*$/;
const MESSAGE_ID = /^-?[1-9]\d*$/;

const digest = value => createHash('sha256').update(value).digest('hex');
const shortText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96);

export function lookupApprovedDraftRecord(id, filename = publicDatabase) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  let database;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    database.exec('PRAGMA busy_timeout=150;');
    const actor = database.prepare("SELECT value FROM metadata WHERE key='actor'").get()?.value;
    if (actor !== 'anan_public') return null;
    const row = database.prepare("SELECT body FROM messages WHERE id=? AND kind='summary' AND "
      + "source GLOB 'approved-public:*' AND json_extract(refs,'$[0].audience')='public'").get(id);
    if (!row) return null;
    const line = row.body.split(/\r?\n/).map(x => x.trim()).find(x => x && !x.startsWith('#'));
    const excerpt = shortText(line);
    return excerpt ? { id, excerpt, digest: digest(row.body) } : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function groupSource(store, channel, messageId) {
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) throw new Error('清单里的群消息 ID 无效。');
  const item = store.find(channel, messageId);
  if (!item || item.channel !== channel || item.messageId !== messageId || item.opportunity
    || !/^[1-9]\d*$/.test(item.senderId)) throw new Error('材料清单里有一条消息不属于原群。');
  return item;
}

function checkText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请先写一条你想发的正文。');
  if ([...text].length > 240) throw new Error('草稿正文最多 240 字。');
  const canonical = text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(text) || /(?:https?:\/\/|www\.|\[cq:|file:\/\/)/i.test(canonical)) {
    throw new Error('草稿正文需要是单行文字，请去掉链接或消息控制段。');
  }
  if (SENSITIVE_RE.test(canonical)) throw new Error('草稿含有疑似本机路径或凭据，请删掉后再提交。');
}

const normalizedNote = text => String(text ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]/gu, '');

export function assertDesktopDraftPrivacy(text, approvedTexts, privateTexts) {
  if (!text) return;
  const chunks = [];
  const normalized = normalizedNote(text);
  const body = [...normalized];
  for (let start = 0; start + 10 <= body.length; start++) chunks.push(body.slice(start, start + 10).join(''));
  const allowed = approvedTexts.filter(Boolean).map(normalizedNote);
  for (const original of privateTexts) {
    const item = normalizedNote(original);
    const excerpts = item.length >= 6 && item.length < 10 && normalized.includes(item) ? [item] : chunks;
    if (excerpts.some(excerpt => item.includes(excerpt) && !allowed.some(value => value.includes(excerpt)))) {
      throw new Error('草稿与已知私聊或桌面私人资料重合，请换个说法或删掉这段。');
    }
  }
}

export function privateDraftTexts(store, channel) {
  if (!channel) return [];
  return store.recentMessages(channel, 128, 0).flatMap(item => [item.text, item.quote?.text])
    .filter(text => typeof text === 'string' && text).map(text => text.slice(0, 8000));
}

export function compileDesktopDraft(store, request, lookup = lookupApprovedDraftRecord) {
  const { channel, messageId, kind, publicId, stickerId, text } = request;
  if (Object.keys(request).some(key => !['channel', 'messageId', 'kind', 'publicId', 'stickerId', 'text', 'materials'].includes(key))
    || typeof channel !== 'string' || !GROUP.test(channel) || !desktopDraftKinds.includes(kind)
    || (publicId !== undefined && kind !== 'public-note') || (stickerId !== undefined && kind !== 'sticker')) {
    throw new Error('草稿参数无效，请核对原群、材料和回复方式。');
  }
  const original = groupSource(store, channel, messageId);
  const references = request.materials ?? (kind === 'sticker' ? [{ type: 'group', messageId }] : undefined);
  if (!Array.isArray(references) || !references.length || references.length > 6) throw new Error('请列出 1 到 6 条材料。');
  const materials = [];
  const excerpts = [];
  const seen = new Set();
  for (const ref of references) {
    if (ref?.type === 'group' && Object.keys(ref).every(key => key === 'type' || key === 'messageId')) {
      const item = groupSource(store, channel, ref.messageId);
      const key = 'group:' + item.messageId;
      if (seen.has(key)) throw new Error('材料清单有重复项。');
      seen.add(key);
      materials.push({ type: 'group', channel, messageId: item.messageId, senderId: item.senderId,
        digest: digest(JSON.stringify([item.text, item.quote, item.media])) });
      excerpts.push(item.text);
    } else if (ref?.type === 'public' && Object.keys(ref).every(key => key === 'type' || key === 'id')) {
      const record = lookup(ref.id);
      if (!record) throw new Error('公开资料不存在或已撤回。');
      const key = 'public:' + record.id;
      if (seen.has(key)) throw new Error('材料清单有重复项。');
      seen.add(key);
      materials.push({ type: 'public', id: record.id, digest: record.digest });
      excerpts.push(record.excerpt);
    } else throw new Error('材料只能引用原群消息 ID 或已批准的公开资料 ID。');
  }
  if (!seen.has('group:' + messageId)) throw new Error('材料清单必须包含回复所指向的原消息。');
  const payload = { format: 'text', replyTo: messageId, toSender: original.senderId };
  if (kind === 'sticker') {
    if (text !== undefined || typeof stickerId !== 'string' || !/^[\w.-]{1,150}$/.test(stickerId)) throw new Error('单发表情仅接受合法的收藏表情编号。');
    payload.format = 'sticker';
    payload.stickerId = stickerId;
  } else {
    checkText(text);
    if (kind === 'public-note' && (!materials.some(item => item.type === 'public')
      || (publicId !== undefined && !seen.has('public:' + publicId)))) throw new Error('材料清单缺少正文使用的公开资料。');
    if (kind === 'quote') {
      const quotes = [...text.matchAll(/「([^」]+)」|“([^”]+)”/g)].map(match => match[1] ?? match[2]);
      if (!quotes.length || quotes.some(quote => !excerpts.some(source => source?.includes(quote)))) {
        throw new Error('正文的引用与已列出的材料对不上。');
      }
    }
    payload.text = text;
  }
  return { payload, materials, excerpts };
}

export function verifyDesktopDraft(store, job, lookup = lookupApprovedDraftRecord, privateTexts = []) {
  if (Object.keys(job).some(key => !['id', 'channel', 'draftId', 'sessionId', 'bindingCreatedAt', 'expires', 'trigger'].includes(key))) {
    throw new Error('草稿发件箱包含未经批准的字段。');
  }
  const draft = store.desktopDraft(job.draftId);
  if (!draft || job.id !== draft.id || draft.request.channel !== job.channel ||
    draft.sessionId !== job.sessionId || draft.bindingCreatedAt !== job.bindingCreatedAt ||
    draft.expires !== job.expires || Date.now() >= draft.expires ||
    job.trigger !== `qq:${draft.request.channel}:${draft.request.messageId}`) {
    throw new Error('桌面草稿与目标群、主会话或有效期不匹配。');
  }
  const rebuilt = compileDesktopDraft(store, draft.request, lookup);
  if (JSON.stringify(rebuilt.materials) !== JSON.stringify(draft.materials) ||
    JSON.stringify(rebuilt.payload) !== JSON.stringify(draft.payload)) {
    throw new Error('桌面草稿的材料已变化，发送已取消。');
  }
  assertDesktopDraftPrivacy(rebuilt.payload.text, rebuilt.excerpts, privateTexts);
  return rebuilt.payload;
}