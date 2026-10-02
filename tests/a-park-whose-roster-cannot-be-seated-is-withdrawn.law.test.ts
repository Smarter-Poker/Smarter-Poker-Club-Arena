/**
 * A PARK WHOSE ROSTER CANNOT BE SEATED IS WITHDRAWN (2026-10-02)
 *
 * 4d2afa41 "Morning Free Buy (NLH)": seven full tables (62 players) sat
 * parked from 13:28 UTC for table breaks that could never begin, because the
 * 25 tables still dealing had six free seats between them. The only door that
 * withdraws an unbegun park, fn_f06_continue_no_start_last_table, refuses
 * every table but the event's last.
 *
 * 20261002142740 adds fn_f06_withdraw_unplaceable_park, the same door for a
 * table that is not the last, admitted only while the other tables cannot
 * seat the roster. This law pins its proof conditions, that its only writes
 * are the receipt and the park's own state, and its exact installed body.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20261002142740_a_park_whose_roster_cannot_be_seated_is_withdrawn_and_its_ta.sql'
);
const SQL = readFileSync(FILE, 'utf8');
const TAG = '$withdraw_unplaceable$';
const open = SQL.indexOf(`AS ${TAG}`) + `AS ${TAG}`.length;
const BODY = SQL.slice(open, SQL.indexOf(TAG, open));
const flat = BODY.replace(/\s+/g, ' ');

describe('fn_f06_withdraw_unplaceable_park', () => {
  it('is installed exactly as its post-image states, in one transaction', () => {
    const md5 = createHash('md5').update(BODY, 'utf8').digest('hex');
    expect(SQL).toContain(`md5(p.prosrc) IS DISTINCT FROM '${md5}'`);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain(
      "IS NOT NULL THEN\n    RAISE EXCEPTION 'F06_WITHDRAW_UNPLACEABLE_PREIMAGE"
    );
    expect(SQL).toContain('GRANT EXECUTE ON FUNCTION public.fn_f06_withdraw_unplaceable_park');
    expect(SQL).toContain("ARRAY['postgres=X/postgres','service_role=X/postgres']");
  });

  it('withdraws only an unbegun park whose own cancellation proves nothing is in flight', () => {
    expect(flat).toContain('PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation');
    expect(flat).toContain("'park_requested'::text,p_park_custody_id,p_park_revision");
    expect(flat).toContain('o.manifest IS NOT NULL OR o.close_receipt IS NOT NULL');
    expect(flat).toContain(
      "(p_tournament_id,p_lifecycle,o.origin_generation,'never_started'::text,o.custody_id)"
    );
    expect(flat).toContain("WHERE table_id=p_table_id AND state='reserved'");
    expect(flat).toContain('smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id');
    expect(flat).toContain("RAISE EXCEPTION 'F06_WITHDRAWAL_LAST_TABLE'");
  });

  it('refuses whenever the other tables can seat the roster, and proves the roster first', () => {
    expect(flat).toContain('IF free_seats>=jsonb_array_length(roster) THEN');
    expect(flat).toContain("RAISE EXCEPTION 'F06_WITHDRAWAL_ROSTER_FITS'");
    expect(flat).toContain("x.state NOT IN ('acknowledged','withdrawn_before_manifest')");
    expect(flat).toContain(
      'movement:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id)'
    );
    expect(flat.indexOf('ROSTER_FITS')).toBeLessThan(flat.indexOf('INSERT INTO'));
  });

  it('writes only its receipt and the park state, and credits nothing', () => {
    const writes = [...flat.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([\w.]+)/g)].map(
      (m) => `${m[1]} ${m[2]}`
    );
    expect(writes).toEqual([
      'INSERT INTO smarter_private.f06_no_start_continuations',
      'UPDATE smarter_private.f06_operations',
    ]);
    expect(flat).toContain(
      "SET state='withdrawn_before_manifest',abort_receipt_id=receipt.receipt_id"
    );
    expect(flat).toContain("'kind','unplaceable_park_withdrawal'");
    expect(flat).toContain("'credit',0");
  });
});
