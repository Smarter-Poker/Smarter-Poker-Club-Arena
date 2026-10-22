/** Pure mapping from a `new_message` notification row to a live popup card. */

export interface MessageCard {
  id: string;
  sender: string;
  preview: string;
  path: string;
  /** Sender's photo when the notification carries one; null shows the messenger icon. */
  avatarUrl: string | null;
}

/** Pure: turn a `new_message` notification row into a popup card. */
export function toMessageCard(row: Record<string, any> | null | undefined): MessageCard | null {
  if (!row || row.type !== 'new_message' || !row.id) return null;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const sender = title.replace(/^message from\s+/i, '').trim() || 'New Message';
  const preview = typeof row.message === 'string' ? row.message.trim() : '';
  const conversationId =
    (row.data && (row.data.conversationId || row.data.conversation_id)) || null;
  const link =
    (typeof row.link === 'string' && row.link.startsWith('/hub/messenger') && row.link) ||
    (typeof row.action_url === 'string' &&
      row.action_url.startsWith('/hub/messenger') &&
      row.action_url) ||
    (conversationId
      ? `/hub/messenger?c=${encodeURIComponent(String(conversationId))}`
      : '/hub/messenger');
  const rawAvatar =
    row.data && typeof row.data.senderAvatarUrl === 'string' ? row.data.senderAvatarUrl.trim() : '';
  // Only an https image or a same-origin path is shown; anything else falls
  // back to the messenger icon rather than loading an arbitrary scheme.
  const avatarUrl =
    /^https:\/\//i.test(rawAvatar) || /^\/(?!\/)/.test(rawAvatar) ? rawAvatar : null;
  return { id: String(row.id), sender, preview, path: link, avatarUrl };
}
