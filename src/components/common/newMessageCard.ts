/** Pure mapping from a `new_message` notification row to a live popup card. */

export interface MessageCard {
  id: string;
  sender: string;
  preview: string;
  path: string;
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
  return { id: String(row.id), sender, preview, path: link };
}
