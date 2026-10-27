/**
 * PRESENT IN THE ROOM (2026-10-26). A Lightning hand is played in the player's
 * own pool-session room, so the matcher's presence feed counts only the
 * device that plays the seat: a person's room socket, a horse's anchor engine.
 *
 * Production, before: players converted from MUST MOVE (or sitting back in,
 * or re-entering) were dealt 7.8-9.9 s after entry on the strength of a socket
 * on their ANCHOR table, before they had opened Lightning, and their first
 * hands were folded by the clock at 41-47 s. Fail-closed stays: unknown is
 * never dealt. Horses are present through their own input device, by the
 * same rule (CLAUDE.md 10.5).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { LightningPresence, type PresenceTableReport } from './LightningPresence.js';
import { LightningRegistry } from './LightningRegistry.js';
import { reconcileLightningPresence } from './LightningPresenceReconciliation.js';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLUSTER = uid(1);
const HUMAN = uid(10);
const HORSE = uid(11);
const ROOM_HUMAN = uid(20);
const ROOM_HORSE = uid(21);

/** The anchor engine's report, as ServerTableEngineBase.lightningPresenceReport writes it. */
const anchor = (
  players: Array<{
    userId: string;
    presence: 'connected' | 'disconnected' | 'unknown';
    horse: boolean;
  }>
): PresenceTableReport => ({
  tableId: uid(30),
  clusterId: CLUSTER,
  players: players.map((p) => ({
    userId: p.userId,
    presence: p.presence,
    inputDevice: p.horse,
    ...(p.horse ? { platform: 'desktop' as const } : {}),
  })),
});
/** A Lightning room's report (LightningRegistry.presenceReports). */
const room = (roomId: string, userId: string, connected: boolean): PresenceTableReport => ({
  tableId: roomId,
  clusterId: CLUSTER,
  players: [{ userId, presence: connected ? 'connected' : 'disconnected' }],
});

describe('matching counts the device that plays the Lightning seat', () => {
  it('a person live only on their anchor table is withheld (unknown), never dealt', () => {
    const snap = new LightningPresence(() => [
      anchor([{ userId: HUMAN, presence: 'connected', horse: false }]),
    ]).snapshot(CLUSTER, [HUMAN]);
    expect(snap.connected).toEqual([]);
    expect(snap.unknown).toEqual([HUMAN]);
    expect(snap.pDisconnected).toEqual([HUMAN]);
    // The presence door still sees them as here: no reaper clock starts.
    expect(snap.connectedAnywhere).toEqual([HUMAN]);
  });

  it('the moment a socket is on their room, they are dealt', () => {
    const snap = new LightningPresence(() => [
      anchor([{ userId: HUMAN, presence: 'connected', horse: false }]),
      room(ROOM_HUMAN, HUMAN, true),
    ]).snapshot(CLUSTER, [HUMAN]);
    expect(snap.connected).toEqual([HUMAN]);
    expect(snap.pDisconnected).toEqual([]);
  });

  it('a room with no socket says absent for matching, whatever the anchor page says', () => {
    const snap = new LightningPresence(() => [
      anchor([{ userId: HUMAN, presence: 'connected', horse: false }]),
      room(ROOM_HUMAN, HUMAN, false),
    ]).snapshot(CLUSTER, [HUMAN]);
    expect(snap.disconnected).toEqual([HUMAN]);
    expect(snap.pDisconnected).toEqual([HUMAN]);
    expect(snap.connectedAnywhere).toEqual([HUMAN]);
    expect(snap.disconnectedAnywhere).toEqual([]);
  });

  it('a horse is present through its own input device, the anchor engine, exactly as before', () => {
    const snap = new LightningPresence(() => [
      anchor([{ userId: HORSE, presence: 'connected', horse: true }]),
      // A horse's room registered by a hand host, with no browser on it.
      room(ROOM_HORSE, HORSE, false),
    ]).snapshot(CLUSTER, [HORSE]);
    expect(snap.connected).toEqual([HORSE]);
    expect(snap.pDisconnected).toEqual([]);
  });

  it('one rule for both: a horse whose engine has lost it is withheld like anyone', () => {
    const snap = new LightningPresence(() => [
      anchor([
        { userId: HORSE, presence: 'disconnected', horse: true },
        { userId: HUMAN, presence: 'disconnected', horse: false },
      ]),
    ]).snapshot(CLUSTER, [HORSE, HUMAN]);
    expect(snap.pDisconnected).toEqual([HUMAN, HORSE].sort());
  });

  it('unknown is still never dealt (fail closed)', () => {
    const snap = new LightningPresence(() => []).snapshot(CLUSTER, [HUMAN, HORSE]);
    expect(snap.pDisconnected).toEqual([HUMAN, HORSE].sort());
  });

  it('the anchor engine says which seats it is the input device of, and nothing else changes', () => {
    // The real report: ServerTableEngineBase.lightningPresenceReport.
    const src = readFileSync('src/engine/ServerTableEngineBase.ts', 'utf8');
    const report = sliceMethod(src, 'lightningPresenceReport(): PresenceTableReport {');
    expect(report).toMatch(/inputDevice: !!p\.is_horse,/);
  });
});

describe('the presence door keeps its own view', () => {
  it('the boot reconciliation never stamps away a person who is live on their anchor', async () => {
    const disconnected = vi.fn();
    const reported = await reconcileLightningPresence({
      openSessions: async () => [{ clusterId: CLUSTER, playerId: HUMAN }],
      presenceSource: () => [
        anchor([{ userId: HUMAN, presence: 'connected', horse: false }]),
        room(ROOM_HUMAN, HUMAN, false),
      ],
      report: { disconnected, reconnected: vi.fn() },
    } as never);
    expect(reported).toBe(0);
    expect(disconnected).not.toHaveBeenCalled();
  });

  it('a room whose last socket closes is not reported absent while the anchor sees the player', async () => {
    const disconnected = vi.fn();
    const registry = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async () => ({ playerId: HUMAN, clusterId: CLUSTER }),
      presenceReport: { disconnected, reconnected: vi.fn() } as never,
      anchorPresence: () => [anchor([{ userId: HUMAN, presence: 'connected', horse: false }])],
    });
    await registry.authorize(ROOM_HUMAN, HUMAN);
    registry.connect(ROOM_HUMAN, HUMAN);
    registry.disconnect(ROOM_HUMAN, HUMAN);
    expect(disconnected).not.toHaveBeenCalled();
  });
});

describe('a room with a socket always learns its Cluster', () => {
  it('an owner read that failed at admission is asked again when the socket arrives', async () => {
    let fail = true;
    const roomOwner = vi.fn(async () => {
      if (fail) throw new Error('blip');
      return { playerId: HUMAN, clusterId: CLUSTER };
    });
    const arrivals: string[] = [];
    const reconnected = vi.fn();
    const registry = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner,
      presenceReport: { disconnected: vi.fn(), reconnected } as never,
    });
    registry.setArrivalListener((c) => arrivals.push(c));
    expect((await registry.authorize(ROOM_HUMAN, HUMAN)).allowed).toBe(true);
    // Admitted, but with no Cluster: the room reports nothing to matching.
    expect([...registry.presenceReports()]).toEqual([]);
    fail = false;
    registry.connect(ROOM_HUMAN, HUMAN);
    await new Promise<void>((r) => setImmediate(r));
    expect([...registry.presenceReports()]).toEqual([room(ROOM_HUMAN, HUMAN, true)]);
    // Told exactly as a socket arriving in a known room is told.
    expect(reconnected).toHaveBeenCalledWith(CLUSTER, HUMAN);
    expect(arrivals).toEqual([CLUSTER]);
  });

  it('an owner row naming someone else teaches the room nothing', async () => {
    const registry = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: vi
        .fn()
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValue({ playerId: HORSE, clusterId: CLUSTER }),
    });
    await registry.authorize(ROOM_HUMAN, HUMAN);
    registry.connect(ROOM_HUMAN, HUMAN);
    await new Promise<void>((r) => setImmediate(r));
    expect([...registry.presenceReports()]).toEqual([]);
  });
});
