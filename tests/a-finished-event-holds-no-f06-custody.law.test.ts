/**
 * LAW: a finished event holds no F06 custody, and a live one keeps all of it.
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-10-02: engine /health showed leaseCustodyRetained.tournaments = 9 for
 * a week. Nine COMPLETED events each kept a dead engine lease because one
 * table break had stopped at close_confirmed (or begun) when the event
 * finished. close_confirmed is OPEN by design: only the live owner's
 * fn_f06_ack_cleanup moves it to acknowledged. But no manager is ever started
 * for a COMPLETED or CANCELLED event again, so nothing could ever acknowledge
 * those rows, and the reaper kept the leases for ever.
 *
 * The fix asks one more question in the operations clause of
 * smarter_private.f06_lease_has_pending_custody: is the event finished
 * (terminal status, prize pool finalized, every table closed, no seat
 * occupied, every entrant eliminated or winner)? This law pins that shape and
 * pins what it must NOT relax.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20261002164430_a_finished_event_holds_no_f06_custody.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');
const code = sql
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n');

const between = (from: string, to: string): string => {
  const a = code.indexOf(from);
  const b = code.indexOf(to, a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return code.slice(a, b);
};

describe('a finished event holds no F06 custody', () => {
  const finished = between(
    'CREATE FUNCTION smarter_private.f06_event_is_finished',
    'REVOKE ALL ON FUNCTION smarter_private.f06_event_is_finished'
  );
  const helper = between(
    'CREATE OR REPLACE FUNCTION smarter_private.f06_lease_has_pending_custody',
    'REVOKE ALL ON FUNCTION smarter_private.f06_lease_has_pending_custody'
  );

  it('"finished" is proven from rows, and unreadable means NOT finished', () => {
    expect(finished).toContain("upper(t.status) IN ('COMPLETED', 'CANCELLED')");
    expect(finished).toContain('COALESCE(t.prize_pool_finalized, false)');
    expect(finished).toContain("lower(COALESCE(tb.status, '')) <> 'closed'");
    expect(finished).toContain('s.player_id IS NOT NULL OR s.left_at IS NULL');
    expect(finished).toContain("NOT IN ('eliminated', 'winner')");
    // a missing event row answers false, which keeps the lease (10.86 rule 1)
    expect(finished).toMatch(/\), false\)\s*\$function\$/);
    // no running state can ever satisfy it
    for (const live of ['RUNNING', 'REGISTERING', 'ANNOUNCED', 'PAUSED']) {
      expect(finished).not.toContain(`'${live}'`);
    }
  });

  it('the finished test applies to OPEN OPERATIONS only', () => {
    expect(helper).toContain('AND NOT smarter_private.f06_event_is_finished(o.tournament_id)');
    expect(helper.match(/f06_event_is_finished/g)).toHaveLength(1);
    // the one terminal definition is still the one asked; no second set
    expect(helper).toContain('smarter_private.f06_terminal_operation_states()');
    expect(helper).not.toMatch(/state\s*<>\s*'acknowledged'/);
    expect(helper).toContain('COALESCE(NOT(o.state=ANY(');
  });

  it('a reserved hand permit and an uncompleted transfer still hold the lease on their own', () => {
    const permit = helper.indexOf("f06_hand_permits h WHERE h.state='reserved'");
    const operations = helper.indexOf('FROM smarter_private.f06_operations o');
    expect(permit).toBeGreaterThan(0);
    // the permit clause is not conditioned on the event being finished
    expect(helper.slice(permit, operations)).not.toContain('f06_event_is_finished');
    expect(helper).toContain('f06_manager_custody_completions c WHERE c.transfer_id=t.transfer_id');
    const transfers = helper.slice(helper.indexOf('f06_manager_custody_transfers'));
    expect(transfers).not.toContain('f06_event_is_finished');
  });

  it('refuses to install over a changed preimage, and proves no live event lost custody', () => {
    expect(code).toContain('F06_CUSTODY_PREDICATE_PREIMAGE_CHANGED');
    expect(code).toContain('F06_TERMINAL_SET_CHANGED');
    expect(code).toContain('F06_OPERATION_STATE_MACHINE_CHANGED');
    expect(code).toContain('F06_LIVE_EVENT_LOST_CUSTODY');
    expect(code).toMatch(/^BEGIN;/m);
    expect(code).toMatch(/^COMMIT;/m);
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
  });

  it('the new predicate is private', () => {
    expect(code).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_event_is_finished(uuid)\n  FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(code).not.toMatch(/GRANT[^;]*f06_event_is_finished/);
  });
});
