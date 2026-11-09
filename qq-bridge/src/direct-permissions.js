import fs from 'node:fs';
import path from 'node:path';

export function assertDirectSend(origin, destination, format, ownerId) {
  if (!origin?.channel || origin.qzone) throw new Error('当前回合不能发送 QQ 聊天消息。');
  const owner = ownerId != null && String(ownerId) !== '' && String(origin.senderId) === String(ownerId);
  if (!owner && (destination !== origin.channel || !['text', 'sticker', 'voice'].includes(format))) {
    throw new Error('只有主人发起的回合可以发送本地图片、文件或跨渠道发言。');
  }
}

export function checkedMediaPath(directory, value, { newFile = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少文件路径。');
  const root = path.resolve(directory);
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep);
  if (!relative || path.isAbsolute(relative) || parts.includes('..') || parts.some(part => /[:\x00-\x1f]|[. ]$/.test(part))
    || /(?:\.key$|\.pem$|\.p12$|\.pfx$|\.env(?:\.|$)|token|credential|secret|password)/i.test(relative)) {
    throw new Error('文件必须位于批准目录内，并使用可分享的文件名。');
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.relative(root, fs.realpathSync(root))) {
    throw new Error('批准目录不能是链接或重解析路径。');
  }
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(current, fs.realpathSync(current))) {
      throw new Error('文件路径不能经过链接或重解析路径。');
    }
  }
  if (!newFile) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.relative(target, fs.realpathSync(target))) {
      throw new Error('只允许批准目录中的普通文件。');
    }
    if (stat.size > 100 * 1024 * 1024) throw new Error('文件超过 100 MiB。');
  }
  return target;
}
