/**
 * IP RESTRICTION, MADE REAL (2026-08-19).
 *
 * "IP Restriction" has been a switch on the create-table page since day one and
 * enforced nothing — one of eight security toggles that wrote a `tables` column
 * no code read. It is the only one of the eight that CAN be honoured, because
 * the engine already learns each player's address from the x-forwarded-for
 * chain at the WebSocket upgrade.
 *
 * It means what it means in a live room: two DIFFERENT accounts may not sit at
 * the same table from the same internet connection.
 *
 * The dangerous failure here is a FALSE POSITIVE — refusing a legitimate
 * player. So most of this file is about what must NOT be treated as a conflict:
 *
 *   - the same player reconnecting (a dropped socket lingers until the
 *     heartbeat sweep, so the old connection is still in the map);
 *   - an address we never learned. Caddy proxies to the engine, so a
 *     misconfigured forward makes EVERY client look like 127.0.0.1 — if that
 *     counted as a match, the second player to arrive at any table would be
 *     refused, room-wide;
 *   - players at a DIFFERENT table on the same address;
 *   - anything at all when the table's switch is off, which is the state every
 *     table ships in.
 *
 * These tests drive the real private methods on the real class rather than a
 * copy of the logic, because a copy would happily keep passing after the
 * shipped rule changed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EngineWebSocketServer, isUsableClientIp } from './EngineWebSocketServer.js';

const TABLE_A = '6e1f8768-3baa-479e-b912-b8736123e840';
const TABLE_B = '11111111-2222-3333-4444-555555555555';
const ALICE = 'aaaaaaaa-0000-0000-0000-000000000001';
const BOB = 'bbbbbbbb-0000-0000-0000-000000000002';

/** Minimal stand-in for TableStateHub — the gate never touches it. */
const fakeHub = {
  subscribe: () => {},
  unsubscribe: () => {},
} as never;

interface Harness {
  server: EngineWebSocketServer;
  /** Pretend `userId` is already connected to `tableId` from `ip`. */
  seat(tableId: string, userId: string, ip: string | null): void;
  /** Supply the restriction setting from the verified database verdict. */
  setRestricted(tableId: string, restricted: boolean): void;
  conflict(tableId: string, userId: string, ip: string | null): Promise<boolean>;
}

function harness(): Harness {
  const server = new EngineWebSocketServer({ hub: fakeHub, tableExists: () => true });
  const restrictions = new Map<string, boolean>();
  const internals = server as unknown as {
    connections: Map<object, { userId: string; tableId: string; clientIp: string | null }>;
    isIpConflict(tableId: string, userId: string, ip: string | null, restricted: boolean): boolean;
  };
  return {
    server,
    seat(tableId, userId, ip) {
      internals.connections.set({}, { userId, tableId, clientIp: ip });
    },
    setRestricted(tableId, restricted) {
      restrictions.set(tableId, restricted);
    },
    conflict(tableId, userId, ip) {
      return Promise.resolve(
        internals.isIpConflict.call(server, tableId, userId, ip, restrictions.get(tableId) === true)
      );
    },
  };
}

describe('isUsableClientIp', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown', '', '  ', null, undefined])(
    'treats %p as an address we do not actually know',
    (ip) => {
      expect(isUsableClientIp(ip as string | null)).toBe(false);
    }
  );

  it.each(['24.15.206.254', '2001:db8::1', '203.0.113.7'])('accepts the real address %s', (ip) => {
    expect(isUsableClientIp(ip)).toBe(true);
  });

  it('is case- and whitespace-insensitive about the loopback forms', () => {
    expect(isUsableClientIp(' ::FFFF:127.0.0.1 ')).toBe(false);
  });
});

describe('IP restriction - when it refuses', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.setRestricted(TABLE_A, true);
  });

  it('refuses a second account arriving from an address already at the table', async () => {
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(true);
  });

  it('matches regardless of case or surrounding whitespace', async () => {
    h.seat(TABLE_A, ALICE, '2001:DB8::1');
    await expect(h.conflict(TABLE_A, BOB, ' 2001:db8::1 ')).resolves.toBe(true);
  });

  it('still refuses when several other players are present', async () => {
    h.seat(TABLE_A, 'cccccccc-0000-0000-0000-000000000003', '198.51.100.4');
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    h.seat(TABLE_A, 'dddddddd-0000-0000-0000-000000000004', '203.0.113.9');
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(true);
  });
});

describe('IP restriction - what must NEVER be refused', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.setRestricted(TABLE_A, true);
    h.setRestricted(TABLE_B, true);
  });

  it('lets the SAME player reconnect from the same address', async () => {
    // A dropped socket stays in the map until the heartbeat sweep, so the
    // player is racing their own stale connection. Refusing here would mean a
    // player who blinked out could never get back to the table.
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    await expect(h.conflict(TABLE_A, ALICE, '24.15.206.254')).resolves.toBe(false);
  });

  it('lets the same player reconnect even with several stale sockets of their own', async () => {
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    await expect(h.conflict(TABLE_A, ALICE, '24.15.206.254')).resolves.toBe(false);
  });

  it('never refuses on an address we could not learn, even against a real one', async () => {
    // Caddy sits in front of the engine. If the forward breaks, every client
    // looks like 127.0.0.1 — and the second arrival at EVERY table would be
    // refused. Silently not enforcing beats locking the room.
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    await expect(h.conflict(TABLE_A, BOB, '127.0.0.1')).resolves.toBe(false);
    await expect(h.conflict(TABLE_A, BOB, '::ffff:127.0.0.1')).resolves.toBe(false);
    await expect(h.conflict(TABLE_A, BOB, 'unknown')).resolves.toBe(false);
    await expect(h.conflict(TABLE_A, BOB, null)).resolves.toBe(false);
  });

  it('does not match two seated players who BOTH have unknown addresses', async () => {
    h.seat(TABLE_A, ALICE, '127.0.0.1');
    await expect(h.conflict(TABLE_A, BOB, '127.0.0.1')).resolves.toBe(false);
  });

  it('ignores a seated player whose address is unknown', async () => {
    h.seat(TABLE_A, ALICE, null);
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(false);
  });

  it('does not look across tables', async () => {
    // Two people in one house at two DIFFERENT tables is not collusion.
    h.seat(TABLE_B, ALICE, '24.15.206.254');
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(false);
  });

  it('allows a different address at the same table', async () => {
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    await expect(h.conflict(TABLE_A, BOB, '198.51.100.4')).resolves.toBe(false);
  });

  it('allows the first arrival at an empty table', async () => {
    await expect(h.conflict(TABLE_A, ALICE, '24.15.206.254')).resolves.toBe(false);
  });
});

describe('IP restriction - the switch itself', () => {
  it('does nothing at all when the table has the switch OFF', async () => {
    // Every table ships with it off; enforcement is opt-in.
    const h = harness();
    h.setRestricted(TABLE_A, false);
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(false);
  });

  it('short-circuits on an unusable address without ever reading the table', async () => {
    // No cache entry seeded: if the flag were read, this would hit the network.
    // It must decide "no conflict" from the address alone.
    const h = harness();
    h.seat(TABLE_A, ALICE, '127.0.0.1');
    await expect(h.conflict(TABLE_A, BOB, '127.0.0.1')).resolves.toBe(false);
  });

  it('uses the current verdict when an owner turns the restriction on or off', async () => {
    const h = harness();
    h.seat(TABLE_A, ALICE, '24.15.206.254');
    h.setRestricted(TABLE_A, false);
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(false);
    h.setRestricted(TABLE_A, true);
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(true);
    h.setRestricted(TABLE_A, false);
    await expect(h.conflict(TABLE_A, BOB, '24.15.206.254')).resolves.toBe(false);
  });
});
