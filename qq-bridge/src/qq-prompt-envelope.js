// Standing identity/privacy policy belongs to the agent's system persona.
// Keep the per-turn destination explicit and retain retrieved memory verbatim.
export function unifiedPromptEnvelope(key, memoryHint, memoryCore) {
  return {
    scene: `【当前交流场景】${key.startsWith('private:') ? '主人私聊' : '公开群聊'}；本轮唯一发送目标=${key}。电脑任务仅由桥核验主人当前明确原话后另行委托；QQ工具不提供本地命令，没有委托回执不能说已执行。\n\n`,
    memoryHint: memoryHint.startsWith(memoryCore) ? memoryHint.slice(memoryCore.length) : memoryHint,
  };
}
