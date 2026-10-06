/**
 * THE OUTBOX DRAIN DRAINS WHAT WAS PENDING
 *
 * Measured on production 2026-10-03 (docs/changelog/2026-10-03-the-outbox-
 * drain-drains-what-was-pending.md): sp_drain_daily_challenge_event_outbox ran
 * four shards a minute under a 45 s budget whose only early exit was the shard
 * picker finding nothing. Events arrive at ~7/s, so that exit was unreachable
 * and every run burned its budget - 17.13 s average over 720 runs, 89 of them
 * at the ceiling, 1.135 cores of the primary held continuously - for 2.9 s of
 * work (rolled-back probe: 155 iterations, 307 events, all booked, picker
 * exhausted in 2,875 ms). Migration 20261003014941 binds the picker to the
 * run's own entry instant, so a run finishes the backlog it found and the next
 * minute takes the next one. The probe of the changed loop booked 2.91 events
 * per per-player transaction against 1.98.
 *
 * This pins the watermark, that it is derived from the existing deadline rather
 * than a new clock read (the two must not drift apart), that the substitution
 * stays asserted at both hashes, and that the repair changed no timeout, lock
 * patience, schedule or grant.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_the_outbox_drain_drains_what_was_pending.sql'))
  .at(-1);
if (!NAME) throw new Error('the outbox-drain-watermark migration is missing');
const MIG = migrationText(NAME);
const SUBS = sliceBetween(MIG, 'DO $subs$', 'END $subs$;');

const BEFORE_MD5 = '61635cfbedf05addc77a53c781963b68';
const AFTER_MD5 = '8d827eb13fb07f3d212ff3af839819f6';

describe('the outbox drain drains what was pending', () => {
  it('is one transaction with a bounded lock wait', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toMatch(/SET LOCAL lock_timeout = '2s';/);
    expect(MIG).not.toMatch(/CONCURRENTLY/);
  });

  it('pins the live procedure text going in and the derived text coming out', () => {
    expect(SUBS).toContain(`'${BEFORE_MD5}'`);
    expect(SUBS).toContain(`'${AFTER_MD5}'`);
    expect(SUBS).toContain('is not the pinned text');
    expect(SUBS).toContain('is not the derived text');
    // The reverse substitution is what proves the delta is the only change.
    expect(SUBS).toContain('the reverse substitution does not reproduce the pinned text');
    expect(SUBS).toContain('owner, security or grants moved');
    expect(SUBS).toContain('the clause to change occurs');
  });

  it('adds the arrival watermark to the shard picker, bound as a parameter', () => {
    expect(SUBS).toContain('AND o.created_at <= $1');
    expect(SUBS).toContain('INTO v_user_id USING (v_deadline - c_budget)');
  });

  it('derives the watermark from the existing deadline, never a second clock read', () => {
    // v_deadline is clock_timestamp() + c_budget, so v_deadline - c_budget is
    // the run's entry instant exactly. A fresh clock_timestamp() in the loop
    // would advance every iteration and the exit would stop being reachable.
    const added = sliceBetween(SUBS, 'AS x(signature', 'LOOP');
    expect(added).not.toMatch(/clock_timestamp\(\)/);
    expect(added).not.toMatch(/\bnow\(\)\s*-\s*interval\s*'0/);
    expect(SUBS).not.toMatch(/v_cutoff/);
  });

  it('keeps the four per-minute postgres shard jobs as the only caller', () => {
    expect(SUBS).toContain("username = 'postgres'");
    expect(SUBS).toContain("schedule = '* * * * *'");
    expect(SUBS).toContain('the four per-minute outbox shard jobs are not as pinned');
  });

  it('changes no timeout a role runs under, no grant, no schedule and no horse', () => {
    expect(MIG).not.toMatch(/ALTER ROLE/i);
    expect(MIG).not.toMatch(/set_config\(\s*'statement_timeout'/);
    expect(MIG).not.toMatch(/\bGRANT\b/);
    expect(MIG).not.toMatch(/cron\.schedule|cron\.unschedule/);
    expect(MIG).not.toMatch(/is_horse/);
    // The budget, the per-player batch and the backoff are not what was wrong.
    expect(SUBS).not.toMatch(/c_budget constant/);
    expect(SUBS).not.toMatch(/c_user_batch/);
    expect(SUBS).not.toMatch(/next_attempt_at\s*=/);
  });

  it('is not a repair job, a sweep or a detector', () => {
    expect(MIG).not.toMatch(/_repair_|_backpay_|_redrive_|_sweep_|_catchup_|_heal_/);
    expect(MIG).not.toMatch(/financial_alerts/);
  });

  it('records the measurement beside the change', () => {
    expect(MIG).toContain('1.135');
    expect(MIG).toContain('17.13');
    expect(MIG).toContain('2,875 ms');
    expect(MIG).toMatch(/multixact_member_buffers/);
  });
});
