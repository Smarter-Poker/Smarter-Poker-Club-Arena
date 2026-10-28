/**
 * A PARKED TABLE NEVER FREEZES ON AN UNPROVEN MOVE (2026-10-25)
 *
 * 2026-10-24, 12135e5b Table 13: a rebuy seated onto a table whose hand was in
 * flight left a chair the sealed hand never dealt, the park that followed was
 * refused by its movement proof on every admission
 * (F06_MOVEMENT_WHOLE_ROSTER_REQUIRED), and the table dealt nothing for 3h46m.
 * That was the fifth time the proof had to learn a new arrival shape.
 *
 * Migration 20261025052423 adds fn_f06_withdraw_unproven_movement_park, the
 * movement-proof sibling of fn_f06_withdraw_unplaceable_park, and ranks a
 * table with a hand in flight after every table between hands in the
 * tournament seat chooser. This pins that the door keeps every guard of the
 * door it was derived from, withdraws only on a named F06_MOVEMENT_* refusal,
 * records it, moves nothing, and that the chooser change is a ranking only.
 * The engine half is pinned by
 * server/src/tournament/aParkedTableNeverFreezesOnAnUnprovenMove.law.test.ts.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const sql = readFileSync(
  join(
    ROOT,
    'supabase/migrations/20261025052423_a_parked_table_never_freezes_on_an_unproven_move.sql'
  ),
  'utf8'
);
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const TAG = '$withdraw_unproven_movement$';
const open = sql.indexOf(`AS ${TAG}`) + `AS ${TAG}`.length;
const BODY = sql.slice(open, sql.indexOf(TAG, open));
const flat = BODY.replace(/\s+/g, ' ');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** The live withdrawal door this one was derived from (20261003021958 + the
 * 20261012061427 55P03 conversion), reconstructed from the repo. */
function withdrawalDoorBody(): string {
  const src = readFileSync(
    join(
      ROOT,
      'supabase/migrations/20261003021958_a_park_over_a_committed_hand_is_withdrawn_when_its_roster_ca.sql'
    ),
    'utf8'
  );
  const t = '$withdraw_unplaceable$';
  const a = src.indexOf(`AS ${t}`) + `AS ${t}`.length;
  return src
    .slice(a, src.indexOf(t, a))
    .replace(
      "RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'",
      "RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'"
    );
}

describe('a parked table never freezes on an unproven move', () => {
  it('is one transaction with lock_timeout and a live proof', () => {
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(code).toMatch(/^SET LOCAL lock_timeout = '\d+s';$/m);
    expect(sql).toMatch(/^-- @live-proof: .*fn_f06_withdraw_unproven_movement_park/m);
    expect(sql).toMatch(/^-- @live-proof: .*A REBUY IS NOT SEATED UNDER A HAND IN FLIGHT/m);
  });

  it('is derived from the exact live withdrawal door and asserts every pre-image', () => {
    const live = withdrawalDoorBody();
    expect(md5(live)).toBe('8560ec3a35f712126248dee38c9afc8f');
    for (const pin of [
      "'8560ec3a35f712126248dee38c9afc8f'",
      "'d21b415b4754a19147cce0160de59479'",
      "'d857e9d6270456d122ef385c751bc5f1'",
      "'31329a1df4bec9c92e0517b38fd42b93'",
      "'32ed1ece2bd0e0fe5f53fd92e81448e6'",
    ])
      expect(code).toContain(pin);
    // The post-image assertion names this exact body.
    expect(code).toContain(`md5(p.prosrc) IS DISTINCT FROM '${md5(BODY)}'`);
  });

  it('keeps every guard of the withdrawal door it was derived from', () => {
    for (const guard of [
      'PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation',
      "IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN: withdrawal refused'",
      "'park_requested'::text,p_park_custody_id,p_park_revision",
      'OR o.custody_generation IS DISTINCT FROM p_lease_generation',
      'o.manifest IS NOT NULL OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL',
      'EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)',
      'EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=o.break_id)',
      "WHERE table_id=p_table_id AND state='reserved'",
      'smarter_private.f06_no_start_continuations WHERE permit_id=h.permit_id',
      "RAISE EXCEPTION 'F06_WITHDRAWAL_POSITIVE_ORIGINAL_REQUIRED'",
      "RAISE EXCEPTION 'F06_WITHDRAWAL_OPEN_SOURCE_REQUIRED'",
      "RAISE EXCEPTION 'F06_WITHDRAWAL_LAST_TABLE'",
      "RAISE EXCEPTION 'F06_WITHDRAWAL_ROSTER_CHANGED'",
      "RAISE EXCEPTION 'F06_WITHDRAWAL_STARTED_OR_ROSTER_CHANGED'",
      'smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id',
    ])
      expect(flat).toContain(guard);
    // The only removed block is the capacity test: this door is not about seats.
    expect(flat).not.toContain('F06_WITHDRAWAL_ROSTER_FITS');
    expect(flat).not.toContain('F06_WITHDRAWAL_CAPACITY_UNKNOWN');
  });

  it('withdraws only while the movement proof refuses with its own named refusal', () => {
    expect(flat).toContain(
      'movement:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);'
    );
    expect(flat).toContain("EXCEPTION WHEN SQLSTATE '55000' THEN");
    expect(flat).toContain("IF refusal_message NOT LIKE 'F06\\_MOVEMENT\\_%' THEN RAISE; END IF;");
    expect(flat).toContain(
      "IF refusal_message IS NULL THEN RAISE EXCEPTION 'F06_WITHDRAWAL_MOVEMENT_PROVEN'"
    );
    // The proof is asked after every no-start guard and before the receipt.
    expect(flat.indexOf('F06_WITHDRAWAL_STARTED_OR_ROSTER_CHANGED')).toBeLessThan(
      flat.indexOf('f06_movement_prior(')
    );
    expect(flat.indexOf('F06_WITHDRAWAL_MOVEMENT_PROVEN')).toBeLessThan(
      flat.indexOf('INSERT INTO smarter_private.f06_no_start_continuations')
    );
  });

  it('records the refusal, moves nothing and credits nothing', () => {
    expect(flat).toContain("'kind','unproven_movement_park_withdrawal'");
    expect(flat).toContain(
      "'movement_refusal',jsonb_build_object('sqlstate',refusal_state,'message',refusal_message)"
    );
    expect(flat).toContain(
      "UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=receipt.receipt_id"
    );
    expect(flat).toContain("'credit',0");
    for (const write of [
      /UPDATE public\./,
      /INSERT INTO public\./,
      /DELETE FROM/,
      /chip_ledger/,
      /wallet/,
    ])
      expect(BODY).not.toMatch(write);
  });

  it('keeps the door private to the engine and security definer', () => {
    expect(code).toContain(
      'REVOKE ALL ON FUNCTION public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;'
    );
    expect(code).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) TO service_role;'
    );
    expect(code).toMatch(
      /LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = pg_catalog, public, smarter_private/
    );
    expect(code).toContain("ARRAY['postgres=X/postgres','service_role=X/postgres']");
    // A refusal is never 40001 (PostgREST re-runs it): 20261012061427.
    expect(code).not.toMatch(/ERRCODE\s*=\s*'40001'/);
  });

  it('ranks a table with a hand in flight after every table between hands, never excludes it', () => {
    expect(code).toContain(
      "v_marker constant text := 'A REBUY IS NOT SEATED UNDER A HAND IN FLIGHT';"
    );
    const start = code.indexOf('v_new constant text');
    const v_new = code.slice(start, code.indexOf('\nBEGIN', start));
    expect(v_new).toMatch(
      /AND o\.state NOT IN \(\\'acknowledged\\',\\'withdrawn_before_manifest\\'\)\),\\n.*EXISTS \(\\n\s*SELECT 1 FROM smarter_private\.f06_hand_permits hp\\n\s*WHERE hp\.table_id=tb\.id AND hp\.state=\\'reserved\\'\),\\n\s*\(\\n\s*SELECT count\(\*\)/
    );
    expect(v_new).not.toMatch(/AND NOT EXISTS/);
    expect(code).toContain("'chooser in-flight anchor is not present exactly once'");
    for (const role of ['service_role', 'authenticated', 'anon'])
      expect(code).toContain(`OR has_function_privilege('${role}', p.oid, 'EXECUTE')`);
    expect(code).toContain(
      "p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]"
    );
  });

  it('the engine calls the door it installs, and treats its absence as no withdrawal', () => {
    const rpc = readFileSync(
      join(ROOT, 'server/src/tournament/tournamentTableBreakRpc.ts'),
      'utf8'
    );
    expect(rpc).toContain("this.request('fn_f06_withdraw_unproven_movement_park'");
    expect(rpc).toContain('runWithTournamentDataAuthority(');
    expect(rpc).toContain('async () => await supabase.rpc(name, parameters)');
    expect(rpc).toContain("'F06_WITHDRAWAL_MOVEMENT_PROVEN'");
    expect(rpc).toContain("row.state !== 'withdrawn_unproven_movement'");
    expect(rpc).toMatch(/error\.code === 'PGRST202' \|\| error\.code === '42883'\) return false;/);
  });
});
