/**
 * LAW: THE FELT IS WHAT THE JOURNAL SAYS IS ON IT (2026-10-11).
 *
 * The nightly ledger replay compares how far the cash felt moved with the
 * chip_ledger legs that moved it, both read under one snapshot. A settled
 * hand's rake and jackpot drop leave the seats at the hand commit, but their
 * legs are written by the hand's post-commit obligations in the next
 * transaction; a mid-hand add-on is journaled onto the felt when it is bought
 * and reaches the seat when the hand ends. A reading between the two halves
 * read the felt short of the journal, and the next reading reported the gap as
 * drift (+9.76 on 2026-10-10, +4.10 on 2026-10-11, incident 9294e359). The
 * felt reader now counts both until their other half commits.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'supabase/migrations');
const FILE = readdirSync(DIR).filter((f) =>
  f.endsWith('_the_felt_is_what_the_journal_says_is_on_it.sql')
);
const SQL = FILE.length === 1 ? readFileSync(resolve(DIR, FILE[0]), 'utf8') : '';
const BODY = SQL.replace(/--[^\n]*/g, '');

const READER =
  "public.fn_ca_account_balance('table_stack', '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack')";
const CHIP_TABLE = "WHERE cl.id = t.club_id AND cl.asset = 'diamonds'";
const ADDONS = /FROM public\.table_pending_addons pa\s+WHERE pa\.resolved_at IS NULL/g;
const OWED =
  /COALESCE\(\(c\.post_commit_payload->'rake'->>'amount'\)::numeric, 0\)\s+\+ COALESCE\(\(c\.post_commit_payload->'bbj_contribution'->>'amount'\)::numeric, 0\)/g;
const UNPOSTED =
  /WHERE c\.post_commit_payload IS NOT NULL\s+AND c\.post_commit_completed_at IS NULL/g;

describe('the felt is what the journal says is on it', () => {
  it('ships as exactly one recorded migration', () => {
    expect(FILE).toHaveLength(1);
    expect(FILE[0].replace(/\.sql$/, '').length).toBeLessThanOrEqual(60);
  });

  it('one transaction, a live proof, a pinned preimage, one anchor and a proof block', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(SQL).toMatch(/^-- @live-proof: /m);
    expect(SQL).toContain('JOURNAL_FELT_PREIMAGE_CHANGED');
    expect(SQL).toMatch(/v_n <> 1 THEN\s*RAISE EXCEPTION 'JOURNAL_FELT_ANCHOR_CHANGED/);
    expect(SQL).toMatch(/DO \$prove\$/);
    // 'jackpot drop' is plain English here; the statements are upper case
    expect(BODY).not.toMatch(/\b(?:DROP|GRANT|REVOKE)\b/);
    expect(BODY).not.toMatch(/\bcron\.(?:schedule|alter_job|unschedule)\b/i);
  });

  it('the reader counts the open seats, the unresolved add-ons and the unposted rake and drop', () => {
    // once in the reader, once in the proof
    expect(BODY.match(ADDONS)).toHaveLength(2);
    expect(BODY.match(OWED)).toHaveLength(2);
    expect(BODY.match(UNPOSTED)).toHaveLength(2);
    // the rake obligation's own copy of the drop is not counted twice
    expect(BODY).not.toContain("post_commit_payload->'rake'->>'bbj'");
  });

  it('every part of the felt is read on the same tables: no tournament, no Diamond club', () => {
    // reader: add-ons + owed; proof: seats + add-ons + owed
    expect(BODY.split(CHIP_TABLE).length - 1).toBe(5);
    expect(BODY.match(/t\.tournament_id IS NOT NULL/g)).toHaveLength(5);
  });

  it('the proof holds the reader to seats + add-ons + owed in one statement', () => {
    expect(SQL).toContain(READER);
    expect(SQL).toContain('IF v_fn IS DISTINCT FROM v_seats + v_addons + v_owed THEN');
  });

  it('the felt gets one new reading on the new definition, with the snapshot it read under', () => {
    expect(SQL.match(/INSERT INTO/g)).toHaveLength(1);
    expect(SQL).toMatch(
      /INSERT INTO public\.ca_account_snapshots[\s\S]*?clock_timestamp\(\), true, NULL, 0, 'one-snapshot-v4',[\s\S]*?pg_current_snapshot\(\)::text;/
    );
    expect(SQL.match(/INSERT INTO public\.ca_account_snapshots[\s\S]*?;/)?.[0]).toContain(READER);
  });
});
