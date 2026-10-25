/**
 * WHO HAS A TABLE OPEN (2026-10-24): the two read-only lookups horse table talk
 * uses so a line one person can see is never repeated to them anywhere.
 */
import { describe, expect, it } from 'vitest';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

const sub = (id: string, userId: string | undefined, readyState = 1): HubSubscriber => ({
  id,
  userId,
  readyState,
  send: () => undefined,
});

describe('TableStateHub viewer lookups', () => {
  it("userIdsAt lists each open socket's user once, skipping closed and anonymous sockets", () => {
    const hub = new TableStateHub();
    hub.subscribe('t1', sub('a', 'u1'));
    hub.subscribe('t1', sub('b', 'u1')); // a second tab
    hub.subscribe('t1', sub('c', 'u2'));
    hub.subscribe('t1', sub('d', 'u3', 3)); // closed
    hub.subscribe('t1', sub('e', undefined));
    expect(hub.userIdsAt('t1').sort()).toEqual(['u1', 'u2']);
    expect(hub.userIdsAt('nope')).toEqual([]);
  });

  it('tablesWatchedBy finds every table any of the users has open', () => {
    const hub = new TableStateHub();
    hub.subscribe('t1', sub('a', 'u1'));
    hub.subscribe('t2', sub('b', 'u1'));
    hub.subscribe('t3', sub('c', 'u2'));
    hub.subscribe('t4', sub('d', 'u1', 3)); // closed socket does not count
    expect(hub.tablesWatchedBy(new Set(['u1'])).sort()).toEqual(['t1', 't2']);
    expect(hub.tablesWatchedBy(new Set(['u1', 'u2'])).sort()).toEqual(['t1', 't2', 't3']);
    expect(hub.tablesWatchedBy(new Set())).toEqual([]);
  });

  it('a socket that left the room is no longer a viewer', () => {
    const hub = new TableStateHub();
    const s = sub('a', 'u1');
    hub.subscribe('t1', s);
    hub.unsubscribe('t1', s);
    expect(hub.userIdsAt('t1')).toEqual([]);
    expect(hub.tablesWatchedBy(new Set(['u1']))).toEqual([]);
  });
});
