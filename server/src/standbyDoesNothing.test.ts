/**
 * A STANDBY MUST DECIDE BEFORE IT TOUCHES ANYTHING.
 *
 * The first version of leader/standby resolved leadership AFTER
 * cleanupStaleData(). Running it for real showed why that is wrong. From the
 * standby's own log on 2026-08-23:
 *
 *     [HorseMind] DB pair hydration: 19980/20000 targeting pairs restored in 8772ms
 *     [GameServer] Closed 10 orphaned tournament tables and released their seats
 *     [GameServer] Stale data cleanup complete
 *     [leadership] claim failed (supabase_timeout) - holding role 'standby'
 *
 * It had closed ten tournament tables and released their seats -- shared state,
 * mutated by an instance that then discovered it was not supposed to be doing
 * anything. It also took so long to get there that it failed its healthcheck
 * and autoheal restarted it, starting the sequence again.
 *
 * cleanupStaleData closes tables, releases seats and resets horses. That is
 * recovery work belonging to exactly one process: the one that owns the fleet.
 *
 * This is a source-order guard rather than a behavioural test because the thing
 * being protected IS the order, and the alternative is booting a real
 * GameServer against a real database to observe it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceEnclosingBlock } from './testHelpers/sourceWindow.js';

const SRC = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');

describe('start() resolves leadership before it touches anything', () => {
  it('decides the role before cleanupStaleData', () => {
    const decide = SRC.indexOf('await renewLeadership()');
    const cleanup = SRC.indexOf('await this.cleanupStaleData(');
    expect(decide, 'leadership check missing from start()').toBeGreaterThan(-1);
    expect(cleanup, 'cleanupStaleData missing from start()').toBeGreaterThan(-1);
    // The whole point: a standby returns before any shared state is mutated.
    expect(decide).toBeLessThan(cleanup);
  });

  it('returns immediately when it is a standby', () => {
    const decide = SRC.indexOf('await renewLeadership()');
    const window = sliceEnclosingBlock(SRC, 'await renewLeadership()');
    expect(window).toMatch(/role === 'standby'/);
    expect(window).toMatch(/return;/);
  });

  it('the standby return happens before cleanupStaleData too', () => {
    const decide = SRC.indexOf('await renewLeadership()');
    const cleanup = SRC.indexOf('await this.cleanupStaleData(');
    const ret = SRC.indexOf('return;', decide);
    expect(ret).toBeGreaterThan(decide);
    expect(ret).toBeLessThan(cleanup);
  });
});
