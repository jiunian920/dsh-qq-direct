import { extractForwardIds } from './forward.js';

export function extractMediaFromSegments(segments, includeVideo = false) {
  const media = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const data = seg?.data ?? {};
    if (seg?.type === 'image') {
      media.push({ kind: 'image', file: String(data.file ?? data.file_id ?? ''), url: String(data.url ?? ''),
        subType: String(data.subType ?? data.sub_type ?? ''), summary: String(data.summary ?? '') });
    } else if (seg?.type === 'face') {
      media.push({ kind: 'face', faceId: String(data.id ?? '') });
    } else if (includeVideo && seg?.type === 'video') {
      media.push({ kind: 'video', url: String(data.url ?? data.file ?? '') });
    }
  }
  return media;
}

export function storedMedia(segments) {
  return extractMediaFromSegments(segments, true).slice(0, 16).map(({ kind, file, url, subType, summary, faceId }) => {
    if (kind === 'face') return { kind, faceId: faceId.slice(0, 64) };
    const link = typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 4096 ? url : '';
    if (kind === 'video') return { kind, url: link };
    return { kind, url: link, file: file.length <= 512 && !/^base64:\/\//i.test(file) ? file : '',
      subType: subType.slice(0, 16), summary: summary.slice(0, 120) };
  });
}

export function messageBelongsToChannel(raw, kind, channelId, selfId = null) {
  if (!raw || typeof raw !== 'object') return false;
  const group = raw.group_id ?? raw.groupId;
  if (kind === 'group') return group != null && String(group) === String(channelId);
  const sender = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
  if (kind !== 'private' || group != null || sender == null) return false;
  if (String(sender) === String(channelId)) return true;
  const recipient = raw.target_id ?? raw.targetId ?? raw.peer_id ?? raw.peerId;
  return selfId != null && String(sender) === String(selfId)
    && recipient != null && String(recipient) === String(channelId);
}

export function directMessageView(item, ownerId) {
  return {
    messageId: item.messageId, userId: item.senderId, sender: item.sender,
    text: item.text, plain: item.text, time: item.at, isSelf: Boolean(item.isSelf),
    isOwner: !item.isSelf && String(item.senderId) === String(ownerId),
    media: item.media ?? [], hasMedia: Boolean(item.media?.length),
    forwardIds: item.forwardIds ?? [], hasForward: Boolean(item.forwardIds?.length),
  };
}

export function attachmentFields(segments) {
  return { attachments: storedMedia(segments), forwardIds: extractForwardIds(segments) };
}
