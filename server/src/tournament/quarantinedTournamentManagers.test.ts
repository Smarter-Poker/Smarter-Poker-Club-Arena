import { describe, it, expect } from 'vitest';
import {
  classifyTournamentOwner,
  QUARANTINE_FIRST_RETRY_MS,
  QUARANTINE_RETRY_CAP_MS,
  QuarantinedTournamentManagers,
  quarantineRetryDelayMs,
} from './quarantinedTournamentManagers.js';

describe('classifyTournamentOwner: three outcomes, not two', () => {
  it('a registered manager that owns its lease is the only "owned"', () => {
    expect(
      classifyTournamentOwner({
        managerRegistered: true,
        managerOwnsLease: true,
        admissionInFlight: false,
      })
    ).toBe('owned');
  });

  it('a registered manager that owns NO lease is quarantined, never owned', () => {
    // The whole incident: `tournamentEngines.has(id)` answered yes for six
    // corpses and the re-adoption lane read that as "somebody is dealing it".
    expect(
      classifyTournamentOwner({
        managerRegistered: true,
        managerOwnsLease: false,
        admissionInFlight: false,
      })
    ).toBe('quarantined');
    expect(
      classifyTournamentOwner({
        managerRegistered: true,
        managerOwnsLease: false,
        admissionInFlight: true,
      })
    ).toBe('quarantined');
  });

  it('an empty slot is admitting or unowned, and those are different answers', () => {
    expect(
      classifyTournamentOwner({
        managerRegistered: false,
        managerOwnsLease: false,
        admissionInFlight: true,
      })
    ).toBe('admitting');
    expect(
      classifyTournamentOwner({
        managerRegistered: false,
        managerOwnsLease: false,
        admissionInFlight: false,
      })
    ).toBe('unowned');
  });
});

describe('quarantineRetryDelayMs', () => {
  it('doubles from the first step and never exceeds the cap', () => {
    expect(quarantineRetryDelayMs(1)).toBe(QUARANTINE_FIRST_RETRY_MS);
    expect(quarantineRetryDelayMs(2)).toBe(QUARANTINE_FIRST_RETRY_MS * 2);
    expect(quarantineRetryDelayMs(3)).toBe(QUARANTINE_FIRST_RETRY_MS * 4);
    expect(quarantineRetryDelayMs(99)).toBe(QUARANTINE_RETRY_CAP_MS);
  });

  it('a nonsense streak reads as the first step, never as a NaN deadline', () => {
    expect(quarantineRetryDelayMs(Number.NaN)).toBe(QUARANTINE_FIRST_RETRY_MS);
    expect(quarantineRetryDelayMs(0)).toBe(QUARANTINE_FIRST_RETRY_MS);
    expect(quarantineRetryDelayMs(-5)).toBe(QUARANTINE_FIRST_RETRY_MS);
  });
});

describe('QuarantinedTournamentManagers', () => {
  const owner = { id: 'manager-a' };
  const other = { id: 'manager-b' };

  it('holds a failed stop, ages it, and backs its retry off', () => {
    const held = new QuarantinedTournamentManagers();
    expect(held.size).toBe(0);
    expect(held.due(1_000)).toEqual([]);

    const first = held.record('t1', 'stop_failed', 1_000, owner);
    expect(first).toBe(QUARANTINE_FIRST_RETRY_MS);
    expect(held.has('t1')).toBe(true);
    expect(held.heldBy('t1')).toBe(owner);
    // Not due before its delay, due after it.
    expect(held.due(1_000 + QUARANTINE_FIRST_RETRY_MS - 1)).toEqual([]);
    expect(held.due(1_000 + QUARANTINE_FIRST_RETRY_MS)).toEqual(['t1']);

    const second = held.record('t1', 'stop_failed', 2_000, owner);
    expect(second).toBe(QUARANTINE_FIRST_RETRY_MS * 2);
    // The AGE survives the retry: it dates from the first failure, which is
    // the number that says "this has been stuck for a week".
    expect(held.oldestAgeMs(9_000)).toBe(8_000);
  });

  it('a different manager stuck on the same tournament is a NEW quarantine', () => {
    // Otherwise a replacement inherits a corpse's age and its backoff, and its
    // first retry lands straight on the cap.
    const held = new QuarantinedTournamentManagers();
    held.record('t1', 'stop_failed', 1_000, owner);
    held.record('t1', 'stop_failed', 2_000, owner);
    const delay = held.record('t1', 'stop_failed', 50_000, other);
    expect(delay).toBe(QUARANTINE_FIRST_RETRY_MS);
    expect(held.oldestAgeMs(50_000)).toBe(0);
    expect(held.heldBy('t1')).toBe(other);
  });

  it('settle is identity-exact: a replacement manager ends the quarantine', () => {
    const held = new QuarantinedTournamentManagers();
    held.record('t1', 'stop_failed', 1_000, owner);
    held.record('t2', 'stop_failed', 1_000, other);
    // t1's slot now holds somebody else; t2 still holds its own corpse.
    const live = new Map<string, unknown>([
      ['t1', { id: 'a-healthy-replacement' }],
      ['t2', other],
    ]);
    held.settle((id) => live.get(id) === held.heldBy(id));
    expect(held.has('t1')).toBe(false);
    expect(held.has('t2')).toBe(true);
    expect(held.size).toBe(1);
  });

  it('forget releases, and an empty registry reports a zero age', () => {
    const held = new QuarantinedTournamentManagers();
    held.record('t1', 'stop_failed', 1_000, owner);
    held.forget('t1');
    expect(held.size).toBe(0);
    expect(held.oldestAgeMs(99_000)).toBe(0);
    expect(held.snapshot(99_000)).toEqual([]);
  });

  it('due and snapshot are oldest first, so the worst case is read first', () => {
    const held = new QuarantinedTournamentManagers();
    held.record('younger', 'stop_failed', 5_000, owner);
    held.record('older', 'stop_failed', 1_000, other);
    expect(held.due(1_000_000)).toEqual(['older', 'younger']);
    expect(held.snapshot(1_000_000).map((row) => row.tournamentId)).toEqual(['older', 'younger']);
  });

  it('the custody refusal survives a retry record and starts empty for a new owner', () => {
    // The retry pass records the attempt BEFORE the transfer runs, with no
    // refusal of its own; it must not blank what the previous transfer said.
    const held = new QuarantinedTournamentManagers();
    held.record('t1', 'stop_failed', 1_000, owner, 'mixed:nothing_to_transfer');
    held.record('t1', 'retry', 2_000, owner);
    expect(held.snapshot(3_000)[0]).toMatchObject({
      custodyRefusal: 'mixed:nothing_to_transfer',
      attempts: 2,
    });
    held.record('t1', 'stop_failed', 3_000, owner, 'transfer:packet_not_current');
    expect(held.snapshot(3_000)[0].custodyRefusal).toBe('transfer:packet_not_current');
    held.record('t1', 'stop_failed', 4_000, owner, null);
    expect(held.snapshot(4_000)[0].custodyRefusal).toBeNull();
    held.record('t1', 'stop_failed', 5_000, owner, 'mixed:successor_is_origin');
    held.record('t1', 'stop_failed', 6_000, other);
    expect(held.snapshot(6_000)[0]).toMatchObject({ custodyRefusal: null, attempts: 1 });
  });

  it('the snapshot carries the age and the reason an operator needs', () => {
    const held = new QuarantinedTournamentManagers();
    held.record('t1', 'GameServer.tournament_lease_lost_stop_failed', 1_000, owner);
    const [row] = held.snapshot(61_000);
    expect(row.tournamentId).toBe('t1');
    expect(row.reason).toBe('GameServer.tournament_lease_lost_stop_failed');
    expect(row.attempts).toBe(1);
    expect((row as unknown as { ageMs: number }).ageMs).toBe(60_000);
  });
});
