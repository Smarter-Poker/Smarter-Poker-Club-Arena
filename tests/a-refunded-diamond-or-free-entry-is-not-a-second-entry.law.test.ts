/**
 * A REFUNDED DIAMOND OR FREE ENTRY IS NOT A SECOND ENTRY (2026-10-25)
 *
 * 20261024232734 let a never-dealt park admit a re-registered player whose
 * earlier, vanished registration had been refunded - but only a PAID CHIP
 * entry refunded through chip_ledger 'refund' legs. A diamond buy-in is
 * refunded on its own entry custody (poker_diamond_tournament_ledger kind
 * 'refund'), and a free chip entry refunds nothing, so both still refused
 * the chair with F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN: 852 paid and 70
 * free diamond receipts, and 42 free chip receipts, in 14 days; 18 of 872
 * live playing entries at the time of the proof.
 *
 * 20261025052637 (recorded on main; PR #8019 first carried it as 20261025042215) admits each only on its own refund evidence: the free chip
 * entry's unregistration receipt (refunded_chips 0), the diamond entry's own
 * released tournament_entry custody whose refund legs equal it and which paid
 * nothing else. The paid chip rule and every other refusal are unchanged.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const FILE = '20261025052637_a_refunded_diamond_or_free_entry_is_not_a_second_entry.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const CODE = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const PREVIOUS = readFileSync(
  join(MIGRATIONS, '20261024232734_a_refunded_earlier_entry_is_not_a_second_entry.sql'),
  'utf8'
);

describe('a refunded diamond or free entry is not a second entry', () => {
  it("edits the installed never-dealt proof only from 20261024232734's post-image", () => {
    expect(SQL).toContain(
      "'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure"
    );
    expect(SQL).toContain("IF md5(v_src) <> '631844035961b4995aab130e8e53e6b6' THEN");
    expect(PREVIOUS).toContain("IF md5(v_src) <> '631844035961b4995aab130e8e53e6b6' THEN");
    expect(SQL).toMatch(/IF v_n <> 1 THEN RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_ANCHOR/);
    expect(SQL).toContain("IF md5(v_src) <> '35dbc3c7dd7b152d8e55892b4af9ae3b' THEN");
    expect(SQL).toContain("<> '2962ab899304584d3ad1ae1d14b3e8dc'");
    // The file is the byte-exact recording of what production ran, so the
    // post-image proof is the code's own check (owner, ACL and both md5s),
    // not a header comment.
    expect(SQL).toContain("v_acl IS DISTINCT FROM '{postgres=X/postgres}' THEN");
  });

  it('anchors on the exact passage 20261024232734 installed', () => {
    // Every line the previous file inserted is the anchor this file finds.
    for (const line of [
      "' OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)",
      "' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id' || chr(10)",
      "' AND (f.operation IS DISTINCT FROM ''entry'' OR f.asset IS DISTINCT FROM ''chips'' OR f.amount IS NULL OR f.amount<=0' || chr(10)",
      "' OR EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)))' || chr(10)",
      "' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id),0)' || chr(10)",
    ]) {
      expect(PREVIOUS).toContain(line);
      expect(SQL).toContain(line);
    }
  });

  it('admits a free chip entry only on its own zero-refund unregistration receipt', () => {
    for (const clause of [
      "f.asset=''chips'' AND f.amount=0 AND NOT EXISTS(SELECT 1 FROM public.tournament_unregistration_receipts u",
      'u.registration_id=f.registration_id AND u.tournament_id=p_tournament AND u.user_id=registration.user_id',
      'u.refunded_chips=0 AND u.settled_at<fund.observed_at',
    ])
      expect(SQL).toContain(clause);
  });

  it('admits a diamond entry only through its own released, fully refunded entry custody', () => {
    for (const clause of [
      "f.asset=''diamonds'' AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody dc",
      "dc.id::text=f.custody_result->>''custody_id'' AND dc.user_id=registration.user_id AND dc.target_id=p_tournament",
      "dc.purpose=''tournament_entry'' AND dc.state=''released'' AND dc.balance=0 AND dc.released_at<fund.observed_at",
      "d.kind=''refund'' AND d.tournament_id=p_tournament AND d.user_id=registration.user_id AND d.created_at<fund.observed_at),0)=f.amount",
      "d.custody_id=dc.id AND d.kind NOT IN (''entry'',''refund'')",
    ])
      expect(SQL).toContain(clause);
  });

  it('keeps every other refusal, and compares only chips with the chip refunds', () => {
    for (const clause of [
      "f.operation IS DISTINCT FROM ''entry''",
      "f.asset IS NULL OR f.asset NOT IN (''chips'',''diamonds'')",
      'f.amount IS NULL OR f.amount<0',
      'f.observed_at>=fund.observed_at OR f.registration_id IS NULL',
      'EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)',
      "f.registration_id IS DISTINCT FROM registration.id AND f.asset=''chips''),0)",
    ])
      expect(SQL).toContain(clause);
    // The paid chip refund sum is the previous file's, untouched.
    expect(PREVIOUS).toContain(
      "l.category=''refund'' AND l.status=''posted'' AND l.from_entity_id=p_tournament AND l.to_entity_id=registration.user_id"
    );
  });

  it('is one transaction that writes nothing and schedules nothing', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toMatch(/SET LOCAL lock_timeout = '2s';/);
    expect(CODE).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(public|smarter_private)\.)/i
    );
    expect(CODE).not.toMatch(/cron\./i);
    expect(CODE).not.toMatch(/^GRANT |^REVOKE /m);
    for (const k of ['v_acl', 'v_owner', 'v_secdef', 'v_config'])
      expect(CODE).toContain(`IS DISTINCT FROM ${k}`);
  });

  it('is redefined later only by the successor that starts from its post-image', () => {
    const later = readdirSync(MIGRATIONS).filter(
      (f) =>
        f.endsWith('.sql') &&
        f > FILE &&
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION smarter_private.f06_movement_never_dealt_prior('
        )
    );
    // 20261025082356 (busted rebuy / never-dealt add-on) refuses to run unless
    // the installed proof is exactly this file's post-image (35dbc3c7).
    expect(later).toEqual([
      '20261025082356_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql',
    ]);
    expect(readFileSync(join(MIGRATIONS, later[0]), 'utf8')).toContain(
      "IF md5(v_pre) <> '35dbc3c7dd7b152d8e55892b4af9ae3b'"
    );
  });
});
