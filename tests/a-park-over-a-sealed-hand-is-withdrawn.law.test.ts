/**
 * A PARK OVER A SEALED HAND IS WITHDRAWN WHEN ITS ROSTER CANNOT BE SEATED
 * (2026-10-03)
 *
 * 79feebfc "Prime Time Free Buy (NLH)": six of fifteen parked full tables, and
 * SNG 657e45b2's only table, had no never_started permit to witness their park
 * - the timed-out begin_hand rolled back, so the latest permit is the ACCEPTED,
 * sealed previous hand - and both doors refused them for ever.
 *
 * 20261003021958 lets fn_f06_withdraw_unplaceable_park take that sealed hand as
 * the witness (and on the last table, which the continuation cannot serve with
 * it). This law pins the new witness, that nothing else was loosened, and the
 * exact installed body.
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
  '20261003021958_a_park_over_a_committed_hand_is_withdrawn_when_its_roster_ca.sql'
);
const SQL = readFileSync(FILE, 'utf8');
const TAG = '$withdraw_unplaceable$';
const open = SQL.indexOf(`AS ${TAG}`) + `AS ${TAG}`.length;
const BODY = SQL.slice(open, SQL.indexOf(TAG, open));
const flat = BODY.replace(/\s+/g, ' ');

describe('fn_f06_withdraw_unplaceable_park, sealed-hand witness', () => {
  it('replaces exactly the inspected body and installs exactly the stated one, in one transaction', () => {
    const md5 = createHash('md5').update(BODY, 'utf8').digest('hex');
    expect(SQL).toContain(`md5(p.prosrc) IS DISTINCT FROM '${md5}'`);
    expect(SQL).toContain("IS DISTINCT FROM 'bda3af4b7eb6977b9375fce72d731b9f'");
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("ARRAY['postgres=X/postgres','service_role=X/postgres']");
  });

  it('takes an accepted latest permit only when its hand is sealed and nothing follows it', () => {
    expect(flat).toContain("h.state NOT IN ('never_started','accepted')");
    expect(flat).toContain(
      "(h.state='accepted' AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c JOIN public.hand_history x"
    );
    expect(flat).toContain(
      'c.hand_number=h.hand_number AND c.post_commit_completed_at IS NOT NULL'
    );
    expect(flat).toContain(
      "unsealed:=CASE WHEN h.state='accepted' THEN h.hand_number+1 ELSE h.hand_number END;"
    );
    for (const table of [
      'hand_atomic_commits',
      'hand_history',
      'hand_private_state',
      'table_hole_cards',
    ])
      expect(flat).toContain(`public.${table} WHERE table_id=p_table_id AND hand_number>=unsealed`);
    expect(flat).toContain('f06_no_start_continuations WHERE permit_id=h.permit_id');
  });

  it('keeps every other proof the door had', () => {
    expect(flat).toContain('PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation');
    expect(flat).toContain('OR o.custody_generation IS DISTINCT FROM p_lease_generation');
    expect(flat).toContain("WHERE table_id=p_table_id AND state='reserved'");
    expect(flat).toContain(
      "(h.state='never_started' AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id))"
    );
    expect(flat).toContain("IF h.state='never_started' AND (SELECT count(*) FROM public.tables");
    expect(flat).toContain("RAISE EXCEPTION 'F06_WITHDRAWAL_ROSTER_FITS'");
    expect(flat).toContain(
      'movement:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);'
    );
    expect(flat).toContain(
      "SET state='withdrawn_before_manifest',abort_receipt_id=receipt.receipt_id"
    );
    expect(flat).toContain("'credit',0");
    expect(flat).not.toMatch(/UPDATE public\.|INSERT INTO public\.|chip_ledger/);
  });
});
