/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A BROKEN DEBUGGER IS NOT A SEAT STACK MISMATCH (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_ca_hand_commit_refusals decides what a refusal WAS by matching its error
 * text, and its stack bucket matched '%stack%' - any occurrence of the word.
 * At 13:00 UTC on 2026-09-11 one alert read "pldbgapi2 statement call stack is
 * broken", a debugger extension complaining about its own CALL STACK, and it
 * was counted as a seat stack mismatch. That single message is why incident
 * 07ebac1d read 57 refusals across 16 tables when the genuine figure was 56
 * across 15, all of them before 02:00 UTC.
 *
 * THE LAW: a bucket decides whether an unrelated event can hold a money
 * integrity incident open. Match the sentence the engine actually writes, not
 * a word that happens to appear in it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read('supabase/migrations/20260911161415_a_broken_debugger_is_not_a_seat_stack_mismatch.sql');

describe('the bucket matches a seat stack, not any stack', () => {
  it('is one transaction, as the production DDL policy requires', () => {
    expect(SQL.match(/^BEGIN;/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;/gm)?.length).toBe(1);
  });

  it('the bare word match is gone', () => {
    expect(SQL).not.toMatch(/LIKE '%stack%'/);
  });

  it('and both engine wordings are still caught', () => {
    // current: "did not durably sync every final seat stack"
    // superseded 2026-09-08: "produced fractional stack"
    expect(SQL).toMatch(/LIKE '%seat stack%'/);
    expect(SQL).toMatch(/LIKE '%fractional stack%'/);
  });

  it('the window that stops re-reporting answered history survives', () => {
    // Removing this makes every past refusal news again on the next sweep.
    expect(SQL).toMatch(/A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR/);
    expect(SQL).toMatch(/COALESCE\(btrim\(i\.correction_ref\), ''\) <> ''/);
  });

  it('the 25 finding floor is unchanged, so this is not a threshold edit', () => {
    expect(SQL).toMatch(/HAVING count\(\*\) >= 25/);
  });

  it('the migration aborts if a debugger alert would still bucket as a seat stack', () => {
    expect(SQL).toMatch(/ABORT: % debugger alert\(s\) would still bucket as a seat stack mismatch/);
  });
});

/** The bucket restated, on the three sentences that matter. */
const isSeatStack = (err: string) => /seat stack/i.test(err) || /fractional stack/i.test(err);

describe('the bucket, on the sentences that opened and inflated the incident', () => {
  it('the genuine refusal is a seat stack mismatch', () => {
    expect(isSeatStack('atomic hand commit refused (rolled_back): tournament X hand 9280155 did not durably sync every final seat stack')).toBe(true);
  });

  it('so is the superseded wording', () => {
    expect(isSeatStack('accepted tournament hand produced fractional stack 691173.50 for seat 3')).toBe(true);
  });

  it('the debugger is NOT', () => {
    expect(isSeatStack('atomic hand commit refused (atomic_hand_rolled_back): pldbgapi2 statement call stack is broken')).toBe(false);
  });
});
