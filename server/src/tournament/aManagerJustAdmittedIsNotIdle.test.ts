/**
 * A MANAGER JUST ADMITTED IS NOT IDLE (2026-09-26)
 *
 * The never-dealt sweep in GameServer releases the manager of a RUNNING event
 * whose tables have no hand_history row and whose started_at is older than 15
 * minutes. started_at is the EVENT's start, not the manager's. Event e9c07fe8
 * ("3 Chip Deep Stack Spin PLO4", started 2026-09-18) was continued at
 * 14:15:22Z today and its fresh manager began the Spin reveal hold (~13.5 s)
 * before the first deal; the sweep, every ~14 s, read "started 09-18, no hand"
 * and retired each new manager before it could deal, leaving a reserved hand
 * permit behind each time (production 14:16-14:17Z: six releases in 72 s).
 *
 * A manager is idle only once IT has had the same 15 minutes to deal.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameServer } from '../GameServer.js';

const SRC = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');

describe('a manager just admitted is not idle', () => {
  it('holds a manager admitted inside the never-dealt window, releases one past it', () => {
    const server = Object.create(GameServer.prototype) as any;
    const admitted = new WeakMap<object, number>();
    Object.assign(server, { tournamentManagerAdmittedAtMs: admitted });
    const fresh = {};
    const old = {};
    const unknown = {};
    const now = 1_790_000_000_000;
    admitted.set(fresh, now - 14 * 1000);
    admitted.set(old, now - 16 * 60 * 1000);
    expect(server.neverDealtManagerHadItsWindow(fresh, now)).toBe(false);
    expect(server.neverDealtManagerHadItsWindow(old, now)).toBe(true);
    // A manager whose admission was never recorded keeps the old behaviour.
    expect(server.neverDealtManagerHadItsWindow(unknown, now)).toBe(true);
  });

  it('records the admission where the manager is installed and consults it before retiring', () => {
    expect(SRC).toMatch(
      /this\.tournamentEngines\.set\(tournamentId, manager\);\n\s+this\.tournamentManagerAdmittedAtMs\?\.set\(manager, Date\.now\(\)\);/
    );
    const sweep = SRC.slice(
      SRC.indexOf('const neverDealtCutoff'),
      SRC.indexOf("'GameServer.never_dealt_stop_engine'")
    );
    expect(sweep).toContain('this.neverDealtManagerHadItsWindow(idleNeverDealtTm, Date.now())');
    expect(sweep.indexOf('neverDealtManagerHadItsWindow')).toBeLessThan(
      sweep.indexOf('this.retireTournamentManagerInDiscovery(')
    );
  });
});
