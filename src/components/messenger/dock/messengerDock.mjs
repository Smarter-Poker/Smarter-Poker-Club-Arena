// UI state contains conversation IDs only. Every restored/event-driven ID is
// resolved through the authenticated workspace API before content is mounted.
export const DOCK_STORAGE_PREFIX = 'sp-messenger-dock-v1:';
export const DOCK_MAX_CHATS = 8;
export const dockId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const dockName = conversation => conversation?.title || conversation?.otherUser?.display_name || conversation?.otherUser?.full_name || conversation?.otherUser?.username || 'Conversation';
export function dockCapacity(width) { return width < 768 ? 1 : Math.max(1, Math.min(3, Math.floor((width - 88) / 350))); }
export function restoreDock(raw) {
    try {
        const rows = JSON.parse(raw);
        if (!Array.isArray(rows)) return [];
        return [...new Map(rows.filter(row => dockId(row?.id)).map(row => [row.id, { id: row.id, minimized: row.minimized === true }])).values()].slice(-DOCK_MAX_CHATS);
    } catch { return []; }
}
export function updateDock(chats, action) {
    if (action.type === 'read') return chats.map(chat => chat.id === action.id ? { ...chat, unread: false } : chat);
    if (action.type === 'close') return chats.filter(chat => chat.id !== action.id);
    if (action.type === 'minimize') return chats.map(chat => chat.id === action.id ? { ...chat, minimized: true } : chat);
    if (action.type === 'refresh') return chats.map(chat => chat.id === action.conversation.id ? { ...chat, conversation: action.conversation } : chat);
    if (action.type !== 'open' || !dockId(action.conversation?.id)) return chats;
    const previous = chats.find(chat => chat.id === action.conversation.id);
    // A new message in a deliberately minimized chat highlights its bubble;
    // it never repeatedly reopens it or takes focus from the current composer.
    if (previous && action.incoming) return chats.map(chat => chat === previous ? { ...chat, conversation: action.conversation, unread: true } : chat);
    let rows = chats.filter(chat => chat.id !== action.conversation.id);
    rows.push({ id: action.conversation.id, conversation: action.conversation, minimized: action.minimized === true, unread: !!action.incoming });
    if (rows.length > DOCK_MAX_CHATS) {
        const oldestMinimized = rows.findIndex(chat => chat.minimized);
        rows.splice(oldestMinimized < 0 ? 0 : oldestMinimized, 1);
    }
    return rows;
}
export function dockLayout(chats, viewport, inbox = false) {
    const capacity = dockCapacity(viewport.width);
    const expanded = chats.filter(chat => !chat.minimized).slice(-capacity);
    const bubbles = chats.filter(chat => !expanded.includes(chat));
    const mobile = viewport.width < 768;
    const panelHeight = Math.max(120, Math.min(mobile ? 680 : 500, viewport.height - 100));
    return { expanded, bubbles, mobile, panelHeight,
        width: expanded.length || inbox ? Math.min(viewport.width - (mobile ? 16 : 24), mobile ? viewport.width - 16 : (inbox ? 350 : expanded.length * 350) + 68) : 64,
        height: expanded.length || inbox ? panelHeight : Math.min(400, 64 + bubbles.length * 54),
    };
}

// Arena allows five transient notifications. Reserve a bounded stack above the
// composer (100px textarea + 16px padding + 12px clearance); a nearly
// full-height mobile chat cannot push the notification stack offscreen.
export function dockNotificationLayout(viewHeight, bottom, dockHeight) {
    const clearance = Math.min(bottom + dockHeight + 12, Math.max(bottom + 128, viewHeight - 400));
    return { bottom: clearance, maxHeight: Math.max(60, viewHeight - clearance - 12) };
}
