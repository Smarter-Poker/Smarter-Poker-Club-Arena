/**
 * A SEAT THAT WAITS FOREVER GETS ITS CHIPS BACK.
 *
 * 2026-08-31. A Spin is seat-first: you pay when you sit, and the game starts
 * when the third seat sells. Nothing bounded the wait in between. If the
 * third player never arrived, everyone already seated had their chips locked
 * with no timeout, no refund, and no way out but a human noticing.
 *
 * Measured over the 7 days to 2026-08-31: 20,896 spins filled (99.7%), median
 * wait first-to-third seat 180s, p90 407s — and a worst case of 76,648s, or
 * 21 HOURS, with nine spins over six hours. Every one was horse-seated, so no
 * human had been harmed yet. That is what made it invisible, not what made it
 * safe: the first human to sit at a thin stake inherits the same 21 hours.
 *
 * The rules this pins are the ones that make the sweep safe to run
 * unattended, and each is a way it could quietly turn destructive:
 *
 *   - it must go through atomic_cancel_tournament, because that is the path
 *     trg_tournaments_cancel_must_refund demands and the only one that pays
 *     the seated players back. A direct status write would strand the money
 *     (CLAUDE.md 11.5 — deleting seat rows is how 48 chips vanished);
 *   - it must NEVER cancel a FULL unstarted game, which is one about to deal;
 *   - it must carry no is_horse branch (CLAUDE.md 10.5);
 *   - the timeout must stay a config row, so it can be tuned or switched off
 *     without a deploy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = readdirSync(DIR).find((f) => f.includes('a_seat_that_waits_forever'));
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

/** The function body, bounded by its own dollar-quoted block. */
function body(): string {
  const open = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled');
  expect(open, 'fn_spin_expire_unfilled has moved or gone').toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end, 'the function body is not dollar-quoted as expected').toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('the unfilled-spin sweep refunds rather than strands', () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the phase-2 migration is missing').toBeTruthy();
  });

  it('cancels through atomic_cancel_tournament, the refunding path', () => {
    expect(body()).toContain('atomic_cancel_tournament');
  });

  it('never writes the status directly, which would skip the refund', () => {
    const b = body();
    expect(b).not.toMatch(/UPDATE\s+public\.tournaments\s+SET\s+status/i);
    // Deleting a seat row destroys the chips on it — CLAUDE.md 11.5.
    expect(b).not.toMatch(/DELETE\s+FROM\s+public\.table_seats/i);
  });

  it('refuses to cancel a FULL but unstarted spin — that one is about to deal', () => {
    expect(body()).toMatch(/<\s*COALESCE\(t\.max_players/);
  });

  it('only acts once somebody has actually waited past the policy', () => {
    expect(body()).toMatch(/joined_at\s*<\s*now\(\)\s*-\s*make_interval\(mins\s*=>\s*v_minutes\)/);
  });

  it('reads its timeout from the config row, never a hardcoded interval', () => {
    const b = body();
    expect(b).toContain('spin_fill_policy');
    expect(b, '0 must switch the sweep off').toMatch(/v_minutes\s*<=\s*0/);
  });

  it('has no is_horse branch — horses are players', () => {
    expect(body()).not.toContain('is_horse');
  });

  it('is engine-only: a browser cannot call a function that cancels games', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_spin_expire_unfilled\(integer\) FROM PUBLIC, anon, authenticated/
    );
  });

  it('one stuck game does not stop the rest being freed', () => {
    expect(body()).toMatch(/EXCEPTION WHEN OTHERS THEN/);
  });
});

describe('the alarm that reports it can still be believed', () => {
  /**
   * Comments are stripped FIRST, and it matters. This migration quotes the
   * old, broken subquery in its own header to explain the bug, so a naive
   * indexOf('AS shortfall_events') finds the DOCUMENTATION and asserts
   * against the very code being removed. The window is then bounded by the
   * subquery's own parentheses rather than a byte count, per
   * tests/unit/noFixedSizeSourceWindows.
   */
  const migration = (): string => {
    const dir = resolve(__dirname, '..', 'supabase/migrations');
    const f = readdirSync(dir).find((x) => x.includes('a_repair_is_not_a_shortfall'));
    expect(f, 'the shortfall-alarm migration is missing').toBeTruthy();
    return readFileSync(resolve(dir, f as string), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
  };

  /** The shortfall_events subquery, bounded by the parens that open it. */
  const shortfallSubquery = (): string => {
    const sql = migration();
    const at = sql.indexOf('AS shortfall_events');
    expect(at, 'shortfall_events has gone from the view').toBeGreaterThan(-1);
    const open = sql.lastIndexOf('( SELECT count(*)', at);
    expect(open, 'the subquery opening paren is not where expected').toBeGreaterThan(-1);
    return sql.slice(open, at);
  };

  it('counts only rows whose note actually says SHORTFALL', () => {
    /* 2026-08-31: this counted every kind='adjustment' row, all-time, with no
       note filter — and the only one on the platform is a 2026-08-23
       duplicate-settlement REPAIR. So the spin-sweep cron returned 500 on
       every run and cron_health_log read 'error' continuously, over a
       condition long since fixed. That is the same channel this phase's
       expired-unfilled counts report on: an alarm that is always red cannot
       carry a new signal. */
    expect(shortfallSubquery()).toMatch(/note ILIKE '%SHORTFALL%'/);
  });

  it('is time-bounded like its three sibling counters', () => {
    expect(shortfallSubquery()).toMatch(/created_at > \(now\(\) - '24:00:00'::interval\)/);
  });
});
