import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkedMediaPath } from './direct-permissions.js';
import { messageBelongsToChannel } from './message-media.js';
import { safeFetchBinary } from './safe-fetch.js';

export async function saveQQMedia({ key, messageId, savePath, token }, { directory, authorizeRead, onebot, download = safeFetchBinary }) {
  const scope = /^(group|private):([1-9]\d*)$/.exec(key);
  if (!scope || !/^-?[1-9]\d*$/.test(String(messageId))) throw new Error('渠道或消息 ID 无效。');
  await authorizeRead(key, token);
  const raw = await onebot('get_msg', { message_id: String(messageId) });
  let sameChannel = messageBelongsToChannel(raw, scope[1], scope[2]);
  if (!sameChannel && scope[1] === 'private') {
    const login = await onebot('get_login_info');
    sameChannel = messageBelongsToChannel(raw, scope[1], scope[2], login?.user_id);
  }
  if (!sameChannel) throw new Error('消息不属于当前 QQ 渠道。');
  const part = (Array.isArray(raw.message) ? raw.message : []).find(item => ['file', 'image', 'video', 'record'].includes(item?.type));
  const ref = part?.data?.url || part?.data?.file || part?.data?.file_id;
  if (!ref) throw new Error('这条消息没有可下载的附件。');
  let url = String(ref);
  if (!/^https?:\/\//i.test(url)) {
    if (!/^[\w.+=@-]{1,512}$/.test(url) || url.includes('..')) throw new Error('附件引用无效。');
    const info = await onebot('get_file', { file: url });
    url = String(info?.url || info?.file || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('网关未提供可安全下载的地址。');
  }
  const name = String(part.data?.name || part.data?.file || 'attachment').split(/[\\/]/).pop()
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80).replace(/[. ]+$/, '');
  const output = savePath ?? `qq-${randomUUID()}-${name || 'attachment'}`;
  checkedMediaPath(directory, output, { newFile: true });
  // ⭐ 2026-11-10 主人定：下载上限 32 MiB → 100 MiB（只有主人发起的回合能下载，风险可控）
  const { buffer } = await download(url, 100 * 1024 * 1024);
  const dest = checkedMediaPath(directory, output, { newFile: true });
  fs.writeFileSync(dest, buffer, { flag: 'wx' });
  return { dest, bytes: buffer.length };
}
