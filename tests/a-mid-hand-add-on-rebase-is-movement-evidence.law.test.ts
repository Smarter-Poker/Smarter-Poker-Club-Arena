/**
 * A MID-HAND ADD-ON REBASE IS MOVEMENT EVIDENCE (2026-10-16)
 *
 * 85313174 "Coffee Break Freeroll (PLO4)": three tables dealt nothing from
 * 17:03 UTC with 15 players seated. Four players bought the add-on while each
 * table's last hand was being dealt, so the stack settlement rebased their
 * seats (stack_result.rebased, one ca_seat_stack_rebases row each) and wrote
 * the engine's result plus exactly the 3,000 that arrived. f06_movement_prior
 * refused any non-empty rebased, so every re-admission of the parks refused
 * F06_MOVEMENT_STACK_RECEIPT. Behind it, table 30c09ebd also held a player
 * who busted in the hand before, rebought and was re-seated in the same chair
 * while the last hand was dealt; the arrival loop admitted an undealt chair
 * only by a move or an entry/re-entry receipt, so it refused
 * F06_MOVEMENT_WHOLE_ROSTER_REQUIRED.
 *
 * 20261016183932 admits the rebase only by its rebase receipt and the add-on
 * funding receipts that bought it, and the rebought chair only by its rebuy
 * receipt and the sealed bust. This law pins the conditions, that only eight
 * passages change, that every refusal is still present, that the migration
 * replaces exactly the body production held, and that the native regression
 * (scripts/ci/test-mid-hand-add-on.py) still covers each counterfactual.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261016183932_a_mid_hand_add_on_rebase_is_movement_evidence.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(MIGRATIONS, '20261003163015_a_busted_chair_taken_by_a_late_entry_is_movement_evidence.sql'),
  'utf8'
);
const RUNNER = readFileSync(join(ROOT, 'scripts', 'ci', 'test-mid-hand-add-on.py'), 'utf8');

const PRE_MD5 = '862440fc437b25c7c10b96f9ed603283';
const PRE_DEF_MD5 = '458a9e5135824e03d4188e43bc7c9c84';
const POST_MD5 = 'd2ead73888242bf1d29bf7635bb0fa90';
const POST_DEF_MD5 = 'cd75d4888abb11fbb33daba617e7d589';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, tag: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(');
  expect(start, 'the file defines f06_movement_prior').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const close = sql.indexOf(tag, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

/** The (now, before) passages the post-image check restores, read from the file. */
function passages(sql: string): [string, string][] {
  const check = sql.slice(sql.indexOf('DO $mid_hand_addon_postimage$'));
  const quoted = [...check.matchAll(/\$r\$([\s\S]*?)\$r\$/g)].map((m) => m[1]);
  expect(quoted.length).toBe(16);
  const pairs: [string, string][] = [];
  for (let i = 0; i < quoted.length; i += 2) pairs.push([quoted[i], quoted[i + 1]]);
  return pairs;
}

const NEW_BODY = body(SQL, '$mid_hand_addon_prior$');
const OLD_BODY = body(ORIGIN, '$busted_entry_prior$');
const slice = (from: string, to: string) => {
  const a = NEW_BODY.indexOf(from);
  const b = NEW_BODY.indexOf(to, a);
  expect(a, from).toBeGreaterThanOrEqual(0);
  expect(b, to).toBeGreaterThan(a);
  return NEW_BODY.slice(a, b);
};
const REBASE = slice(
  " IF s->'rebased' ? (x->>'user_id') THEN",
  ' -- Every rebased player is a player this hand dealt'
);
const REBUY = slice(' rf:=NULL; bust:=NULL;', ' fund:=NULL;');

describe('a mid-hand add-on rebase is movement evidence', () => {
  it('replaces exactly the body production held and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${PRE_DEF_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
    expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*md5\\(prosrc\\)='${POST_MD5}'`, 'm'));
  });

  it('changes only eight passages, and restoring them reproduces the pre-image', () => {
    let restored = NEW_BODY;
    const pairs = passages(SQL);
    // The innermost replace() is written first, so the file order is the order applied.
    for (const [now, before] of pairs) {
      expect(restored.split(now).length, now).toBe(2);
      // A function replacement: the passages contain `$'`, which a string
      // replacement would expand.
      restored = restored.replace(now, () => before);
    }
    expect(restored).toBe(OLD_BODY);
  });

  it('admits a rebase only by its own rebase receipt and the add-on receipts that bought it', () => {
    for (const condition of [
      // exactly one rebase receipt of this settlement, matching the request
      '(SELECT count(*) FROM public.ca_seat_stack_rebases r WHERE r.table_id=p_table',
      "AND r.hand_id=(s->>'hand_id')::uuid AND r.user_id=(x->>'user_id')::uuid)<>1 THEN",
      'IF credit<=0 OR rb.amount IS DISTINCT FROM credit OR rb.hand_number IS DISTINCT FROM a.hand_number',
      "OR rb.engine_after IS DISTINCT FROM (x->>'stack')::numeric",
      "OR rb.engine_before IS DISTINCT FROM (x->>'stack_before')::numeric",
      'OR rb.db_before IS DISTINCT FROM rb.engine_before+credit',
      "OR rb.written IS DISTINCT FROM (x->>'stack')::numeric+credit THEN",
      // the walked receipts: after the previous hand and the chair, by the seal
      'c.table_id=p_table AND c.hand_number<a.hand_number;',
      "opened:=GREATEST(COALESCE(opened,'-infinity'::timestamptz),(x->>'seat_joined_at')::timestamptz);",
      'AND f.observed_at>opened AND f.observed_at<=a.committed_at ORDER BY f.observed_at DESC,f.id DESC LOOP',
      "IF rf.operation IS DISTINCT FROM 'addon' OR gained IS NULL OR gained<=0",
      "OR rf.registration_snapshot->>'table_id' IS DISTINCT FROM p_table::text",
      "OR (rf.registration_snapshot->>'chips')::numeric IS DISTINCT FROM cur THEN",
      "IF cur IS DISTINCT FROM rb.engine_before OR chain='[]'::jsonb THEN",
    ])
      expect(REBASE, condition).toContain(condition);
    // written and the registration image carry exactly the credit, and every
    // rebased key is a player this hand dealt
    expect(NEW_BODY).toContain(
      "IF (s->'written'->>(x->>'user_id'))::numeric IS DISTINCT FROM (x->>'stack')::numeric+credit"
    );
    expect(NEW_BODY).toContain(
      "IF (SELECT count(*) FROM jsonb_object_keys(s->'rebased'))<>credited THEN"
    );
    // the receipts walked precede the seal, so the purchase loop (after the
    // seal) never counts them again
    expect(NEW_BODY).toContain(
      "held:=(x->>'stack')::numeric+COALESCE((item->>'credit')::numeric,0); since:=a.committed_at;"
    );
    expect(NEW_BODY).toContain(
      "OR jsonb_typeof(s->'rebased') IS DISTINCT FROM 'object' OR s->'departed' IS DISTINCT FROM '[]'::jsonb"
    );
  });

  it('admits a rebought chair only by its rebuy receipt and the sealed bust on that chair row', () => {
    for (const condition of [
      "AND f.operation IN ('entry','reentry','rebuy')",
      "IF rf.id IS NOT NULL AND rf.operation='rebuy' AND seat.user_id IS NOT NULL AND seat.occupancy_id IS NOT NULL",
      'AND seat.joined_at IS NOT NULL AND rf.observed_at<=seat.joined_at',
      "AND rf.registration_snapshot->>'table_id'=p_table::text",
      "AND rf.registration_snapshot->>'seat_number'=seat.seat_number::text",
      "AND rf.registration_snapshot->>'status'='playing' AND rf.registration_snapshot->>'eliminated_at' IS NULL",
      "(rf.registration_snapshot->>'chips')::numeric=COALESCE(NULLIF((rf.tournament_snapshot->>'rebuy_chips')::numeric,0),(rf.tournament_snapshot->>'starting_chips')::numeric) THEN",
      'c.table_id=p_table AND c.committed_at<=rf.observed_at',
      "AND v->>'seat_id'=seat.id::text AND (v->>'stack')::numeric=0)",
      "AND (bust.stack_result->'written'->>seat.user_id::text)::numeric=0",
      "bust.stack_result->'tournament_zero_stack_seat_generations' @> jsonb_build_array(jsonb_build_object('seat_id',seat.id::text,'user_id',seat.user_id::text))",
      'm.user_id=seat.user_id AND m.moved_at>bust.committed_at)',
      'c.table_id=p_table AND c.committed_at>bust.committed_at',
    ])
      expect(REBUY, condition).toContain(condition);
    // a rebased player is never taken for a busted chair
    expect(NEW_BODY).toContain(
      "IF NOT FOUND AND item ? 'hand' AND (x->>'stack')::numeric=0 AND bought=0 AND NOT item ? 'credit' THEN"
    );
    for (const reason of [
      'F06_MOVEMENT_ORIGINAL_PROOF_MISSING',
      'F06_MOVEMENT_PRIOR_INCOMPLETE',
      'F06_MOVEMENT_PRIOR_NOT_LAST_BOUNDARY',
      'F06_MOVEMENT_POSTCOMMIT_SEAL',
      'F06_MOVEMENT_SEAT_CHANGED',
      'F06_MOVEMENT_REGISTRATION_CHANGED',
      'F06_MOVEMENT_ROSTER_CHANGED',
      'F06_MOVEMENT_ELIMINATION_UNPROVEN',
      'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
    ])
      expect(NEW_BODY.split(reason).length, reason).toBe(OLD_BODY.split(reason).length);
    // every new admission path refuses with the stack receipt reason
    expect(NEW_BODY.split('F06_MOVEMENT_STACK_RECEIPT').length).toBeGreaterThan(
      OLD_BODY.split('F06_MOVEMENT_STACK_RECEIPT').length
    );
  });

  it('keeps a proof that needs neither byte-identical', () => {
    expect(NEW_BODY).toContain("AND entries='[]'::jsonb AND rebases='[]'::jsonb THEN '{}'::jsonb");
    expect(NEW_BODY).toContain(
      "||CASE WHEN rebases='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('rebased',rebases) END) END;"
    );
  });

  it('is pinned natively against each counterfactual', () => {
    for (const name of [
      'pre-image refuses the mid-hand add-on',
      'pre-image refuses the rebought chair',
      'migration applied verbatim',
      'an ordinary park proof is byte-identical',
      'no rebase receipt',
      'receipt after the seal',
      'receipt image is not the running stack',
      'rebased player the hand did not deal',
      'rebuy before the bust was sealed',
      'rebuy after the chair was taken',
      'bust chair not vacated by the hand',
      'moved after the bust',
    ])
      expect(RUNNER, name).toContain(name);
    expect(RUNNER).toContain(FILE);
  });

  it('is one transaction that writes no row, keeps the ACL, and is the newest definition', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SQL).not.toMatch(/^GRANT /m);
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(public|smarter_private)\.)/i
    );
    expect(code).not.toMatch(/cron\./i);
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION smarter_private.f06_movement_prior('
        )
      );
    // 20261024211825 (a rebuy seated from another table) is the one
    // successor, and it refuses to run unless the installed body is exactly
    // this post-image.
    expect(later).toEqual([
      '20261024211825_a_rebuy_seated_from_another_table_is_movement_evidence.sql',
      '20261025030421_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql',
      '20261025082356_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql',
    ]);
    expect(readFileSync(join(MIGRATIONS, later[0]), 'utf8')).toContain(
      `md5(p.prosrc) = '${POST_MD5}'`
    );
    expect(readFileSync(join(MIGRATIONS, later[0]), 'utf8')).toContain(
      `md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`
    );
  });
});
