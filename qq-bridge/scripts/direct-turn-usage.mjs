import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tariffAt } from './deepseek-rates.mjs';

const args = process.argv.slice(2);
const filename = args.find(arg => !arg.startsWith('--')) ?? new URL('../state/turn-usage.jsonl', import.meta.url);
const count = Number(args.find(arg => arg.startsWith('--last='))?.slice(7) ?? 50);
const since = args.find(arg => arg.startsWith('--since='))?.slice(8);
const until = args.find(arg => arg.startsWith('--until='))?.slice(8);
const start = since === undefined ? -Infinity : Date.parse(since);
const end = until === undefined ? Infinity : Date.parse(until);
const model = args.find(arg => arg.startsWith('--model='))?.slice(8) ?? 'deepseek-flash';
const checksDay = args.find(arg => arg.startsWith('--checks='))?.slice(9);
const ratesArg = args.find(arg => arg.startsWith('--rates='));
const rates = ratesArg?.slice(8).split(',').map(value => value.trim() ? Number(value) : NaN);
if ((checksDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(checksDay))
  || !Number.isSafeInteger(count) || count < 1 || !(start < end) || (rates && (rates.length < 3 || rates.length > 4 ||
  rates.some(rate => !Number.isFinite(rate) || rate < 0)))) {
  console.error('用法：node scripts/direct-turn-usage.mjs [日志路径] [--observation-stats] [--checks=YYYY-MM-DD] [--model=模型] [--last=50] [--since=ISO时间] [--until=ISO时间] [--rates=缓存读,未命中,输出[,缓存写]]');
  process.exitCode = 2;
} else {
  const rows = [];
  const files = [filename instanceof URL ? new URL(filename.href + '.1') : filename + '.1', filename];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { console.error('有一行用量记录无法读取，已跳过。'); }
    }
  }
  const checkpoint = filename instanceof URL ? new URL(filename.href + '.pending') : filename + '.pending';
  if (fs.existsSync(checkpoint)) {
    try {
      const pending = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      if (!rows.some(row => row.usageId === pending.usageId)) rows.push(pending);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('进行中的用量快照暂时无法读取。');
    }
  }
  const selected = rows.filter(row => row.at >= start && row.at < end).slice(-count);
  const groups = Object.groupBy(selected, row => row.origin);
  if (!selected.length) console.log('所选时段暂无用量记录。');
  const fields = ['modelResponses', 'measuredResponses', 'confirmedReplies', 'qqInputMessages', 'qqInputChars',
    'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];
  for (const [origin, entries] of Object.entries(groups)) {
    const summary = { origin, turns: entries.length };
    for (const field of fields) summary[field] = entries.reduce((sum, row) => sum + row[field], 0);
    if (origin === 'qq-opportunity') {
      summary.observationSources = Object.fromEntries(Object.entries(Object.groupBy(entries, row => row.observationSource ?? 'unknown'))
        .map(([source, turns]) => [source, { turns: turns.length, confirmedReplies: turns.reduce((n, row) => n + row.confirmedReplies, 0) }]));
    }
    summary.responsesPerTurn = Number((summary.modelResponses / summary.turns).toFixed(2));
    const partial = entries.filter(row => row.state === 'pending' || row.state === 'interrupted');
    if (partial.length) {
      summary.pendingTurns = partial.filter(row => row.state === 'pending').length;
      summary.interruptedTurns = partial.length - summary.pendingTurns;
    }
    const priced = entries.filter(row => row.modelResponses > 0).map(row => ({
      row, tariff: rates ? { bucket: 'manual', rates } : tariffAt(row.at, model),
    }));
    if (priced.length && priced.every(({ row, tariff }) => tariff && row.measuredResponses === row.modelResponses
      && (!row.cacheWriteTokens || tariff.rates.length === 4))) {
      const costs = {};
      for (const { row, tariff } of priced) {
        const [hit, miss, output, write = 0] = tariff.rates;
        const cost = (row.cacheReadTokens * hit + row.inputTokens * miss + row.outputTokens * output
          + row.cacheWriteTokens * write) / 1_000_000;
        costs[tariff.bucket] = (costs[tariff.bucket] ?? 0) + cost;
      }
      summary[partial.length ? 'observedEstimatedCny' : 'estimatedCny'] = Object.values(costs).reduce((total, cost) => total + cost, 0);
      if (!rates) summary.estimatedModel = model;
      summary.costByTariff = costs;
    }
    console.log(JSON.stringify(summary));
  }
  if (checksDay) {
    const file = new URL('../state/observation-history/' + checksDay + '.jsonl', import.meta.url);
    const observations = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    for (const item of observations) {
      try { console.log(JSON.stringify({ observationCheck: JSON.parse(item) })); }
      catch { console.error('有一条主动检查记录无法读取。'); }
    }
  }
  if (args.includes('--observation-stats')) {
    const database = fileURLToPath(new URL('../state/direct-qq.sqlite3', import.meta.url));
    if (fs.existsSync(database)) {
      const store = new DatabaseSync(database, { readOnly: true });
      try {
        const row = store.prepare('SELECT payload FROM runtime WHERE name=?').get('automatic-observation-stats');
        console.log(JSON.stringify({ observationStats: row ? JSON.parse(row.payload) : {} }));
      } finally { store.close(); }
    }
  }
}
