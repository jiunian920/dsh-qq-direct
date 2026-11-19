function topicTerms(text) {
  const clean = String(text ?? '').normalize('NFKC').toLowerCase();
  const tokens = clean.match(/[a-z0-9]{3,}|\p{Script=Han}{2,}/gu) ?? [];
  return new Set(tokens.flatMap(token => {
    if (!/^\p{Script=Han}+$/u.test(token)) return [token];
    const chars = [...token];
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
  }));
}

const isQuestion = text => /[?？]|怎么|为什么|有没有|求助/.test(text);

const knownTopic = (text, topics) => topics.some(topic => text.normalize('NFKC').toLowerCase().includes(topic));

export function observationEvidence(messages, focusId, topics = []) {
  const bodies = new Set();
  const fresh = [];
  for (const item of messages) {
    const body = String(item.text ?? '').normalize('NFKC').replace(/https?:\/\/\S+/g, '').trim().slice(0, 280);
    const terms = topicTerms(body);
    if (!item.senderId || (!terms.size && !item.quote?.messageId)) continue;
    const key = body.toLowerCase().replace(/[\s\p{P}]+/gu, '') || item.quote?.messageId;
    if (bodies.has(key)) continue;
    bodies.add(key);
    fresh.push({ item, terms, body });
  }
  const anchors = focusId ? fresh.filter(row => row.item.id === focusId) : fresh;
  for (const anchor of anchors) {
    const related = fresh.filter(row => row !== anchor && (
      row.item.quote?.messageId === anchor.item.messageId || anchor.item.quote?.messageId === row.item.messageId
      || [...row.terms].filter(term => anchor.terms.has(term)).length >= 2));
    const otherSpeaker = related.find(row => row.item.senderId !== anchor.item.senderId);
    if (otherSpeaker) {
      return [anchor, otherSpeaker, ...related.filter(row => row !== otherSpeaker)].slice(0, 6).map(row => row.item);
    }
    if ((anchor.terms.size >= 5 && isQuestion(anchor.body)) ||
      (anchor.terms.size >= 3 && anchor.body.length >= 8 && knownTopic(anchor.body, topics))) return [anchor.item];
  }
  return [];
}

export function scheduledObservationEvidence(messages, topics) {
  const preferred = observationEvidence(messages, undefined, topics);
  if (preferred.length) return preferred;
  const seen = new Set();
  return messages.filter(item => {
    if (!item.senderId) return false;
    const text = String(item.text ?? '').normalize('NFKC').trim();
    if (!text) return Boolean(item.quote?.messageId || item.media?.length);
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  }).slice(0, 3);
}

export function groupWake({ text, replyTo, sender, recent, lastWake = 0, addressed, now = Date.now(), random = Math.random, topics = [], allowOpportunity = true }) {
  if (addressed) return 'direct';
  const related = recent.filter(item => item && !item.opportunity && now - item.at < 90_000);
  const terms = topicTerms(text);
  const overlap = item => [...topicTerms(item.text)].filter(term => terms.has(term)).length;
  const matches = related.some(item => (replyTo && (item.messageId === replyTo || item.quote?.messageId === replyTo)) || overlap(item) >= 2);
  const continuation = now - lastWake < 90_000 && (matches || related.some(item => item.wakeClass === 'direct' && item.senderId === sender));
  if (continuation) return 'continuation';
  if (!allowOpportunity) return null;
  if (now - lastWake < 180_000 || terms.size < 2) return null;
  const baseChance = 0.025 + (matches ? 0.10 : 0) + (isQuestion(text) ? 0.05 : 0);
  const chance = knownTopic(String(text).replace(/https?:\/\/\S+/g, ''), topics) ? Math.max(0.12, baseChance) : baseChance;
  return random() < chance ? 'opportunity' : null;
}
