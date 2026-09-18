/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FEE CUTOVER CANNOT STRAND A GAME IT DID NOT WITNESS (2026-09-18)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The accounting_tournament_fee_cutover row was inserted at 2026-09-17
 * 18:24:02.831517+00 while tournaments were in flight.
 *
 * From that instant every tournament entry fee must carry contributor
 * evidence, and the capture path refuses any contributor charged before the
 * cutover. The tournaments that had already charged their fees could never
 * produce a batch, so the net plan refused them, fn_settle_tournament_rake
 * turned that refusal fatal, and 550 events froze: decided by the cards,
 * winners unpaid, 1,901 horse entries seated in games that could not end.
 * Twelve hours later the engine had logged 1,491 finish refusals and raised a
 * critical money alert for every one.
 *
 * The row was already well defended in every direction but one. Its immutable
 * trigger refuses UPDATE and DELETE, its no_truncate trigger refuses TRUNCATE,
 * and PRIMARY KEY (singleton) with CHECK (singleton) allows exactly one row.
 * The instant could never move once chosen, and nothing checked it when it was
 * chosen. INSERT was the whole unguarded surface, and INSERT is how this
 * happened.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '..', 'supabase/migrations');
const CHANGELOG = resolve(__dirname, '..', 'docs/changelog');

/** The newest migration containing `marker` - the one Postgres ends up with. */
const governing = (marker: string): string => {
  const all = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8').includes(marker));
  expect(all.length, `no migration contains ${marker}`).toBeGreaterThan(0);
  return readFileSync(resolve(MIGRATIONS, all[all.length - 1]), 'utf8');
};

const SQL = governing('CREATE TRIGGER ca_fee_cutover_is_drained');
const ROLLBACK = readFileSync(
  resolve(CHANGELOG, '2026-09-18-the-fee-cutover-cannot-strand-a-game.rollback.sql'),
  'utf8'
);

describe('the cutover may not be armed over a game it cannot witness', () => {
  it('guards INSERT, the one operation the row did not already refuse', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER ca_fee_cutover_is_drained\s+BEFORE INSERT ON public\.accounting_tournament_fee_cutover\s+FOR EACH ROW/
    );
    // Not UPDATE or DELETE: accounting_tournament_fee_cutover_immutable already
    // refuses those, and duplicating it would hide which guard spoke.
    expect(SQL).not.toMatch(/CREATE TRIGGER ca_fee_cutover_is_drained[\s\S]{0,80}OR UPDATE/);
    expect(SQL).not.toMatch(/CREATE TRIGGER ca_fee_cutover_is_drained[\s\S]{0,80}OR DELETE/);
  });

  it('is sized against the defences that already exist, and says so', () => {
    // If the existing pair ever changes, this guard's shape has to be revisited
    // rather than silently left covering the wrong surface.
    expect(SQL).toContain(
      'accounting_tournament_fee_cutover_immutable,accounting_tournament_fee_cutover_no_truncate'
    );
    expect(SQL).toContain('not the immutable/no_truncate pair this guard was sized against');
  });

  it('the observer counts a live game holding an unwitnessed fee', () => {
    const fn = SQL.slice(
      SQL.indexOf('FUNCTION public.fn_ca_fee_cutover_stranded_by'),
      SQL.indexOf('FUNCTION public.fn_ca_guard_fee_cutover_is_drained')
    );
    expect(fn.length).toBeGreaterThan(400);
    // Live, not finished: a COMPLETED or CANCELLED event is not stranded.
    for (const status of ['RUNNING', 'BREAK', 'REGISTERING', 'COMPLETING']) {
      expect(fn, `${status} counts as live`).toContain(`'${status}'`);
    }
    expect(fn).not.toMatch(/'COMPLETED'|'CANCELLED'/);
    expect(fn).toContain('rr.rake_amount > 0');
    expect(fn).toContain('rr.created_at < p_starts_at');
    expect(fn).toContain("b.status IS DISTINCT FROM 'captured'");
  });

  it('the observer reads live rows and is reachable by nobody but the guard', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.fn_ca_fee_cutover_stranded_by'));
    // STABLE, never IMMUTABLE: the answer depends on rows that change.
    expect(fn.slice(0, 500)).toMatch(/\bSTABLE SECURITY DEFINER\b/);
    expect(fn.slice(0, 500)).not.toMatch(/\bIMMUTABLE\b/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_fee_cutover_stranded_by\(timestamptz\) FROM PUBLIC, anon, authenticated/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_guard_fee_cutover_is_drained\(\) FROM PUBLIC, anon, authenticated/
    );
  });

  it('the refusal says what to drain, not only that something is wrong', () => {
    const raise = SQL.slice(SQL.indexOf("'fee cutover % would strand"));
    expect(raise.slice(0, 400)).toContain('stranded_tournaments');
    expect(raise.slice(0, 400)).toContain('oldest_tournament');
    expect(raise.slice(0, 400)).toContain('oldest_fee_at');
  });

  it('the migration exercises the guard before it commits, and proves who refused', () => {
    // A guard nobody exercised is a guard nobody has. And an INSERT on a
    // single-row table could be refused by the primary key instead, which would
    // prove nothing, so the postcondition reads the message back.
    expect(SQL).toContain('postcondition: ca_fee_cutover_is_drained is not installed and enabled');
    expect(SQL).toContain(
      'postcondition: the guard allowed a cutover to be armed over a live backlog'
    );
    expect(SQL).toContain('GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT');
    expect(SQL).toContain("v_msg NOT LIKE '%would strand%'");
    expect(SQL).toContain('refused by something other than this guard');
  });

  it('and proves it is not simply refusing every instant', () => {
    expect(SQL).toContain('at an instant nothing precedes, so it refuses every instant');
  });

  it('one transaction, as the production DDL policy requires', () => {
    expect(SQL.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    expect(SQL).not.toMatch(/CREATE INDEX CONCURRENTLY/);
  });

  it('the rollback removes the guard and never the cutover row', () => {
    // Rolling back a guard must not roll back the thing it guards: with no
    // cutover row every fee capture refuses.
    expect(ROLLBACK).toContain('DROP TRIGGER IF EXISTS ca_fee_cutover_is_drained');
    expect(ROLLBACK).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_guard_fee_cutover_is_drained()'
    );
    expect(ROLLBACK).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_fee_cutover_stranded_by(timestamptz)'
    );
    expect(ROLLBACK).not.toMatch(/DELETE FROM public\.accounting_tournament_fee_cutover/);
    expect(ROLLBACK).not.toMatch(/DROP TABLE[\s\S]*accounting_tournament_fee_cutover/);
    expect(ROLLBACK).toMatch(/^BEGIN;$/m);
    expect(ROLLBACK).toMatch(/^COMMIT;$/m);
  });
});
