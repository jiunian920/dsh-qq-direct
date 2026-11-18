import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];
const LOG_LIMIT = 2 * 1024 * 1024;

export function isDesktopInput(source) {
  return source?.kind === 'user' && typeof source.rpcId === 'string' && !!source.rpcId
    && typeof source.clientTimeZone === 'string' && !!source.clientTimeZone && source.principal == null;
}

export function createTurnUsage(filename) {
  const checkpoint = filename + '.pending';
  let active;

  function safeWrite(write) {
    try {
      write();
      return true;
    } catch (error) {
      console.error('[qq-direct] 用量记录未写入:', error.code ?? 'write-failed');
      return false;
    }
  }

  function append(row) {
    if ((fs.statSync(filename, { throwIfNoEntry: false })?.size ?? 0) >= LOG_LIMIT) {
      fs.renameSync(filename, filename + '.1');
    }
    fs.appendFileSync(filename, JSON.stringify(row) + '\n', 'utf8');
  }

  if (fs.existsSync(checkpoint)) safeWrite(() => {
    const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    const exists = [filename, filename + '.1'].some(file => fs.existsSync(file) &&
      fs.readFileSync(file, 'utf8').includes('"usageId":"' + saved.usageId + '"'));
    if (!exists) append({ ...saved, state: 'interrupted' });
    fs.unlinkSync(checkpoint);
  });

  function snapshot(state, at = Date.now()) {
    const { usageId, origin, observationSource, startedAt, steps, context, confirmedReplies } = active;
    const measured = [...steps.values()].filter(Boolean);
    const tokens = Object.fromEntries(TOKEN_FIELDS.map(field => [field, measured.reduce((sum, row) => {
      const value = row[field];
      return sum + (Number.isSafeInteger(value) && value >= 0 ? value : 0);
    }, 0)]));
    return { usageId, at, startedAt, origin, observationSource, state, elapsedMs: at - startedAt,
      modelResponses: steps.size, measuredResponses: measured.length, confirmedReplies,
      qqInputMessages: context.size, qqInputChars: [...context.values()].reduce((a, b) => a + b, 0), ...tokens };
  }

  function savePending() {
    if (!active?.origin) return;
    safeWrite(() => {
      const temporary = checkpoint + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(snapshot('pending')), 'utf8');
      fs.renameSync(temporary, checkpoint);
    });
  }

  function finish(state, at = Date.now()) {
    if (!active) return;
    if (active.origin) safeWrite(() => {
      append(snapshot(state, at));
      if (fs.existsSync(checkpoint)) fs.unlinkSync(checkpoint);
    });
    active = undefined;
  }

  return {
    enter(turn, origin, messages, observationSource) {
      if (!active || active.turn !== turn) {
        finish('interrupted');
        active = { turn, origin, usageId: randomUUID(), startedAt: Date.now(), steps: new Map(), context: new Map(), confirmedReplies: 0 };
      }
      if (!active.origin || origin?.startsWith('qq-')) active.origin = origin;
      if (['activity', 'scheduled', 'revisit'].includes(observationSource)) active.observationSource = observationSource;
      for (const input of messages) {
        if (input.source?.kind !== 'qq-direct') continue;
        const chars = (input.content ?? []).reduce((sum, part) => sum + (part.type === 'text' && typeof part.text === 'string' ? part.text.length : 0), 0);
        active.context.set(input.id, chars);
      }
      savePending();
    },

    response(data) {
      if (!active || data?.turn !== active.turn || !Number.isSafeInteger(data.step)) return;
      const usage = data.usage;
      if (usage && Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)) {
        active.steps.set(data.step, usage);
      } else if (!active.steps.has(data.step)) {
        active.steps.set(data.step, null);
      }
      savePending();
    },

    confirm(count) {
      if (!active || !Number.isSafeInteger(count) || count <= active.confirmedReplies) return;
      active.confirmedReplies = count;
      savePending();
    },

    end(data, confirmedReplies) {
      if (!active || (data?.turn != null && data.turn !== active.turn)) return;
      active.confirmedReplies = Math.max(confirmedReplies ?? 0, active.confirmedReplies);
      const reason = data?.reason?.kind ?? data?.reason;
      finish(/cancel|abort|error|fail|interrupt|timeout/i.test(String(reason ?? '')) ? 'interrupted' : 'complete');
    },
  };
}