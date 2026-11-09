import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { looksLikeImageBuffer, safeFetch } from './safe-fetch.js';

const BILI = process.env.QQ_MEDIA_BILI || 'bili';
const execute = promisify(execFile);
const videoPattern = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)(?![0-9A-Za-z])/i;

async function query(action, id, args = []) {
  const { stdout } = await execute(BILI, ['--compact', 'video', action, id, ...args], {
    windowsHide: true, timeout: 18_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' },
  });
  const response = JSON.parse(stdout);
  if (!response.ok) throw new Error('B 站资料暂不可用');
  return response.data;
}

export async function biliVideoId(text) {
  const body = String(text ?? '');
  const direct = videoPattern.exec(body)?.[1];
  if (direct) return direct;
  const short = /https?:\/\/b23\.tv\/[0-9a-z]+\b/i.exec(body)?.[0];
  if (!short) return null;
  try { return videoPattern.exec((await safeFetch(short, 512)).url)?.[1] ?? null; }
  catch { return null; }
}

export async function readBiliMedia(id, preview = false) {
  if (!/^(?:BV[0-9A-Za-z]{10}|av[1-9]\d*)$/i.test(id)) throw new Error('B 站视频 ID 无效');
  const metadata = await query('info', id);
  const title = String(metadata.title ?? '').slice(0, 200);
  const description = String(metadata.desc ?? '').slice(0, 800);
  const lines = [`B 站视频 ${id}：${title}`, description && `简介：${description}`].filter(Boolean);
  if (!preview) return { text: lines.join('\n') };

  const tempRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot, 'qq-bili-'));
  let buffer;
  try {
    const [subtitle, danmaku, frames] = await Promise.allSettled([
      query('subtitle', id, ['--text']),
      query('danmaku', id, ['--limit', '12']),
      query('frames', id, ['--quality', 'preview', '--count', '4', '--out', directory]),
    ]);
    if (subtitle.status === 'fulfilled') {
      const text = String(subtitle.value?.text ?? '').slice(0, 2200);
      if (text) lines.push(`字幕节选：${text}`);
    } else lines.push('字幕暂不可用。');
    if (danmaku.status === 'fulfilled') {
      const items = Array.isArray(danmaku.value) ? danmaku.value : danmaku.value?.items;
      const texts = (items ?? []).slice(0, 12).map(item => String(item.text ?? item.content ?? '').slice(0, 100)).filter(Boolean);
      if (texts.length) lines.push(`弹幕节选：${texts.join(' / ')}`);
    }
    if (frames.status === 'fulfilled' && frames.value?.sheet) {
      const sheet = await fs.realpath(frames.value.sheet);
      const relative = path.relative(directory, sheet);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const stat = await fs.stat(sheet);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          const image = await fs.readFile(sheet);
          if (looksLikeImageBuffer(image)) buffer = image;
        }
      }
    }
    lines.push(buffer ? '画面为 4 个预览时间点。' : '画面预览暂不可用。');
  } finally {
    if (path.dirname(directory) === tempRoot && path.basename(directory).startsWith('qq-bili-')) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  return { buffer, mimeType: buffer ? 'image/jpeg' : undefined, text: lines.join('\n') };
}
