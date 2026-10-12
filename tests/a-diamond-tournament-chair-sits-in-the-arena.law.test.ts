/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The deferred seat guard (zzz_diamond_seat_keeps_custody) asks every live
 * Diamond chair, at COMMIT, for custody held by the chair's own club: an
 * active tournament entry (P0812) or the cash seat's custody. Custody is held
 * by the arena. The chair's club comes from fn_seat_club_for_user through the
 * stamp trigger, and that resolver knew only club_members, where the arena has
 * no rows by design. So a Diamond chair got a chip club or no club, and every
 * Diamond tournament launch and every Spin seat would have been refused at
 * COMMIT (proved in a rolled-back rehearsal on 2026-09-29).
 *
 * The migration teaches the resolver one thing: a table whose club plays in
 * Diamonds seats every player in that club. It is an asserted substitution on
 * a chip function (pin, one occurrence, reverse proved), and it proves on the
 * live chairs that every chip chair keeps its answer. Nothing is opened.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_tournament_chair_sits_in_the_arena.sql'))
  .at(-1);
if (!NAME) throw new Error('the seat-club migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const PRE = code(
  sliceBetween(
    MIG,
    '-- 0. NOTHING IS OPEN AND NO DIAMOND CHAIR EXISTS',
    '-- 1. THE CHAIR ASKS THE ARENA'
  )
);
const EDIT = sliceBetween(MIG, '-- 1. THE CHAIR ASKS THE ARENA', '-- 2. THE ESTATE IS AS IT WAS');
const FINAL = code(sliceBetween(MIG, '-- 2. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

describe('LAW: a Diamond tournament chair sits in the arena', () => {
  it('is one transaction that opens nothing and writes no row', () => {
    expect(MIG.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(MIG.match(/^COMMIT;$/gm)?.length).toBe(1);
    const body = code(MIG);
    expect(body).not.toMatch(/SET\s+(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
    expect(body).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\./i);
    expect(PRE).toContain('an arena switch is already open');
    expect(PRE).toContain('a seat exists at a Diamond table');
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('changes the resolver in place: pinned, one anchor, reverse proved', () => {
    expect(EDIT).toContain("IF md5(v_def) <> 'c8300bf22e0130ab5dffde1508a98a75' THEN");
    expect(EDIT).toContain(
      "IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'c8300bf22e0130ab5dffde1508a98a75' THEN"
    );
    expect(EDIT).toContain('the table read occurs % times, expected 1');
    expect(EDIT).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(code(EDIT)).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\./i);
    // the grants, settings, security and volatility are the ones it had
    expect(EDIT).toContain('changed its grants, settings, security or volatility');
  });

  it('answers the table club for a Diamond table, by the predicate the seat guards use, before any membership lookup', () => {
    expect(EDIT).toContain("|| E'  IF EXISTS (SELECT 1 FROM public.clubs c\\n'");
    expect(EDIT).toContain(
      "|| E'              WHERE c.id = v_table_club AND c.asset = ''diamonds'') THEN\\n'"
    );
    expect(EDIT).toContain("|| E'    RETURN v_table_club;\\n'");
    // the new clause sits between the table read and the first membership branch,
    // and the old anchor is carried back unchanged at its end
    expect(EDIT).toContain("v_old := E'    FROM public.tables t WHERE t.id = p_table_id;\\n'");
    expect(EDIT).toContain("|| E'  IF v_union IS NULL THEN\\n';");
    expect((EDIT.match(/\|\| E' {2}IF v_union IS NULL THEN\\n';/g) ?? []).length).toBe(2);
  });

  it('proves every live chip chair keeps its answer, on one snapshot, against the pinned text', () => {
    expect(EDIT).toContain("'pg_temp.fn_seat_club_for_user_as_pinned(p_user_id uuid'");
    expect(EDIT).toContain(
      'IS DISTINCT FROM pg_temp.fn_seat_club_for_user_as_pinned(s.user_id, s.table_id, s.club_id)'
    );
    expect(EDIT).toContain(
      'IS DISTINCT FROM pg_temp.fn_seat_club_for_user_as_pinned(s.user_id, s.table_id, NULL))'
    );
    expect(EDIT).toContain('live chairs would change club');
  });

  it('asserts afterwards that a Diamond chair resolves to the arena and the stamp and guards kept their text', () => {
    expect(FINAL).toContain('a Diamond chair does not resolve to the arena');
    expect(FINAL).toContain("'467104f7e791b76328ce5e20b42ba81b'");
    expect(FINAL).toContain('fn_seat_club_for_user is reachable without an account');
  });

  it('declares how to see it live', () => {
    expect(MIG).toMatch(
      /^-- @live-proof: position\('A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA' in pg_get_functiondef\('public\.fn_seat_club_for_user\(uuid,uuid,uuid\)'::regprocedure\)\) > 0$/m
    );
  });

  it('no em dashes anywhere (CLAUDE.md 10.7)', () => {
    expect(MIG).not.toMatch(/\u2014/);
  });
});
