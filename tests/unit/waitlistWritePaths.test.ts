/**
 * EVERY WRITER AGREES WITH THE WAITLIST INDEX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The partial unique index on table_waitlist covers BOTH active states since
 * the sixty-second seat hold landed:
 *   (table_id, user_id) WHERE status IN ('waiting','notified')
 *
 * Widening it fixed a real hole - a player holding a live offer could open a
 * second queue row on the same table - but it also made writes that used to
 * succeed start returning 23505. There are three writers, and auditing them
 * found two that had not been told:
 *
 *   1. WaitlistService.joinWaitlist  - already correct. Pre-checks both active
 *      states and recovers from 23505 by returning the existing row.
 *   2. WaitlistManager.handleJoin    - a SECOND entry point with no recovery
 *      at all. It reported "Failed to join waitlist" for a player who is
 *      simply already in line, which is the one reading that is certainly
 *      wrong.
 *   3. HorseFleetManager.ensureWaitlist - built its "already queued" set from
 *      status='waiting' only, so a horse in any other active state would be
 *      re-added to a BATCH insert; 23505 throws and loses the whole batch, so
 *      the table silently stops being topped up.
 *
 * These read the sources, because the defect in each case is a missing branch
 * rather than a wrong value - the kind of thing a mocked client would happily
 * pretend was fine.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

describe('waitlist writers agree with the widened unique index', () => {
  it('WaitlistManager.handleJoin treats 23505 as "already in line", not failure', () => {
    const src = read('src/components/waitlist/WaitlistManager.tsx');
    const join = src.slice(src.indexOf('const handleJoin'), src.indexOf('const handleLeave'));
    expect(join).toMatch(/23505/);
    // It must not report a failure for that case.
    const dupBranch = join.slice(join.indexOf('23505'));
    expect(dupBranch).toMatch(/Already On This Waiting List/i);
  });

  it('WaitlistManager.handleJoin still reports genuine failures', () => {
    const src = read('src/components/waitlist/WaitlistManager.tsx');
    const join = src.slice(src.indexOf('const handleJoin'), src.indexOf('const handleLeave'));
    // A non-duplicate error must still throw through to the toast, and be
    // reported - swallowing everything would trade one wrong message for
    // total silence.
    expect(join).toMatch(/throw error/);
    expect(join).toMatch(/Failed to join waitlist/);
    expect(join).toMatch(/reportError/);
  });

  it('the horse seeder counts BOTH active states as already queued', () => {
    const src = read('server/src/services/HorseFleetManager.ts');
    const fn = src.slice(src.indexOf('ensureWaitlist'));
    const select = fn.slice(0, fn.indexOf('const have'));
    // Reading only 'waiting' is the bug: it puts an already-active horse back
    // into a batch insert, and one 23505 loses every row in that batch.
    expect(select).toMatch(/\.in\(\s*'status',\s*\[\s*'waiting',\s*'notified'\s*\]\s*\)/);
    expect(select).not.toMatch(/\.eq\(\s*'status',\s*'waiting'\s*\)/);
  });

  it('WaitlistService.joinWaitlist still pre-checks both active states', () => {
    const src = read('src/services/WaitlistService.ts');
    expect(src).toMatch(/ACTIVE_STATES:\s*WaitlistStatus\[\]\s*=\s*\['waiting',\s*'notified'\]/);
    // and still recovers rather than reporting a lost race as a hard failure
    expect(src).toMatch(/raced/);
  });
});
