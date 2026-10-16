// Same wire channels as the full Messenger; each subscription has one owner.
export function broadcastSync(name, message) {
    try { const channel = new BroadcastChannel(name); channel.postMessage(message); channel.close(); }
    catch { /* Browsers without BroadcastChannel still refresh on visibility. */ }
}
export function listenBroadcast(name, listener) {
    let channel;
    try { channel = new BroadcastChannel(name); channel.onmessage = event => listener(event.data); }
    catch { /* No cross-window transport available. */ }
    return () => channel?.close();
}
