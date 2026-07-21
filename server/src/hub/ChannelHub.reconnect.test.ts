/**
 * Regression test (2026-07-21) for the reconnect teardown race.
 *
 * addConnection() closes the OLD socket when a user reconnects; that close event
 * fires removeConnection() for the OLD socket AFTER the NEW socket is already
 * registered. Without a guard, removeConnection deleted the NEW connection and
 * tore down its subscriptions, blinding the just-reconnected user. The fix makes
 * removeConnection ignore the teardown unless the closing socket is still current.
 */
import { describe, it, expect } from 'vitest';
import { ChannelHub } from './ChannelHub.js';

function mkWs() {
  return { readyState: 1, close() {}, send() {} } as unknown as import('ws').WebSocket;
}

describe('ChannelHub — reconnect teardown race', () => {
  it('keeps the new connection when the old socket closes after a reconnect', () => {
    const hub = new ChannelHub();
    const conns = (hub as unknown as { connections: Map<string, unknown> }).connections;
    const userId = 'u1';
    const oldWs = mkWs();
    const newWs = mkWs();

    hub.addConnection(userId, oldWs);
    hub.addConnection(userId, newWs); // reconnect: registers new, closes old
    expect(conns.get(userId)).toBe(newWs);

    // The OLD socket's close handler arrives late — must NOT evict the new one.
    hub.removeConnection(userId, oldWs);
    expect(conns.get(userId)).toBe(newWs);

    // Closing the CURRENT socket still tears the user down.
    hub.removeConnection(userId, newWs);
    expect(conns.get(userId)).toBeUndefined();
  });

  it('legacy call with no socket still removes the connection', () => {
    const hub = new ChannelHub();
    const conns = (hub as unknown as { connections: Map<string, unknown> }).connections;
    hub.addConnection('u2', mkWs());
    hub.removeConnection('u2');
    expect(conns.get('u2')).toBeUndefined();
  });
});
