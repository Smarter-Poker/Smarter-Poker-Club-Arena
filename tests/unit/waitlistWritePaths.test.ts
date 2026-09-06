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

  it('the horse seeder no longer queues horses at all, and the two reads that remain differ on purpose', () => {
    const src = read('server/src/services/HorseFleetManager.ts');

    /* ── THIS PIN WAS VACUOUS (2026-09-06) ────────────────────────────────
       It read `src.slice(src.indexOf('ensureWaitlist'))` and then
       `.indexOf('const have')`. `ensureWaitlist` was DELETED when Dan ruled
       that horses do not queue (2026-09-02) - the only occurrences left are
       two words inside comments explaining the deletion - and `const have`
       went with it, so `indexOf` returned -1 and the slice was "everything
       after that comment, minus one character": most of a 3,800-line file.
       The assertion therefore passed on any file that happened not to contain
       `.eq('status', 'waiting')` ANYWHERE, and went red the moment a fix
       three hundred lines away used that phrase legitimately. A pin that
       cannot fail for its own reason is not a pin.

       What is actually true is worth pinning, so this now pins it. */
    expect(src).not.toMatch(/private async ensureWaitlist\(/);

    /* humansWaitingByTable counts BOTH active states. A `notified` human is a
       person whose seat is already being held, so the seat is spoken for and
       leaving them out would have the fleet fill the very chair the queue is
       about. */
    const humans = src.slice(
      src.indexOf('private async humansWaitingByTable('),
      src.indexOf('private async pruneHorseWaitlist(')
    );
    expect(humans).toMatch(/\.in\(\s*'status',\s*\[\s*'waiting',\s*'notified'\s*\]\s*\)/);

    /* pruneHorseWaitlist clears ONLY `waiting`. A `notified` row is an OFFER
       the platform made to that horse through fn_offer_open_seat, and this
       method runs BEFORE claimOfferedSeats in the same cycle - so clearing
       `notified` here was the platform withdrawing its own offer, and it made
       "MAKE HORSES ANSWER A SEAT CALL" (Dan 2026-08-31) unreachable in the one
       direction Law 10.5 forbids: a human's offer stood and a horse's did not. */
    const prune = src.slice(
      src.indexOf('private async pruneHorseWaitlist('),
      src.indexOf('private resolveSeatClub(')
    );
    expect(prune).toMatch(/\.eq\(\s*'status',\s*'waiting'\s*\)/);
    expect(prune).not.toMatch(/'notified'/);
  });

  it('WaitlistService.joinWaitlist still pre-checks both active states', () => {
    const src = read('src/services/WaitlistService.ts');
    expect(src).toMatch(/ACTIVE_STATES:\s*WaitlistStatus\[\]\s*=\s*\['waiting',\s*'notified'\]/);
    // and still recovers rather than reporting a lost race as a hard failure
    expect(src).toMatch(/raced/);
  });
});
