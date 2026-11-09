import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeFetchBinary } from './safe-fetch.js';
const PYTHON = process.env.QQ_MEDIA_PYTHON || process.env.QQ_PYTHON || 'python';
const SCRIPT = fileURLToPath(new URL('./animation-frames.py', import.meta.url));
const FFMPEG = process.env.QQ_MEDIA_FFMPEG || 'ffmpeg';

function decode(executable, args, input, maxBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('媒体解码超时')); }, 15000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { child.kill(); reject(new Error('媒体预览超过大小上限')); return; }
      chunks.push(chunk);
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 && size ? resolve(Buffer.concat(chunks)) : reject(new Error('媒体解码失败')); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function prepareVisionMedia(media) {
  if (!media?.buffer || !['image/gif', 'image/webp'].includes(media.mimeType)) return media;
  const buffer = await decode(PYTHON, [SCRIPT], media.buffer, 2 * 1024 * 1024);
  return { ...media, buffer, mimeType: 'image/jpeg', text: [media.text, '动图/兼容图片按时间抽帧，左到右、上到下；最多6帧，预览最多240帧。仅描述可见动作，不当作完整播放。'].filter(Boolean).join(' ') };
}

export async function sliceLongImage(media, size) {
  if (!media?.buffer || !size || !['image/jpeg', 'image/png'].includes(media.mimeType)) return [media];
  const { width, height } = size;
  if (Math.max(width, height) < 1800 || Math.max(width, height) < 3 * Math.min(width, height)) return [media];
  const output = await decode(PYTHON, [SCRIPT, '--long'], media.buffer, 8 * 1024 * 1024);
  const frames = JSON.parse(output.toString('utf8'));
  if (!frames.length) return [media];
  return frames.map((frame, index) => ({ buffer: Buffer.from(frame, 'base64'), mimeType: 'image/jpeg',
    text: `长图第 ${index + 1}/${frames.length} 段（相邻段有重叠）` }));
}

export async function previewVideo(url, fetchBinary = safeFetchBinary) {
  if (!url) throw new Error('QQ 未提供视频下载地址');
  const { buffer } = await fetchBinary(url, 24 * 1024 * 1024);
  if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') throw new Error('视频预览目前支持 MP4');
  const args = ['-nostdin', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-max_alloc', '67108864',
    '-protocol_whitelist', 'pipe', '-enable_drefs', '0', '-f', 'mov', '-i', 'pipe:0', '-map', '0:v:0',
    '-an', '-sn', '-dn', '-vf', 'trim=duration=12,scale=480:480:force_original_aspect_ratio=decrease,fps=1/3:round=up,tile=2x2',
    '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'];
  const image = await decode(FFMPEG, args, buffer, 2 * 1024 * 1024);
  return { buffer: image, mimeType: 'image/jpeg', text: 'QQ 视频开头 12 秒的抽帧预览，按行从左到右，无音轨。' };
}
