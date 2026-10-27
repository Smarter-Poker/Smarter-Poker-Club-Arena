import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { tournamentEliminationScheduler } from './TournamentEliminationScheduler.js';
import type { GameServer } from '../GameServer.js';

const unregister: Array<() => void> = [];
const eventId = '00000000-0000-4000-8000-000000009917';
function manager() {
  const acknowledgeTournamentManagerWakes = vi.fn();
  const value = new TournamentManager(eventId, {
    acknowledgeTournamentManagerWakes,
  } as unknown as GameServer) as any;
  value.running = true;
  return { value, acknowledgeTournamentManagerWakes };
}
afterEach(() => {
  for (const remove of unregister.splice(0)) remove();
  vi.restoreAllMocks();
});

describe('a refused scheduler wake retains its original durable work', () => {
  it("serves the exact retained identity and generation in registration's causal first admission", async () => {
    const { value } = manager();
    // The manager can receive the committed wake before its scheduler entry exists.
    expect(value.requestEliminationSweep('late_registration', 990171, 4)).toBe(false);
    expect([...value.pendingManagerWakes]).toEqual([[990171, 'late_registration']]);
    expect([...value.pendingManagerWakeGenerations]).toEqual([[990171, 4]]);
    const captured: unknown[] = [];
    unregister.push(
      tournamentEliminationScheduler.register({
        tournamentId: eventId,
        run: async () => {
          captured.push({
            reasons: [...value.pendingManagerWakes],
            generations: [...value.pendingManagerWakeGenerations],
          });
        },
      })
    );
    await vi.waitFor(() =>
      expect(captured).toEqual([
        {
          reasons: [[990171, 'late_registration']],
          generations: [[990171, 4]],
        },
      ])
    );
  });

  it('retains the newest generation through repeated refused deliveries', () => {
    const { value } = manager();
    expect(value.requestEliminationSweep('late_registration', 990171, 4)).toBe(false);
    expect(value.requestEliminationSweep('late_registration', 990171, 3)).toBe(false);
    expect(value.requestEliminationSweep('late_registration', 990171, 5)).toBe(false);
    expect([...value.pendingManagerWakes]).toEqual([[990171, 'late_registration']]);
    expect([...value.pendingManagerWakeGenerations]).toEqual([[990171, 5]]);
  });

  it('does not invent receipts for ordinary wakes or invalid identities', () => {
    const { value } = manager();
    expect(value.requestEliminationSweep('engine.resume')).toBe(false);
    for (const id of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(value.requestEliminationSweep('late_registration', id, 4)).toBe(false);
    }
    expect(value.pendingManagerWakes.size).toBe(0);
    expect(value.pendingManagerWakeGenerations.size).toBe(0);
  });

  it('does not acknowledge retained work when the manager is stopped', async () => {
    const { value, acknowledgeTournamentManagerWakes } = manager();
    value.requestEliminationSweep('late_registration', 990171, 4);
    value.running = false;
    await value.runEliminationSweep(new AbortController().signal);
    expect(acknowledgeTournamentManagerWakes).not.toHaveBeenCalled();
    expect([...value.pendingManagerWakes]).toEqual([[990171, 'late_registration']]);
    expect([...value.pendingManagerWakeGenerations]).toEqual([[990171, 4]]);
  });
});
