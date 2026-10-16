import { describe, expect, it, vi } from 'vitest';
import { validateLightningMatchResult } from './LightningRpc.js';
import { LightningClusterWorker } from './LightningClusterWorker.js';
import { LightningPresence } from './LightningPresence.js';
import { parseLightningConfig } from './LightningConfig.js';
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const now = Date.UTC(2026, 9, 15, 12);
const snapshot = () => ({
  nowMs: now,
  epoch: 2,
  recentHands: [],
  players: ids.map((playerId) => ({
    playerId,
    legal: true,
    reasonCode: null,
    idleSinceMs: now - 1000,
    enteredAtMs: now - 2000,
    joinedAtMs: now - 3000,
    slotOpenedAtMs: now - 2000,
    lastBbAtMs: null,
    bbUnresolved: false,
    debtSinceMs: now - 2000,
    handsSinceBb: null,
    newcomer: true,
    positions: { btn: 0, co: 0, hj: 0, utg: 0 },
  })),
});
const raw = () => ({
  matcher_version: 'm1',
  generated_at: new Date(now).toISOString(),
  legal_count: 2,
  groups: [],
  diagnosis: ids.map((player_id) => ({
    player_id,
    state: 'WAITING_FOR_FORMATION',
    reason_code: null,
  })),
  pool_diversity_score: 1,
  shadow_snapshot: { binding: 'a'.repeat(32), snapshot: snapshot() },
});
describe('authoritative matcher snapshot RPC boundary', () => {
  it('carries the validated SQL snapshot through the real worker to the shadow runner', async () => {
    const reply = raw();
    const w = new LightningClusterWorker(
      ids[0],
      parseLightningConfig({
        worker_mode: 'shadow',
        lightning_shadow_matcher: true,
        shadow_matcher_version: 'm1-port',
      }),
      {
        rpc: async () => ({ data: reply, error: null }),
        presence: new LightningPresence(() => [
          {
            tableId: 'anchor',
            clusterId: ids[0],
            players: ids.map((userId) => ({ userId, presence: 'connected' as const })),
          },
        ]),
        now: () => new Date(now),
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      }
    );
    const observe = vi.spyOn(w.shadowRunner, 'observe');
    try {
      expect((await w.pass()).outcome).toBe('matched');
      expect(observe.mock.calls[0][0].authoritativeSnapshot).toEqual(
        reply.shadow_snapshot.snapshot
      );
      expect(observe.mock.calls[0][0].snapshotBinding).toBe(reply.shadow_snapshot.binding);
    } finally {
      observe.mockRestore();
      await w.stop();
    }
  });
  it('preserves PostgreSQL microseconds in the plan clock', () => {
    const input = raw();
    input.generated_at = '2026-10-15T12:00:00.000123Z';
    input.shadow_snapshot.snapshot.nowMs = now + 0.123;
    expect(validateLightningMatchResult(input).ok).toBe(true);
  });
  it('preserves the actual queue snapshot and source binding through the validated result', () => {
    const input = raw();
    const result = validateLightningMatchResult(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as any).authoritativeSnapshot).toEqual(input.shadow_snapshot.snapshot);
      expect((result.value as any).snapshotBinding).toBe(input.shadow_snapshot.binding);
    }
  });
  it.each(['binding', 'clock', 'player', 'cards', 'nonfinite', 'legality'])(
    'refuses malformed %s evidence instead of silently certifying an estimate',
    (mode) => {
      const input: any = raw();
      if (mode === 'binding') input.shadow_snapshot.binding = 'not-a-source-hash';
      if (mode === 'clock') input.shadow_snapshot.snapshot.nowMs += 1;
      if (mode === 'player') input.shadow_snapshot.snapshot.players[0].playerId = 'unknown';
      if (mode === 'cards') input.shadow_snapshot.snapshot.players[0].holeCards = ['As', 'Ah'];
      if (mode === 'legality') input.shadow_snapshot.snapshot.players[0].legal = false;
      if (mode === 'nonfinite') input.shadow_snapshot.snapshot.players[0].idleSinceMs = Infinity;
      expect(validateLightningMatchResult(input).ok).toBe(false);
    }
  );
});
