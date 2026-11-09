// dsh-token-reporter.mjs —— 把当前 DSH 进程的**启动令牌 URL** 写到固定文件，给 qq-bridge 用。
//
// ⚠️ 为什么需要它（2026-10-12 搬家时查出来的）：
//   新版 DSH 的启动令牌是 `randomBytes()` 现生成的、**只存在内存里**
//   （`dsh-client-connection/lib/index.js` L244-248），**不落盘、没有环境变量能固定**。
//   而 qq-bridge 原来的 `sync-dsh-token.mjs` 是从**外壳写的 `%LOCALAPPDATA%\DSH\shell.log`**
//   里抓那一行的 —— ⚠️ **官方 Electron app 不写那个文件**，所以桥抓不到。
//   → 这个插件用**官方自己的公开姿势**把令牌取出来写到文件里，让桥去读。
//
// 挂法（profile 的 cordis.patch.yml）：
//   - insert:
//       - id: token-reporter
//         config:
//
// ⚠️ 取令牌用的是 `ctx.connection.authenticatedUrl(origin)` —— 跟官方
//    `dsh-desktop-host/lib/index.js` L337 用的是同一个方法（人家是照抄的，不是猜的）。
// ⚠️ 写出来的文件里**含凭据**：只给本机的桥读，别外发、别贴进聊天、别进记忆库。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const name = 'dsh-token-reporter';

// 等这两个服务就绪再 apply（Cordis 会把插件挂起直到它们可用）
// ⚠️ `timer` 别漏 —— 人家第一版漏了，报 `cannot get property "timer" without inject`
export const inject = ['timer', 'connection', 'webServer'];

export function apply(ctx, config = {}) {
  // ⚠️ 2026-10-12 修的自家缺陷：输出路径以前是**硬编码**的，
  //    结果**任何测试实例都会覆盖真实的那份**（人家实测时就把 19387 的令牌盖成了 3099 的）。
  //    ⭐ 现在环境变量优先：跑测试实例时 `DSH_TOKEN_OUT=<别处>` 就不会碰真实文件。
  const outPath = process.env.DSH_TOKEN_OUT
    || config.outPath
    || fileURLToPath(new URL('../qq-bridge/state/dsh-launch.json', import.meta.url));
  const host = config.host || '127.0.0.1';

  const write = (why) => {
    try {
      const port = ctx.webServer.port;
      const url = ctx.connection.authenticatedUrl('http://' + host + ':' + String(port));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify({
        url,
        host,
        port,
        ts: Date.now(),
        note: '由 dsh-token-reporter 写出；含启动令牌，别外发',
      }, null, 2), 'utf8');
      console.log('dsh-token-reporter: 已写出启动 URL（' + why + '）port=' + port);
    } catch (e) {
      console.log('dsh-token-reporter: 写失败（' + why + '） ' + e.message);
    }
  };

  // 立刻写一次；端口可能还在绑定，所以再补一次（一次性 timer，不轮询）
  write('挂载时');
  const t = ctx.setTimeout(() => write('3 秒后补写'), 3000);

  ctx.effect(() => () => {
    try { t() } catch (e) { /* 收尾阶段不抛错 */ }
  });
}
