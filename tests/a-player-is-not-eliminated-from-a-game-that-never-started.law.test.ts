/**
 * A PLAYER IS NOT ELIMINATED FROM A GAME THAT NEVER STARTED
 * (2026-09-24, BINDING)
 *
 * Owner policy v2.9 (Dan, 2026-09-22): fix a defect at its root cause and then
 * harden it, and "never add or rely on a cron, watcher, reconciler or repair
 * loop to compensate for a defect".
 *
 * WHAT WENT WRONG. Thirteen Spin tournaments have held player money in
 * REGISTERING since 2026-09-08. They were reported as Spins nobody filled,
 * which the unfilled-Spin expiry should have refunded. Measured on production
 * 2026-09-24 10:38 to 10:50 UTC, that is not what they are:
 *
 *   tournament_escrow.gross_in = 3 x buy_in on all thirteen       669.00
 *   still held as prize_balance                                   446.00
 *   still held as fee_balance                                      53.52
 *   paid out, or refunded                                            0.00
 *   registrations carrying a finishing position of 2 or 3              24
 *
 * They filled, they drew, they dealt, and in eleven of the thirteen a winner
 * was decided - all while tournaments.started_at stayed NULL and the status
 * stayed REGISTERING. fn_spin_expire_unfilled refuses them correctly, because
 * a drawn Spin is never expired. The crash sweep, the finished-but-not-
 * completed sweep and the payout machinery cannot see them at all, because
 * every one of those keys on a tournament that started. And they can never
 * launch again, because fn_spin_draw_and_settle_atomic must prove three paid
 * entrants and eleven of them have one left.
 *
 * ONE WINDOW, AND ONLY ONE. Every violating row the platform has ever written
 * was written between 2026-09-08 13:51:31.594 and 14:52:52.136 UTC: 41 rows
 * over 30 tournaments, 24 of them Spin. Never before, never since. The launch
 * path was cut over to the atomic lease and receipt authority in the migration
 * wave recorded at 2026-09-08 12:59 to 13:00 UTC.
 *
 * THE LAW. Elimination is the writer that proves a game is being played, so
 * elimination is where the contradiction is refused. A registration may reach
 * 'eliminated' or 'winner' only if its tournament started, or if that
 * tournament is terminal - cancelled or completed - which is how a refund and
 * a settlement legitimately record everyone out.
 *
 * Refusing it preserves the three registered entrants, which is exactly the
 * state fn_spin_draw_and_settle_atomic's legacy_projection branch is built to
 * adopt and relaunch. The guard does not merely detect the defect; it keeps
 * the Spin in the one state the existing writer can still finish. No sweep.
 *
 * IT MUST STAY DEFERRED. atomic_cancel_tournament marks every registration
 * 'eliminated' BEFORE it sets the tournament to CANCELLED. Read immediately,
 * this invariant would refuse every cancellation on the platform, and with it
 * every refund. DEFERRABLE INITIALLY DEFERRED asks at COMMIT, and judges the
 * state a transaction leaves behind rather than the order it took to get
 * there. The deferral is load-bearing, and this file fails if it is removed.
 *
 * Every negative below is asserted against comment-stripped SQL, because this
 * header names the very things it forbids.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const MIGRATION = '20260924105049_a_player_is_not_eliminated_from_a_game_that_never_started.sql';
const TRIGGER = 'a_player_is_not_eliminated_from_a_game_that_never_started';
const GUARD_FN = 'fn_player_needs_a_started_game';

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

describe('the refusal is armed on the writer that proves a game is being played', () => {
  it('is a constraint trigger on tournament_players, and nothing has disarmed it since', () => {
    const last = lastTriggerStatement(TRIGGER);
    expect(last.statement, last.file).toMatch(
      new RegExp(
        String.raw`^CREATE\s+CONSTRAINT\s+TRIGGER\s+${TRIGGER}\s+AFTER\s+INSERT\s+OR\s+UPDATE\s+ON\s+public\.tournament_players`,
        'i'
      )
    );
  });

  it('is DEFERRABLE INITIALLY DEFERRED, so a cancellation still refunds', () => {
    // atomic_cancel_tournament eliminates before it cancels. Read immediately,
    // this invariant takes every refund on the platform down with it.
    const last = lastTriggerStatement(TRIGGER);
    expect(last.statement, last.file).toMatch(/DEFERRABLE\s+INITIALLY\s+DEFERRED/i);
    expect(last.statement, last.file).not.toMatch(/NOT\s+DEFERRABLE/i);
    expect(last.statement, last.file).not.toMatch(/INITIALLY\s+IMMEDIATE/i);
  });

  it('asks only about a result, and calls the guard', () => {
    const last = lastTriggerStatement(TRIGGER);
    expect(last.statement, last.file).toMatch(
      /WHEN\s*\(\s*NEW\.status\s+IN\s*\(\s*'eliminated'\s*,\s*'winner'\s*\)\s*\)/i
    );
    expect(last.statement, last.file).toMatch(
      new RegExp(String.raw`EXECUTE\s+FUNCTION\s+public\.${GUARD_FN}\(\)`, 'i')
    );
  });
});

describe('the guard refuses exactly the state that stranded the money', () => {
  it('refuses a result on a tournament that never started', () => {
    expect(BODY).toMatch(/IF\s+v_started\s+IS\s+NULL\s+THEN\s+RAISE\s+EXCEPTION/i);
    expect(BODY).toMatch(/never started/i);
  });

  it('lets a terminal tournament record everyone out, which is how refunds work', () => {
    const allow = /IF\s+v_status\s+IN\s*\(([^)]*)\)\s*THEN\s+RETURN\s+NULL/i.exec(BODY);
    expect(allow, 'the terminal allow-list is gone; cancellation would be refused').not.toBeNull();
    for (const terminal of ["'CANCELLED'", "'CANCELED'", "'COMPLETED'", "'COMPLETING'"]) {
      expect(allow![1], `${terminal} must stay allowed`).toContain(terminal);
    }
  });

  it('reads the parent it is judging, and judges no other row', () => {
    expect(BODY).toMatch(
      /FROM\s+public\.tournaments\s+t\s+WHERE\s+t\.id\s*=\s*NEW\.tournament_id/i
    );
  });
});

describe('this is a guard, not the thirteenth repair job', () => {
  it('schedules nothing', () => {
    // Asserted against stripped SQL: the header discusses cron jobs at length.
    expect(CODE).not.toMatch(/cron\.schedule/i);
    expect(CODE).not.toMatch(/cron\.unschedule/i);
  });

  it('moves no money and mends no row', () => {
    expect(CODE).not.toMatch(/UPDATE\s+public\.tournament_players/i);
    expect(CODE).not.toMatch(/UPDATE\s+public\.tournaments\b/i);
    expect(CODE).not.toMatch(/UPDATE\s+public\.tournament_escrow/i);
    expect(CODE).not.toMatch(
      /INSERT\s+INTO\s+public\.(tournament_players|tournaments|tournament_escrow|spin_reserve_ledger)/i
    );
    expect(CODE).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(CODE).not.toMatch(/atomic_cancel_tournament\s*\(/i);
  });

  it('declares itself in the money-trigger register, in this same migration', () => {
    // tournament_players is a money table. A declaration in a later migration
    // is a promise, and this one is made where the trigger is created.
    expect(CODE).toMatch(
      /INSERT\s+INTO\s+public\.ca_declared_money_triggers[\s\S]*?'tournament_players'[\s\S]*?a_player_is_not_eliminated_from_a_game_that_never_started/i
    );
    expect(CODE).toMatch(/failed: the trigger is not declared in the money-trigger register/);
  });

  it('refuses rather than guesses when the measured state has moved', () => {
    expect(CODE).toMatch(/RAISE\s+EXCEPTION\s+'refused:/i);
    expect(CODE).toMatch(/RAISE\s+EXCEPTION\s+'failed:/i);
    // The violation set it was measured against, asserted before it arms.
    expect(CODE).toMatch(/v_rows\s+IS\s+DISTINCT\s+FROM\s+41/);
    expect(CODE).toMatch(/v_tournaments\s+IS\s+DISTINCT\s+FROM\s+30/);
    expect(CODE).toMatch(/v_spin\s+IS\s+DISTINCT\s+FROM\s+24/);
  });

  it('verifies the deferral it depends on, after arming', () => {
    expect(CODE).toMatch(/NOT\s+t\.tgdeferrable\s+OR\s+NOT\s+t\.tginitdeferred/i);
    expect(CODE).toMatch(/t\.tgconstraint\s*=\s*0/i);
  });
});

describe('the header still explains itself', () => {
  it('carries a live proof the checker can evaluate', () => {
    expect(HEADER).toContain(`-- @live-proof:`);
    expect(HEADER).toContain(TRIGGER);
  });

  it('records what was measured, and when', () => {
    expect(HEADER).toContain('2026-09-24');
    expect(HEADER).toContain('2026-09-08');
    for (const figure of ['669.00', '446.00', '53.52', '14:52:52.136']) {
      expect(HEADER, `the header must keep ${figure}`).toContain(figure);
    }
  });

  it('says why the deferral is load-bearing', () => {
    expect(HEADER).toMatch(/atomic_cancel_tournament/);
    expect(HEADER).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
  });
});
