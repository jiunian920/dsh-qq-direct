// One actor context, with a serial turn scheduler and explicit per-turn destination.
export class UnifiedTurnQueue {
  constructor() { this.queue = []; this.active = null; }
  submit(key, run) {
    return new Promise((resolve, reject) => { this.queue.push({ key, run, resolve, reject }); this.pump(); });
  }
  async pump() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job;
    try {
      const result = await job.run();
      job.resolve(result);
      if (!result?.ok || result.queued) this.finish(job.key);
    } catch (error) { job.reject(error); this.finish(job.key); }
  }
  finish(key) {
    if (this.active?.key !== key) return;
    this.active = null;
    void this.pump();
  }
}

export const UNIFIED_PRESET = 'qq-unified-v2';
export function belongsToUnified(key, owner, groups) {
  return key === `private:${owner}` || groups.map(String).some(id => key === `group:${id}`);
}
