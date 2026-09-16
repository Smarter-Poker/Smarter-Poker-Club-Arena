/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE DIAMOND GUARDS ARE WATCHED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 8's exit clause is "cannot pay playing-stack units to wallets", and
 * the audit says to mirror the chip guard added after 46.4 million chips were
 * minted into horse wallets. On the Diamond side that guard ALREADY EXISTS, on
 * both axes, in every path that could turn a stack into wallet Diamonds:
 * cashout and settle_cash_hand refuse a tournament-attached table and refuse
 * custody that is not a cash seat; release refuses an active tournament entry;
 * reserve is behind tournaments_enabled.
 *
 * What did not exist was anything WATCHING those guards. fn_ca_guard_watchlist
 * named 28 functions whose definitions are hashed hourly so that an alarm
 * cannot be quietly disarmed, and not one of them was a Diamond function.
 * Remove a guard and nothing noticed. The same was true of the four unit rules
 * Phase 8 installed: pinned by laws that read migration source and by vectors,
 * neither of which sees a live redefinition in production.
 *
 * THE RULE: the eight Diamond money doors, the four Phase 8 unit rules and the
 * list itself are on the watchlist, baselined through the declaration door in
 * the same transaction that widened the list, and nothing that was watched
 * before is watched less. The watcher is not touched.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus, migrationsMentioning } from './helpers/migrationCorpus';

const SUFFIX = '_the_diamond_guards_are_watched.sql';

const migration = () => {
  const hits = migrationCorpus().filter((m) => m.name.endsWith(SUFFIX));
  expect(hits.length, 'exactly one migration widens the list for the Diamond guards').toBe(1);
  return hits[0]!;
};

/** The header discusses every string asserted below; prose is not the rule. */
const executable = () =>
  migration()
    .sql.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');

/** The names the newest definition of the list carries. */
const newestWatchlist = (): string[] => {
  const defs = migrationsMentioning('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist').sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const newest = defs[defs.length - 1]!;
  const start = newest.sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist');
  const body = newest.sql.slice(start, newest.sql.indexOf('$function$;', start));
  return [...new Set([...body.matchAll(/'(fn_[a-z0-9_]+)'/g)].map((m) => m[1]!))];
};

const DIAMOND_DOORS = [
  'fn_poker_diamond_reserve',
  'fn_poker_diamond_release',
  'fn_poker_diamond_cashout',
  'fn_poker_diamond_settle_cash_hand',
  'fn_poker_diamond_buyin',
  'fn_poker_diamond_top_up',
  'fn_poker_diamond_seat_keeps_custody',
  'fn_poker_diamond_plain_cash_table',
];
const UNIT_RULES = [
  'fn_ca_unit_floor_cents',
  'fn_ca_tournament_unit_cents',
  'fn_ca_prize_ladder',
  'fn_ca_recovery_fee_cents',
];

describe('LAW: the Diamond guards are watched', () => {
  it('is the newest definition of the watchlist, and names every Diamond door and unit rule', () => {
    const defs = migrationsMentioning('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist')
      .map((m) => m.name)
      .sort();
    expect(defs[defs.length - 1]).toBe(migration().name);
    const list = newestWatchlist();
    for (const g of [...DIAMOND_DOORS, ...UNIT_RULES, 'fn_ca_guard_watchlist']) {
      expect(list, `${g} must be watched`).toContain(g);
    }
  });

  it('widens the list and never narrows it', () => {
    // every name the previous definition carried is still on the newest one
    const defs = migrationsMentioning(
      'CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist'
    ).sort((a, b) => a.name.localeCompare(b.name));
    expect(defs.length).toBeGreaterThanOrEqual(2);
    const previous = defs[defs.length - 2]!;
    const start = previous.sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist');
    const body = previous.sql.slice(start, previous.sql.indexOf('$function$;', start));
    const before = [...new Set([...body.matchAll(/'(fn_[a-z0-9_]+)'/g)].map((m) => m[1]!))];
    const after = newestWatchlist();
    for (const g of before) expect(after, `${g} was dropped from the watchlist`).toContain(g);
    expect(after.length).toBe(41);
    // and the migration refuses to apply if the database disagrees
    expect(executable()).toContain('widening the watchlist dropped:');
    expect(executable()).toContain('expected 41');
  });

  it('refuses to watch a name that does not exist, before it widens anything', () => {
    const sql = executable();
    // the check comes before the CREATE OR REPLACE, so a typo never reaches
    // the list and the watcher never learns a name it cannot find
    const check = sql.indexOf('would alarm on every run if watched');
    const widen = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(widen);
  });

  it('baselines the new names through the declaration door, in the same transaction', () => {
    const sql = executable();
    expect(sql).toContain(
      "fn_ca_declare_guard_redefinition(v_name, 'migration the_diamond_guards_are_watched')"
    );
    // a first baseline only: an existing one belongs to whoever set it
    expect(sql).toContain('this migration only records first baselines');
    // and it proves, rather than hopes, that the thirteen are quiet and declared
    expect(sql).toContain('these newly watched functions are already off their baseline:');
    expect(sql).toContain('these newly watched functions were not baselined by this migration:');
    expect(sql).toContain('was not kept, so a later notice would have nothing to diff against');
  });

  it('does not touch, mute or narrow the watcher', () => {
    const sql = migration().sql;
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.fn_ca_guard_defs_watch');
    expect(sql).not.toContain('DROP FUNCTION');
    expect(sql).not.toMatch(/UPDATE public\.ca_guard_defs/);
    expect(sql).not.toMatch(/ca_drift_incidents/);
    expect(sql).toContain('NOTHING ABOUT THE WATCHER CHANGES');
  });

  it('leaves an original that is already drifting to its own open notice', () => {
    // only the names this migration adds are asserted quiet; asserting the
    // originals quiet would make somebody else's open notice block this apply
    expect(executable()).toMatch(/ELSIF v_name = ANY\(c_added\) THEN/);
  });

  it('keeps the list unreadable without an account', () => {
    // the prize ladder migration recreated a function and found it granted to
    // anon; this one replaces in place and checks the grants came with it
    const sql = executable();
    expect(sql).toContain(
      "has_function_privilege('anon', 'public.fn_ca_guard_watchlist()', 'EXECUTE')"
    );
    expect(sql).toContain(
      "has_function_privilege('authenticated', 'public.fn_ca_guard_watchlist()', 'EXECUTE')"
    );
  });
});
