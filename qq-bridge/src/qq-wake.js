function topicTerms(text) {
  const clean = String(text ?? '').normalize('NFKC').toLowerCase();
  const tokens = clean.match(/[a-z0-9]{3,}|\p{Script=Han}{2,}/gu) ?? [];
  return new Set(tokens.flatMap(token => {
    if (!/^\p{Script=Han}+$/u.test(token)) return [token];
    const chars = [...token];
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
  }));
}

export function groupWake({ text, replyTo, sender, recent, lastWake = 0, addressed, now = Date.now(), random = Math.random }) {
  if (addressed) return 'direct';
  const related = recent.filter(item => item && !item.opportunity && now - item.at < 90_000);
  const terms = topicTerms(text);
  const overlap = item => [...topicTerms(item.text)].filter(term => terms.has(term)).length;
  const matches = related.some(item => (replyTo && (item.messageId === replyTo || item.quote?.messageId === replyTo)) || overlap(item) >= 2);
  const continuation = now - lastWake < 90_000 && (matches || related.some(item => item.wakeClass === 'direct' && item.senderId === sender));
  if (continuation) return 'continuation';
  if (now - lastWake < 180_000 || terms.size < 2) return null;
  const isQuestion = /[?？]|怎么|为什么|有没有|求助/.test(text);
  const chance = 0.025 + (matches ? 0.10 : 0) + (isQuestion ? 0.05 : 0);
  return random() < chance ? 'opportunity' : null;
}
