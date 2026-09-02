/**
 * ChannelHub connection lifecycle.
 *
 * 2026-07-21: the reconnect teardown race — a late close from a superseded
 * socket must never blind the connection that replaced it.
 *
 * 2026-08-24: MULTI-TAB. The hub used to enforce one socket per userId by
 * closing the existing socket on every addConnection. Two tabs (lobby +
 * table, multi-table play, phone + desktop) therefore EVICTED EACH OTHER in
 * an endless reconnect loop — every cycle dropped the user's subscriptions
 * and flapped their wallet/tournament/lobby feeds. A user now holds a SET of
 * sockets; messages fan out to all of them, and subscriptions are torn down
 * only when the LAST socket closes.
 */
import { describe, it, expect } from 'vitest';
import { ChannelHub } from './ChannelHub.js';

function mkWs() {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    sent,
    closed: [] as Array<number | undefined>,
    close(code?: number) {
      this.closed.push(code);
      this.readyState = 3;
    },
    send(data: string) {
      sent.push(data);
    },
  };
  return ws as unknown as import('ws').WebSocket & { sent: string[]; closed: number[] };
}

function socketsOf(hub: ChannelHub, userId: string): Set<unknown> | undefined {
  return (hub as unknown as { connections: Map<string, Set<unknown>> }).connections.get(userId);
}

describe('ChannelHub - multiple tabs coexist (2026-08-24)', () => {
  it('a second connection does NOT evict the first', () => {
    const hub = new ChannelHub();
    hub.close(); // stop the lobby interval; irrelevant here
    const a = mkWs();
    const b = mkWs();
    hub.addConnection('u1', a);
    hub.addConnection('u1', b);
    expect(a.closed).toHaveLength(0); // the old eviction would have closed A
    expect(socketsOf(hub, 'u1')?.size).toBe(2);
  });

  it('sendToUser reaches every tab', () => {
    const hub = new ChannelHub();
    hub.close();
    const a = mkWs();
    const b = mkWs();
    hub.addConnection('u1', a);
    hub.addConnection('u1', b);
    hub.sendToUser('u1', { type: 'CHANNEL_PONG' });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('closing ONE tab keeps the subscriptions for the others', () => {
    const hub = new ChannelHub();
    hub.close();
    const a = mkWs();
    const b = mkWs();
    hub.addConnection('u1', a);
    hub.addConnection('u1', b);
    hub.joinLobby('u1');
    hub.joinTournament('u1', 't1');

    hub.removeConnection('u1', a);
    expect(hub.lobbySubscriberCount()).toBe(1);
    expect(hub.tournamentSubscriberCount('t1')).toBe(1);
    expect(socketsOf(hub, 'u1')?.size).toBe(1);
  });

  it('closing the LAST tab tears the user down', () => {
    const hub = new ChannelHub();
    hub.close();
    const a = mkWs();
    hub.addConnection('u1', a);
    hub.joinLobby('u1');
    hub.removeConnection('u1', a);
    expect(hub.lobbySubscriberCount()).toBe(0);
    expect(socketsOf(hub, 'u1')).toBeUndefined();
  });

  it('a late close from an already-removed socket is a no-op (reconnect race)', () => {
    const hub = new ChannelHub();
    hub.close();
    const oldWs = mkWs();
    const newWs = mkWs();
    hub.addConnection('u1', oldWs);
    hub.joinLobby('u1');
    // The old socket's close lands first, then its handler fires again late —
    // the user's OTHER socket must be untouched.
    hub.addConnection('u1', newWs);
    hub.removeConnection('u1', oldWs);
    hub.removeConnection('u1', oldWs); // late duplicate
    expect(hub.lobbySubscriberCount()).toBe(1);
    expect(socketsOf(hub, 'u1')?.has(newWs)).toBe(true);
  });

  it('legacy call with no socket still removes the whole connection', () => {
    const hub = new ChannelHub();
    hub.close();
    hub.addConnection('u2', mkWs());
    hub.addConnection('u2', mkWs());
    hub.joinLobby('u2');
    hub.removeConnection('u2');
    expect(hub.lobbySubscriberCount()).toBe(0);
    expect(socketsOf(hub, 'u2')).toBeUndefined();
  });

  it('beyond the per-user cap the OLDEST socket is closed, newest kept', () => {
    const hub = new ChannelHub();
    hub.close();
    const sockets = Array.from({ length: 9 }, () => mkWs());
    for (const ws of sockets) hub.addConnection('u3', ws);
    expect(socketsOf(hub, 'u3')?.size).toBe(8);
    expect(sockets[0].closed.length).toBeGreaterThan(0); // oldest evicted
    expect(socketsOf(hub, 'u3')?.has(sockets[8])).toBe(true); // newest kept
  });

  it('connectionCount counts sockets, userCount counts users', () => {
    const hub = new ChannelHub();
    hub.close();
    hub.addConnection('u1', mkWs());
    hub.addConnection('u1', mkWs());
    hub.addConnection('u2', mkWs());
    expect(hub.connectionCount()).toBe(3);
    expect(hub.userCount()).toBe(2);
  });
});
