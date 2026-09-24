/**
 * A LEASE GENERATION KEEPS THE HAND IT RESERVED
 * (2026-09-24, BINDING)
 *
 * Owner policy v2.9 (Dan, 2026-09-22): fix a defect at its root cause and then
 * harden it, and never add or rely on a cron, watcher, reconciler or repair
 * loop to compensate for one.
 *
 * WHAT WENT WRONG. A tournament hand is authorised by one
 * smarter_private.f06_hand_permits row in state 'reserved', written under the
 * tournament's lease generation, and smarter_private.f06_one_hand is a UNIQUE
 * index on (table_id) WHERE state = 'reserved'. A table admits one reserved
 * permit and no more, so an unresolved one ends that table for good.
 *
 * public.claim_tournament_lease_v2 takes a lease that has not been heartbeated
 * for 30 seconds and writes lease_generation = EXCLUDED.lease_generation in
 * place. The outgoing generation's uuid lived in two places, the lease row and
 * the permit. After that update it survives only on a permit nothing can now
 * reach, because public.fn_f06_abort_abandoned_generation - the one door that
 * voids an abandoned generation - takes the generation by name.
 *
 * Measured on production 2026-09-24 12:51 to 13:02 UTC:
 *
 *   tournaments RUNNING with started_at over 24 hours old            423
 *   open table_seats they hold, across 863 players                 3,138
 *   reserved permits on the platform                                 527
 *   of those, on a tournament that is RUNNING                        527
 *   of those, on a tournament CANCELLED or COMPLETED                   0
 *   reserved permits whose generation no lease row names             489
 *   of those 489, whose tournament still HAS a lease row             489
 *   of those 489, whose tournament has no lease row at all             0
 *
 * Every orphan was made by replacement, none by release. And no reserved permit
 * anywhere belongs to a tournament that reached a terminal status, which is why
 * refusing this takes no working path away: nothing has ever come back from it.
 *
 * WHY NO RECOVERY JOB SEES THEM, each excluded by its own predicate:
 * fn_crash_sweep_abandoned reads crash_rounds joined to diamond_game_configs on
 * game = 'crash', the casino game, and never names tournaments;
 * fn_ca_tournament_finished_but_not_completed keys on alive <= 1 and these have
 * 2 to 306; fn_ca_tournament_conservation_confirm keys on v_hands >
 * v_prev.hands_dealt, so a tournament that deals nothing can never be
 * confirmed; fn_ca_escrow_ttl_sweep reads chip_escrow_holds; and
 * fn_flag_garbage_tournaments updates venue_daily_tournaments on name text.
 *
 * THE LAW. A lease row may not stop naming a generation that still holds a
 * reserved hand. Refused, the handover rolls back and the lease goes on naming
 * the outgoing generation, which is precisely what the abort door needs. The
 * guard preserves the only state the existing writer can still finish from.
 *
 * IT MUST STAY DEFERRED. A transaction that resolves the permit and hands the
 * event on does both, in an order this has no business dictating. Read
 * immediately it would judge a half-built transaction. DEFERRABLE INITIALLY
 * DEFERRED asks at COMMIT and judges the state left behind.
 *
 * THE WHEN CLAUSES ARE LOAD-BEARING. heartbeat_tournament_leases_v4 updates
 * hundreds of rows every few seconds and changes no generation. Without the
 * discriminator in the WHEN clause every heartbeat would queue a deferred
 * event on a busy engine.
 *
 * A TERMINAL TOURNAMENT IS EXEMPT, because a cancelled or completed event
 * releases its lease on purpose and that is the path a refund travels.
 *
 * Every negative below is asserted against comment-stripped SQL, because this
 * header names the very things it forbids.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const MIGRATION = '20260924130148_a_lease_generation_keeps_the_hand_it_reserved.sql';
const ON_REPLACE = 'a_lease_generation_keeps_the_hand_it_reserved';
const ON_RELEASE = 'a_released_lease_generation_keeps_the_hand_it_reserved';
const GUARD_FN = 'fn_lease_generation_keeps_its_reserved_hand';

/** SQL with block and line comments removed; dollar-quoted bodies are kept. */
function sqlCode(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function migration(name: string): string {
  const hit = migrationCorpus().find((m) => m.name === name);
  expect(hit, `${name} is missing from supabase/migrations`).toBeDefined();
  return hit!.sql;
}

const RAW = migration(MIGRATION);
const CODE = sqlCode(RAW);
const HEADER = RAW.slice(0, RAW.indexOf('BEGIN;'));

/** The last CREATE or DROP of `trigger` anywhere in the corpus, in code. */
function lastTriggerStatement(trigger: string): { file: string; statement: string } {
  const pattern = new RegExp(
    String.raw`(?:CREATE\s+(?:CONSTRAINT\s+)?TRIGGER|DROP\s+TRIGGER(?:\s+IF\s+EXISTS)?|(?:ENABLE|DISABLE)\s+TRIGGER)\s+${trigger}\b[\s\S]*?;`,
    'gi'
  );
  let last: { file: string; statement: string } | null = null;
  for (const m of migrationCorpus()) {
    if (!m.sql.includes(trigger)) continue;
    for (const hit of sqlCode(m.sql).matchAll(pattern)) {
      last = { file: m.name, statement: hit[0] };
    }
  }
  expect(last, `no migration names trigger ${trigger} in code`).not.toBeNull();
  return last!;
}

/** The dollar-quoted body of the guard function, from code. */
function guardBody(): string {
  const at = CODE.search(
    new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.${GUARD_FN}\s*\(`, 'i')
  );
  expect(at, `${GUARD_FN} is not declared in ${MIGRATION}`).toBeGreaterThan(-1);
  const tail = CODE.slice(at);
  const open = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(tail);
  expect(open, `${GUARD_FN} has no dollar-quoted body`).not.toBeNull();
  const start = open!.index + open![0].length;
  const end = tail.indexOf(open![1], start);
  expect(end, `${GUARD_FN} never closes ${open![1]}`).toBeGreaterThan(-1);
  return tail.slice(start, end);
}

const BODY = guardBody();

describe('the refusal is armed on the write that strands the hand', () => {
  it('refuses a generation being replaced, on engine_tournament_leases', () => {
    const last = lastTriggerStatement(ON_REPLACE);
    expect(last.statement, last.file).toMatch(
      new RegExp(
        String.raw`^CREATE\s+CONSTRAINT\s+TRIGGER\s+${ON_REPLACE}\s+AFTER\s+UPDATE\s+ON\s+public\.engine_tournament_leases`,
        'i'
      )
    );
  });

  it('refuses a generation being released, on the same table', () => {
    const last = lastTriggerStatement(ON_RELEASE);
    expect(last.statement, last.file).toMatch(
      new RegExp(
        String.raw`^CREATE\s+CONSTRAINT\s+TRIGGER\s+${ON_RELEASE}\s+AFTER\s+DELETE\s+ON\s+public\.engine_tournament_leases`,
        'i'
      )
    );
  });

  it('both are DEFERRABLE INITIALLY DEFERRED, so resolve-then-hand-on is legal', () => {
    for (const trigger of [ON_REPLACE, ON_RELEASE]) {
      const last = lastTriggerStatement(trigger);
      expect(last.statement, `${trigger} in ${last.file}`).toMatch(
        /DEFERRABLE\s+INITIALLY\s+DEFERRED/i
      );
      expect(last.statement, `${trigger} in ${last.file}`).not.toMatch(/NOT\s+DEFERRABLE/i);
      expect(last.statement, `${trigger} in ${last.file}`).not.toMatch(/INITIALLY\s+IMMEDIATE/i);
    }
  });

  it('a heartbeat is excluded in the WHEN clause, not inside the function', () => {
    // heartbeat_tournament_leases_v4 writes heartbeat_at on hundreds of rows
    // every few seconds. Without this the engine queues a deferred event for
    // every one of them.
    expect(lastTriggerStatement(ON_REPLACE).statement).toMatch(
      /WHEN\s*\(\s*OLD\.lease_generation\s+IS\s+DISTINCT\s+FROM\s+NEW\.lease_generation\s*\)/i
    );
    expect(lastTriggerStatement(ON_RELEASE).statement).toMatch(
      /WHEN\s*\(\s*OLD\.lease_generation\s+IS\s+NOT\s+NULL\s*\)/i
    );
  });

  it('both call the one guard', () => {
    for (const trigger of [ON_REPLACE, ON_RELEASE]) {
      expect(lastTriggerStatement(trigger).statement, trigger).toMatch(
        new RegExp(String.raw`EXECUTE\s+FUNCTION\s+public\.${GUARD_FN}\(\)`, 'i')
      );
    }
  });
});

describe('the guard refuses exactly the state that stranded the tables', () => {
  it('counts the outgoing generation`s reserved permits and refuses on any', () => {
    expect(BODY).toMatch(
      /FROM\s+smarter_private\.f06_hand_permits\s+p[\s\S]*?p\.generation\s*=\s*OLD\.lease_generation[\s\S]*?p\.state\s*=\s*'reserved'/i
    );
    expect(BODY).toMatch(/IF\s+v_stranded\s*>\s*0\s+THEN\s+RAISE\s+EXCEPTION/i);
  });

  it('permits the handover when some lease row still names that generation', () => {
    // Resolve-and-hand-on, and a generation handed back to itself, both pass.
    expect(BODY).toMatch(
      /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.engine_tournament_leases\s+l[\s\S]*?l\.lease_generation\s*=\s*OLD\.lease_generation[\s\S]*?RETURN\s+NULL/i
    );
  });

  it('lets a terminal tournament release its lease, which is how refunds travel', () => {
    const allow = /IF\s+v_status\s+IN\s*\(([^)]*)\)\s*THEN\s+RETURN\s+NULL/i.exec(BODY);
    expect(
      allow,
      'the terminal allow-list is gone; a cancellation would be refused'
    ).not.toBeNull();
    for (const terminal of ["'CANCELLED'", "'CANCELED'", "'COMPLETED'", "'COMPLETING'"]) {
      expect(allow![1], `${terminal} must stay allowed`).toContain(terminal);
    }
  });

  it('owes nothing for a parent removed in the same transaction', () => {
    expect(BODY).toMatch(/IF\s+NOT\s+COALESCE\(v_found,\s*false\)\s+THEN\s+RETURN\s+NULL/i);
  });

  it('names the door that can still finish the job, so the refusal is actionable', () => {
    expect(BODY).toMatch(/fn_f06_abort_abandoned_generation/);
  });
});

describe('this is a guard, not the thirteenth repair job', () => {
  it('schedules nothing and unschedules nothing', () => {
    // Asserted against stripped SQL: the header discusses cron jobs.
    expect(CODE).not.toMatch(/cron\.schedule/i);
    expect(CODE).not.toMatch(/cron\.unschedule/i);
  });

  it('mends no row and moves no money', () => {
    expect(CODE).not.toMatch(/UPDATE\s+(public\.)?tournaments\b/i);
    expect(CODE).not.toMatch(/UPDATE\s+(public\.)?engine_tournament_leases\b/i);
    expect(CODE).not.toMatch(/UPDATE\s+smarter_private\.f06_hand_permits\b/i);
    expect(CODE).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(CODE).not.toMatch(
      /\bINSERT\s+INTO\s+(public\.|smarter_private\.)?(tournaments|table_seats|chip_ledger|f06_hand_permits)\b/i
    );
    expect(CODE).not.toMatch(/fn_f06_abort_abandoned_generation\s*\(/i);
  });

  it('refuses rather than guesses when the state it reasoned from has moved', () => {
    expect(CODE).toMatch(/RAISE\s+EXCEPTION\s+'refused:/i);
    expect(CODE).toMatch(/RAISE\s+EXCEPTION\s+'failed:/i);
    // The safety precondition: no reserved permit on a terminal tournament.
    expect(CODE).toMatch(/IF\s+v_terminal\s*<>\s*0\s+THEN/i);
    // The mechanism: no orphan was made by deleting a lease.
    expect(CODE).toMatch(/IF\s+v_deleted\s*<>\s*0\s+THEN/i);
    // It adds no job.
    expect(CODE).toMatch(/v_active\s+IS\s+DISTINCT\s+FROM\s+121/);
    expect(CODE).toMatch(/v_total\s+IS\s+DISTINCT\s+FROM\s+123/);
  });

  it('asserts the two things its reasoning stands on before it arms', () => {
    // One reserved permit per table is why an orphan is fatal, and the abort
    // door is the path back that refusing preserves.
    expect(CODE).toMatch(/f06_one_hand/);
    expect(CODE).toMatch(/fn_f06_abort_abandoned_generation/);
  });

  it('verifies the deferral and the WHEN clause it depends on, after arming', () => {
    expect(CODE).toMatch(/NOT\s+t\.tgdeferrable\s+OR\s+NOT\s+t\.tginitdeferred/i);
    expect(CODE).toMatch(/t\.tgconstraint\s*=\s*0/i);
    expect(CODE).toMatch(/t\.tgqual\s+IS\s+NULL/i);
  });

  it('creates the partial index the refusal reads, so it is not a seq scan', () => {
    expect(CODE).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+f06_reserved_permit_by_generation[\s\S]*?WHERE\s+state\s*=\s*'reserved'/i
    );
  });
});

describe('the header still explains itself', () => {
  it('carries a live proof the checker can evaluate', () => {
    expect(HEADER).toContain(`-- @live-proof:`);
    expect(HEADER).toContain(ON_REPLACE);
    expect(HEADER).toContain(ON_RELEASE);
  });

  it('records what was measured, and when', () => {
    expect(HEADER).toContain('2026-09-24');
    for (const figure of ['423', '3,138', '527', '489', '863']) {
      expect(HEADER, `the header must keep ${figure}`).toContain(figure);
    }
  });

  it('names the writer it sits under and why the deferral is load-bearing', () => {
    expect(HEADER).toMatch(/claim_tournament_lease_v2/);
    expect(HEADER).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
  });

  it('says, per job, which conjunct made each recovery path miss these', () => {
    for (const job of [
      'fn_crash_sweep_abandoned',
      'fn_ca_tournament_finished_but_not_completed',
      'fn_ca_tournament_conservation_confirm',
      'fn_ca_escrow_ttl_sweep',
      'flag-garbage-tournaments',
    ]) {
      expect(HEADER, `the header must account for ${job}`).toContain(job);
    }
  });
});
