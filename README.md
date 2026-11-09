# DSH QQ 直连框架

**这是一个许愿式编程的产物。我完全没有编程基础，是个门外汉。**

**⚠️ 免责声明。** 本项目为非科班开发者的「许愿式编程」实验产物。**AI 生成标注**　代码由 AI 生成和修改，人类负责架构设计与测试。仅用于个人学习与已授权白名单的小范围测试。请务必使用测试小号，账号风控风险由使用者承担。

**💡 核心机制。** 让 DSH 桌面、授权操作者的 QQ 私聊和白名单 QQ 群共用同一个主会话，绑定同一个 `sessionId`。采用「账本优先 + 主会话裁决」机制，保留发言人、原消息和回复渠道，减少跨入口认错人和接错话。

**🚫 部署范围。** 本项目是一套基于已有 DSH 会话的直连方案，需要按文档手动装配。SnowLuma 由使用者自行安装。

**🛡️ 安全边界。** 真实 QQ 测试已验证，群友通过直连回复工具请求发送本机文件时会被拦截。跨渠道发送、附件归属和保存路径另有隔离测试。详见[架构手册第 8.2 节](./docs/ARCHITECTURE.md#security-checks)。

## 阅读指引

- [从新电脑开始](./docs/ARCHITECTURE.md#setup)
- [消息、回合与账本](./docs/ARCHITECTURE.md#message-flow)
- [各功能如何实现](./docs/ARCHITECTURE.md#features)
- [权限设计与复建加固](./docs/ARCHITECTURE.md#security)
- [当前能力与验证层级](./docs/ARCHITECTURE.md#verification)

## 项目来源与致谢

**上游代码。** 本项目基于 GitHub 用户 `Derpyu520` 与贡献者维护的 `qq-bridge` 深度改造。QQ 桥接和 MCP 工具继承了上游实现。在此基础上，本项目扩展了桌面、私聊与白名单群共用一个已有 DSH 会话，以及持久投递、逐条记忆同步和按回合校验发言权限。 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)

**设计参考。** 感谢以下项目的维护者公开实现和设计文档。

- **DeepSeek Harness 团队 · `dsh-superagent-prototype`**。参考它用稳定消息 ID、来源标记和持久记录做投递去重，以及区分纳入上下文和唤醒回合的做法。 [原型与源码](https://github.com/deepseek-ai/dsh-superagent-prototype)
- **`LingYuYo` · `dsh-qq-bridge`**。参考长图分段、视频抽样和保留引用上下文的思路。本机媒体处理使用 Pillow、FFmpeg 和现有 QQ 网关。 [项目](https://github.com/LingYuYo/dsh-qq-bridge)
- **`hyun20202023-ui` · `dsh-qfish`**。参考 QQ 聊天里按需结合 B 站画面、字幕和弹幕来理解视频。 [项目](https://github.com/hyun20202023-ui/dsh-qfish)
- **`zxz-feng` · `dsh-qq-bridge`**。参考群聊唤醒的概率和冷却策略。本项目由本地规则给出唤醒机会，再由智能体决定是否发言。 [项目](https://github.com/zxz-feng/dsh-qq-bridge)

**方案对照。** `jcleener` 的 `dsh-qq-bridge` 提供了 QQ 私聊续接已有 DSH 会话的对照。`988hj7tczd-oss` 的 `dsh-im-qq` 提供了官方机器人接口、独立会话与审批的对照。 [jcleener/dsh-qq-bridge](https://github.com/jcleener/dsh-qq-bridge) · [988hj7tczd-oss/dsh-im-qq](https://github.com/988hj7tczd-oss/dsh-im-qq)

### 许可状态

当前上游 Derpyu520/qq-bridge 的主分支声明使用 PolyForm Noncommercial License 1.0.0，发布记录记载了从 MIT 的变更。发布时应先核对实际继承的版本和文件适用的许可与声明。以下为上游现行许可要求保留的版权声明。 [上游现行许可](https://github.com/Derpyu520/qq-bridge/blob/main/LICENSE) · [许可变更记录](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.2.1-r2)

> Required Notice: Copyright 2026 Derpyu520 and qq-bridge contributors

本项目基于 `Derpyu520/qq-bridge` 的 `v0.1.5` 分支改造。该项目的 `NOTICE` 说明 `v0.2.1-r1` 及更早的发布仍可按 MIT 条款使用，因此本项目以 **MIT** 许可发布，版权声明已并入 [LICENSE](./LICENSE)。SnowLuma 由使用者自行安装，并按其自身条款使用。 [SnowLuma 许可说明](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md)

📖 [详细架构原理与跨机复建手册](./docs/ARCHITECTURE.md)
