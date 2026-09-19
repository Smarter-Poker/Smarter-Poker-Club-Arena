/**
 * ===========================================================================
 *  LAW: A PUBLISHED TABLE IS A MEASURED DECISION
 * ===========================================================================
 *
 * Every row change on a table in `supabase_realtime` is decoded by wal2json
 * and passed through `apply_rls` once per subscriber, and the cost tracks the
 * number of changes and, per change, the COLUMN COUNT. On 2026-09-06 that
 * stream was costing 22.9 seconds of database time per 15 seconds of WAL -
 * 68% of one core, continuously - and the publication was trimmed. On
 * 2026-09-08 a `SET TABLE` replaced the rest of its membership and silently
 * dropped `notifications`; it was noticed two days later.
 *
 * NOBODY SWEPT THE CLIENT. Measured 2026-09-19: 34 `postgres_changes`
 * subscriptions in src/ named tables the publication no longer carried. Those
 * channels join, report SUBSCRIBED and receive nothing, for ever, with no
 * error - club chat, table chat, the waitlist listener, friend requests, the
 * cashier wallet. `check-realtime-publication.mjs` had been red the whole
 * time and was right the whole time, but its KNOWN_UNPUBLISHED baseline was
 * seeded BEFORE the trim, so it could not name the ones that died after it,
 * and a detector that cannot go green cannot catch a new one either.
 *
 * WHAT THE FIX WAS, and why it is a law rather than a preference: the question
 * is never "is this table useful", it is "what does publishing it cost", and
 * that is arithmetic.
 *
 *   restored  - 23 tables, 35,618 writes between them
 *   left out  - 11 tables, 56,527,172 writes, including tournament_players at
 *               25,280,935 and `tables` at 4,643,367 over 159 columns
 *
 * 0.06%. And every restored table was checked for row-level security and a
 * SELECT policy a subscriber can actually satisfy FIRST, because a published
 * table whose subscriber cannot read the row delivers nothing and looks
 * identical to the bug it was meant to fix.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceDollarQuoted } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const PUBLISH =
  'supabase/migrations/20260919141903_a_subscription_that_costs_nothing_may_fire_again.sql';
const DETECTOR = 'scripts/ci/check-realtime-publication.mjs';

/** This law lands here; anything newer is bound by the forward guard. */
const THIS_VERSION = '20260919141903';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read(PUBLISH);
const DETECTOR_SRC = read(DETECTOR);

/** The eleven the 2026-09-06 trim exists to keep out. */
const TOO_EXPENSIVE = [
  'tournament_players',
  'table_seats',
  'tournaments',
  'tables',
  'agent_commissions',
  'agents',
  'clubs',
  'game_management_events',
  'profiles',
  'union_wallets',
  'chip_transactions',
];

/** One plpgsql array literal from the migration, as its bare names. */
function namesIn(declaration: string): string[] {
  const at = SQL.indexOf(declaration);
  expect(at, `${declaration} is declared in ${PUBLISH}`).toBeGreaterThan(-1);
  const close = SQL.indexOf('];', at);
  return [...SQL.slice(at, close).matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
}

/** Every KNOWN_UNPUBLISHED key and its reason, read from the detector. */
function baseline(): Map<string, string> {
  const block = DETECTOR_SRC.slice(
    DETECTOR_SRC.indexOf('const KNOWN_UNPUBLISHED = new Map(['),
    DETECTOR_SRC.indexOf('/** Directories that hold client code')
  );
  const out = new Map<string, string>();
  for (const m of block.matchAll(/\[\s*'([a-z_][a-z0-9_]*)'\s*,\s*([\s\S]*?)\]\s*,\s*\n/g)) {
    out.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  return out;
}

describe('a published table is a measured decision', () => {
  const WANTED = namesIn('v_wanted CONSTANT text[]');
  const FORBIDDEN = namesIn('v_forbidden CONSTANT text[]');

  it('publishes twenty-three and names the eleven it will not', () => {
    expect(WANTED).toHaveLength(23);
    expect(FORBIDDEN.sort()).toEqual([...TOO_EXPENSIVE].sort());
  });

  it('the publish list and the excluded list cannot overlap, and the migration refuses if they do', () => {
    expect(WANTED.filter((t) => FORBIDDEN.includes(t))).toEqual([]);
    // Not merely absent - actively refused, so a later edit cannot drift.
    expect(SQL).toContain('IF v_wanted && v_forbidden THEN');
    expect(SQL).toMatch(/RAISE EXCEPTION 'refused: a table the 2026-09-06 trim excluded/);
  });

  it('nothing is published that a subscriber could not read anyway', () => {
    const block = sliceDollarQuoted(SQL, '$publish$');
    // RLS on, or publishing it broadcasts every row.
    expect(block).toContain('relrowsecurity');
    expect(block).toMatch(/row-level security off/);
    // And a SELECT policy the subscriber can satisfy, or it delivers nothing
    // and looks exactly like the bug.
    expect(block).toMatch(/p\.cmd IN \('SELECT', 'ALL'\)/);
    expect(block).toMatch(/no SELECT policy a subscriber can satisfy/);
  });

  it('adds, never replaces: SET TABLE is what dropped notifications', () => {
    expect(SQL).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE');
    // The header explains what SET TABLE did, so the ban is on the STATEMENT,
    // read with the prose taken out.
    const ddl = SQL.replace(/--[^\n]*/g, '');
    expect(ddl).not.toMatch(/SET\s+TABLE/i);
    // And it proves the five it found are still there afterwards.
    expect(SQL).toMatch(/the publication lost a table it already carried/);
  });

  it.each(TOO_EXPENSIVE)('%s is excluded with a measured number, not an opinion', (table) => {
    const reason = baseline().get(table);
    expect(reason, `${table} must be recorded in KNOWN_UNPUBLISHED`).toBeDefined();
    expect(reason).toContain('NOT PUBLISHED BY MEASUREMENT');
    // A grouped figure - 25,280,935 - so the next reader can weigh it rather
    // than take it on trust.
    expect(reason, `${table}'s reason must carry the measurement that decided it`).toMatch(
      /\d{1,3}(,\d{3})+/
    );
  });

  it('every baseline entry says why, because an unexplained one is just a mute', () => {
    // The bar is a reason at all, not a long one: the 2026-09-06 seed uses
    // 'as above' and 'unresolved', which are terse but are somebody's answer.
    // An empty one is a table nobody decided about, sitting where the
    // detector will never look at it again.
    const mute = [...baseline().entries()].filter(
      ([, reason]) => reason.replace(/['"]/g, '').trim().length === 0
    );
    expect(mute.map(([t]) => t)).toEqual([]);
    // And the baseline is not empty, which would make the detector vacuous.
    expect(baseline().size).toBeGreaterThan(40);
  });

  /**
   * THE ONE THAT MATTERS LATER. `SET TABLE` replaces the whole membership, so
   * one migration that means to add a single table removes every other. That
   * is not hypothetical: it is what happened on 2026-09-08, and `notifications`
   * was dark for two days before anyone noticed.
   */
  it('no migration after this one replaces the whole publication', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith('.sql')) continue;
      if (file.slice(0, file.indexOf('_')) <= THIS_VERSION) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
      if (/ALTER\s+PUBLICATION\s+supabase_realtime\s+SET\s+TABLE/i.test(sql)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      'a migration uses ALTER PUBLICATION supabase_realtime SET TABLE, which replaces the ' +
        'ENTIRE membership - every table not named in that one statement is silently ' +
        'unpublished, and its subscribers keep reporting SUBSCRIBED while receiving ' +
        'nothing. That is what happened on 2026-09-08 and notifications was dark for two ' +
        'days. Use ADD TABLE or DROP TABLE.'
    ).toEqual([]);
  });
});
