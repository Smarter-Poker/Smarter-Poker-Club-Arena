/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE ARENA BELONGS TO THE SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decided by Claude on Dan's delegation of 2026-09-30 (docs/DIAMOND-RULINGS.md
 * Ruling 22). The Diamond Arena's club row named a real platform account as
 * owner (daniel@smarter.poker, role god), so every door that trusts a club's
 * owner treated whoever signed in as that account as the arena's owner.
 * Migration 20260930235500 names the system account instead
 * (system@smarter.poker, 00000000-0000-0000-0000-000000000001), which nobody
 * signs in as. It also lets the owner-wallet trigger skip a Diamond club, opens
 * a Diamond hand to platform staff with a live session only, and makes the
 * arena guard refuse any other owner. Platform staff keep every staff door.
 *
 * Evidence: docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system.md.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_the_arena_belongs_to_the_system.sql'))
  .at(-1);
if (!NAME) throw new Error('the arena-belongs-to-the-system migration is missing');
const MIG = migrationText(NAME);
const SYSTEM = '00000000-0000-0000-0000-000000000001';
const FORMER = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const EDITS = sliceBetween(
  MIG,
  "-- 1 and 3: the owner's player wallet is a chip club's",
  "-- 2. The arena's owner is the system account"
);
const OWNER = sliceBetween(
  MIG,
  "-- 2. The arena's owner is the system account",
  '-- 4. The arena guard keeps it that way'
);
const GUARD = sliceBetween(
  MIG,
  '-- 4. The arena guard keeps it that way',
  '-- What must be true now'
);
const FINAL = MIG.slice(MIG.indexOf('-- What must be true now'));

describe('LAW: the arena belongs to the system', () => {
  it('opens nothing, moves no Diamond and grants nothing', () => {
    expect(code(MIG)).not.toMatch(/SET\s+(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
    expect(code(MIG)).not.toMatch(/\bGRANT\b/i);
    expect(code(MIG)).not.toMatch(/\bCREATE\s+(TABLE|FUNCTION|OR\s+REPLACE)\b/i);
    expect(code(MIG)).not.toMatch(/\bdiamonds\s*=\s*diamonds\s*[+-]/i);
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
  });

  it('changes the two shared functions only by pinned, asserted, reversible substitution', () => {
    expect(EDITS).toContain('$p$84222e6fb692c99fa27c843584ac9fc0$p$');
    expect(EDITS).toContain('$p$5730804b7bd990a728b93cf602480273$p$');
    expect(EDITS).toContain('IF md5(v_def) <> r.pin THEN');
    expect(EDITS).toContain("the clause to change occurs % times, expected 1'");
    expect(EDITS).toContain("the second clause to change occurs % times, expected 1'");
    expect(EDITS).toContain('IF md5(v_back) <> r.pin THEN');
    expect(EDITS).toContain('v_back := replace(pg_get_functiondef(v_oid), r.new, r.old);');
  });

  it('the owner-wallet trigger returns for a club that does not play in chips, chip clubs unchanged', () => {
    expect(EDITS).toContain(
      "IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) OR NEW.asset IS DISTINCT FROM 'chips' THEN RETURN NULL; END IF;"
    );
    expect(EDITS).toContain(
      '$o$  IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) THEN RETURN NULL; END IF;$o$'
    );
  });

  it('a Diamond hand opens to platform staff with a live session, and its audit row says so; a chip hand as before', () => {
    expect(EDITS).toContain(
      "v_diamond boolean := EXISTS (SELECT 1 FROM public.clubs c\n                                WHERE c.id = p_club_id AND c.asset = 'diamonds');"
    );
    expect(EDITS).toMatch(
      /IF v_diamond THEN\n\s+IF NOT public\.fn_is_platform_admin\(\) THEN\n\s+RAISE EXCEPTION 'only platform staff may open a Diamond hand'/
    );
    expect(EDITS).toMatch(
      /IF NOT public\.fn_caller_session_is_live\(\) THEN\n\s+RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE = '28000';/
    );
    expect(EDITS).toContain('ELSIF NOT public.fn_ca_is_club_control(p_club_id, v_uid) THEN');
    expect(EDITS).toContain(
      "CASE WHEN v_diamond THEN 'platform_admin' ELSE public.fn_ca_club_actor_role(p_club_id, v_uid) END,"
    );
  });

  it('names the system account only after proving nobody can sign in as it, and only moves the arena from its former owner', () => {
    expect(OWNER).toContain(`c_system constant uuid := '${SYSTEM}';`);
    expect(OWNER).toContain(`c_former constant uuid := '${FORMER}';`);
    expect(OWNER).toContain("u.email = 'system@smarter.poker'");
    expect(OWNER).toContain(
      "COALESCE(u.encrypted_password, '') = '' AND u.last_sign_in_at IS NULL"
    );
    expect(OWNER).toContain('FROM auth.identities WHERE user_id = c_system');
    expect(OWNER).toContain('FROM auth.sessions WHERE user_id = c_system');
    expect(OWNER).toContain('FROM auth.refresh_tokens WHERE user_id = c_system::text');
    expect(OWNER).toContain("RAISE NOTICE 'the Diamond Arena already belongs to the system';");
    expect(OWNER).toContain(
      'UPDATE public.clubs SET owner_id = c_system WHERE id = v_arena AND owner_id = c_former;'
    );
    expect(OWNER).toContain('SET CONSTRAINTS ALL IMMEDIATE;');
  });

  it('the watched arena guard refuses any Diamond owner but the system account, and the redefinition is declared', () => {
    expect(GUARD).toContain("c_pin constant text := 'd3ecf93c4ac0aced79031b4ce00df59b';");
    expect(GUARD).toContain(
      `IF NEW.asset='diamonds' AND NEW.owner_id IS DISTINCT FROM '${SYSTEM}'::uuid THEN`
    );
    expect(GUARD).toContain(
      "RAISE EXCEPTION 'The Diamond Arena Belongs To The System' USING ERRCODE='23514';"
    );
    expect(GUARD).toContain(
      'IF md5(replace(pg_get_functiondef(v_oid), c_new, c_old)) <> c_pin THEN'
    );
    expect(MIG).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_poker_guard_arena_structure', 'migration the_arena_belongs_to_the_system');"
    );
  });

  it('asserts at the end that every edit landed, the guard refuses by name and every watched guard is on its baseline', () => {
    expect(FINAL).toContain('the former owner still owns a Diamond club');
    expect(FINAL).toContain('the arena has a membership row that is not an automatic player');
    expect(FINAL).toContain('the owner-wallet trigger still gives a Diamond owner a chip wallet');
    expect(FINAL).toContain('the hand door does not open a Diamond hand to platform staff only');
    expect(FINAL).toContain("the hand door''s grants moved");
    expect(FINAL).toContain('a trigger function became callable from a browser');
    expect(FINAL).toContain(`UPDATE public.clubs SET owner_id = c_former WHERE id = v_arena;`);
    expect(FINAL).toContain("v_msg <> 'The Diamond Arena Belongs To The System'");
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('declares one live proof per change, each one line', () => {
    const proofs = [...MIG.matchAll(/^-- @live-proof: (.+)$/gm)].map((m) => m[1]);
    expect(proofs).toHaveLength(4);
    expect(proofs[0]).toContain(`c.owner_id = '${SYSTEM}'::uuid`);
    expect(proofs[1]).toContain('fn_club_owner_has_a_player_wallet()');
    expect(proofs[2]).toContain('only platform staff may open a Diamond hand');
    expect(proofs[3]).toContain('The Diamond Arena Belongs To The System');
  });

  it('keeps the rehearsal that proves it: owner doors refuse the former owner, all nineteen staff doors admit him', () => {
    const file = join(
      __dirname,
      '..',
      'docs',
      'evidence',
      'diamond-phase-11',
      'the-arena-belongs-to-the-system-rehearsal.sql'
    );
    expect(existsSync(file)).toBe(true);
    const fx = readFileSync(file, 'utf8');
    expect(fx).toContain("SET LOCAL lock_timeout = '2s';");
    expect(fx).toContain('SET CONSTRAINTS ALL IMMEDIATE;');
    expect(fx).toContain("RAISE EXCEPTION 'REHEARSAL OK [mode %]");
    expect((fx.match(/^ \('[^']+', /gm) ?? []).length).toBe(19);
    for (const door of [
      'fn_ca_is_club_control',
      'detect_suspicious_plays',
      'fn_update_table_bomb_settings',
      'has_commander_access',
      'fn_ca_operator_read_hand',
    ]) {
      expect(fx).toContain(door);
    }
  });
});
