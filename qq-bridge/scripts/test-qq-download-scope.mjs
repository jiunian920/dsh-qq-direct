import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveQQMedia } from '../src/qq-download.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-download-test-'));
const directory = path.join(root, 'downloads');
fs.mkdirSync(directory);
let downloads = 0;
const args = { key: 'group:456', messageId: '-12', token: 'fixture', savePath: 'sample.txt' };
const deps = { directory, async authorizeRead(key, token) { assert.deepEqual([key, token], [args.key, args.token]); },
  async onebot() { return { group_id: 456, message: [{ type: 'file', data: { url: 'https://example.org/file.txt' } }] }; },
  async download(url, limit) { assert.equal(url, 'https://example.org/file.txt'); assert.equal(limit, 32 * 1024 * 1024); downloads++; return { buffer: Buffer.from('test') }; }
};
try {
  await assert.rejects(saveQQMedia(args, { ...deps, async onebot() { return { group_id: 457 }; } }), /不属于/);
  await assert.rejects(saveQQMedia({ ...args, savePath: '../outside.txt' }, deps), /批准目录/);
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(directory, 'linked'), 'junction');
  await assert.rejects(saveQQMedia({ ...args, savePath: 'linked/sample.txt' }, deps), /链接/);
  assert.equal(downloads, 0);
  const result = await saveQQMedia(args, deps);
  assert.equal(fs.readFileSync(result.dest, 'utf8'), 'test');
  await assert.rejects(saveQQMedia(args, deps), { code: 'EEXIST' });
  await assert.rejects(saveQQMedia({ ...args, savePath: 'private.txt' }, { ...deps,
    async onebot() { return { group_id: 456, message: [{ type: 'file', data: { url: 'http://127.0.0.1/file' } }] }; }, download: undefined
  }), /内网|私有|禁止/);
  assert.equal(fs.existsSync(path.join(directory, 'private.txt')), false);
  console.log('QQ download authorization, cross-channel rejection, junction and traversal denial, no overwrite, and SSRF guard passed.');
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('qq-download-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
