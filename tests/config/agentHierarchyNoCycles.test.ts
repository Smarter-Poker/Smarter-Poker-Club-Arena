/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CYCLE IN THE AGENT HIERARCHY MUST BE IMPOSSIBLE TO CREATE (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * club_members.agent_id holds the UPLINE'S USER ID and is the single edge every
 * downline query walks: fn_club_cashier_members, fn_club_is_in_downline,
 * fn_club_cashier_can_transact - and therefore fn_agent_wallet_send's refusal
 * itself. A cycle (A uplines B, B uplines A) makes "who is above this player"
 * a question with no answer.
 *
 * THIS IS A GUARD, NOT A REPAIR. Every recursive query in this codebase is
 * already cycle-SAFE (each carries a visited-path array and a depth cap), and
 * production held ZERO cycles when this was written. What was missing was
 * anything stopping one from being created - by a future feature, a bulk
 * re-assign, or a direct write.
 *
 * CI has no database, so this reads the migration that defines the guard, the
 * same technique tests/config/roleScopedCashier.test.ts uses and for the same
 * reason: the failure mode is a MISSING LINE in a function that otherwise reads
 * perfectly.
 *
 * IT WAS ALSO PROVEN AGAINST THE LIVE DATABASE before this shipped, on a real
 * agent edge inside a transaction that was then rolled back:
 *   self parenting  → refused, 23514 "a member cannot be their own upline"
 *   a cycle         → refused, 23514 "that would close a cycle in club ..."
 *   a legitimate re-parent onto a third member of the same club → ALLOWED
 * The rows were re-read afterwards and were unchanged.
 *
 * WHAT THIS CANNOT CATCH: a migration committed and never applied. That is
 * scripts/ci/check-migrations-applied.mjs, which compares what a branch
 * declares against the live schema manifest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SQL = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260825700000_club_members_agent_id_no_cycles.sql'),
  'utf8'
);

// ───────────────────────────────────────────────────────────────────────────
describe('the guard exists and is attached to the write', () => {
  it('declares the trigger function', () => {
    expect(SQL).toContain('create or replace function public.fn_club_members_no_agent_cycle()');
    expect(SQL).toContain('returns trigger');
  });

  it('fires BEFORE the row lands, on insert and on an agent_id update', () => {
    // BEFORE, because a guard that runs after the write has already let the
    // cycle exist for the length of the statement.
    expect(SQL).toMatch(/create trigger trg_club_members_no_agent_cycle_ins\s+before insert on/);
    expect(SQL).toMatch(
      /create trigger trg_club_members_no_agent_cycle_upd\s+before update of agent_id on/
    );
    expect(SQL).toContain('for each row');
  });

  it('costs nothing when agent_id is not the thing being changed', () => {
    // `update of agent_id` plus the WHEN clause. Without both, every balance
    // update, role change and status change on club_members pays for the walk.
    expect(SQL).toContain('before update of agent_id on public.club_members');
    expect(SQL).toContain(
      'when (new.agent_id is not null and new.agent_id is distinct from old.agent_id)'
    );
    // The INSERT trigger cannot carry an OLD reference at all (42P17), which is
    // why there are two triggers over one function rather than one over both.
    expect(SQL).toContain('when (new.agent_id is not null)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('what it refuses', () => {
  it('self parenting: agent_id = user_id', () => {
    expect(SQL).toContain('if new.agent_id = new.user_id then');
    expect(SQL).toMatch(/a member cannot be their own upline/);
  });

  it('a cycle: the proposed parent already sits beneath the row being edited', () => {
    // Walk UP from the proposed parent; arriving back at the row closes a loop.
    expect(SQL).toContain('v_cursor := new.agent_id;');
    expect(SQL).toContain('if v_cursor = new.user_id then');
    expect(SQL).toMatch(/that would close a cycle in club/);
  });

  it('and raises a CHECK VIOLATION, not a bare exception', () => {
    // 23514 so a caller can tell a rule refusal from a crash.
    expect(SQL.match(/using errcode = '23514'/g) ?? []).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('what it allows, and what it costs', () => {
  it('clearing the upline can never close a loop, so it returns immediately', () => {
    expect(SQL).toMatch(/if new\.agent_id is null then\s+return new;/);
  });

  it('a legitimate re-parent falls out of the loop and returns new', () => {
    // The walk exits the moment the chain leaves the club's membership.
    expect(SQL).toContain('if not found then');
    expect(SQL).toMatch(/exit;/);
    expect(SQL.trimEnd()).toMatch(/return new;[\s\S]*\$function\$/);
  });

  it('is club scoped: agent_id is meaningless across clubs', () => {
    expect(SQL).toContain('where cm.club_id = new.club_id');
    expect(SQL).toContain('and cm.user_id = v_cursor');
  });

  it('is depth capped, so an ALREADY malformed graph cannot spin the trigger', () => {
    expect(SQL).toContain('v_hops < 64');
    expect(SQL).toContain('if v_hops >= 64 then');
    // And a chain it could not verify is refused rather than waved through.
    expect(SQL).toMatch(/deeper than 64 levels or already loops/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the migration proves it created something', () => {
  it('post-checks that both triggers exist', () => {
    expect(SQL).toContain('post-check: expected 2 cycle guard triggers on club_members');
  });

  it('and that each is BEFORE, on a ROW, for the right event', () => {
    // A guard created AFTER, or one that lost its UPDATE OF clause, looks
    // identical from the outside until a cycle lands.
    expect(SQL).toContain('post-check: insert guard is not BEFORE INSERT FOR EACH ROW');
    expect(SQL).toContain('post-check: update guard is not BEFORE UPDATE FOR EACH ROW');
  });

  it('carries its own rollback', () => {
    expect(SQL).toContain('drop trigger if exists trg_club_members_no_agent_cycle_ins');
    expect(SQL).toContain('drop function if exists public.fn_club_members_no_agent_cycle()');
  });
});
