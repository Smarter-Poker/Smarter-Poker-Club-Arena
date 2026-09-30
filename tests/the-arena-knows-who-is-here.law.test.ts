/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE ARENA KNOWS WHO IS HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 3 ("Show real
 * member/online/seated/table counts with meaningful zero/error states").
 * Migration 20260930044500_the_arena_knows_who_is_here.
 *
 * What this pins:
 *  - fn_diamond_arena_counts is redefined only over its pinned live text, and
 *    members, tables and seated are word for word what 20260929214500 wrote;
 *  - ONLINE reads three live sources and writes nothing: Supabase Realtime's
 *    register of live table feeds (signed-in claims only, a guarded id), the
 *    messenger's presence and a live arena seat, counted through the one
 *    player rule, and the answer carries counts only, never a name or an id;
 *  - ONLINE is a number only while one of those sources shows the caller;
 *  - the client keeps holding the feeds this reads (the waitlist listener in
 *    App.tsx, the header's notifications feed), and the Players page asks an
 *    unknown Online once more before it prints Unavailable.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_the_arena_knows_who_is_here.sql'))
  .at(-1);
if (!NAME) throw new Error('the arena-knows-who-is-here migration is missing');
const MIG = migrationText(NAME);
const EARLIER = migrationText('20260929214500_the_arena_counts_its_players.sql');
const code = (s: string) => s.replace(/--[^\n]*/g, ' ');
const CODE = code(MIG);
const section = (from: string, to: string) => code(sliceBetween(MIG, from, to));
const PIN = section('-- 1. THE PIN', '-- 2. THE FOUR FIGURES');
const COUNTS = section('-- 2. THE FOUR FIGURES', '-- 3. THE ESTATE IS AS IT WAS');
const FINAL = section('-- 3. THE ESTATE IS AS IT WAS', 'RAISE NOTICE');
const ONLINE = sliceBetween(COUNTS, 'IF v_uid IS NULL THEN', 'RETURN jsonb_build_object(');

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const tsCode = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('LAW: the arena knows who is here', () => {
  it('writes nothing, prices nothing and opens no switch', () => {
    expect(CODE).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\.|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(CODE).not.toMatch(/cash_games_enabled\s*=\s*true|tournaments_enabled\s*=\s*true/i);
    expect(CODE, 'grants are kept as they were').not.toMatch(/\b(GRANT|REVOKE)\s/);
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
    expect(MIG).toMatch(
      /^-- @live-proof: \(SELECT position\('FROM realtime\.subscription rs' in p\.prosrc\) > 0 /m
    );
  });

  it('redefines the counts reader only over its pinned live text', () => {
    expect(PIN).toContain(
      "md5(pg_get_functiondef('public.fn_diamond_arena_counts()'::regprocedure))"
    );
    expect(PIN).toContain("IF v_md5 <> '62640c4a82bd621861fc6d0b84d5dd86' THEN");
    expect(MIG.indexOf('-- 1. THE PIN')).toBeLessThan(
      MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_arena_counts()')
    );
    expect(CODE.match(/CREATE (OR REPLACE )?FUNCTION/g)).toHaveLength(1);
    expect(COUNTS).toContain('SECURITY DEFINER');
    expect(COUNTS).toContain("RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';");
    expect(FINAL).toContain("has_function_privilege('anon', v_counts_oid, 'EXECUTE')");
    expect(FINAL).toContain("NOT has_function_privilege('authenticated', v_counts_oid, 'EXECUTE')");
  });

  it('leaves members, tables and seated word for word as they were', () => {
    const preamble = (s: string) =>
      sliceBetween(s, 'DECLARE\n  v_uid uuid := auth.uid();', '-- Each figure is read on its own.');
    const figures = (s: string) =>
      sliceBetween(s, '-- Each figure is read on its own.', '-- ONLINE');
    const answer = (s: string) =>
      sliceBetween(s, "RETURN jsonb_build_object(\n    'members'", '$fn$;');
    expect(preamble(MIG)).toBe(preamble(EARLIER));
    expect(figures(MIG)).toBe(figures(EARLIER));
    expect(answer(MIG)).toBe(answer(EARLIER));
  });

  it('reads online from three live sources through the one player rule', () => {
    expect(ONLINE).toContain('FROM realtime.subscription rs');
    expect(ONLINE).toContain("WHERE rs.claims ->> 'role' = 'authenticated'");
    expect(ONLINE).toContain(
      "WHEN rs.claims ->> 'sub' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"
    );
    expect(ONLINE).toContain("THEN (rs.claims ->> 'sub')::uuid");
    expect(ONLINE).toContain(
      "WHERE coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'"
    );
    expect(ONLINE).toContain('FROM public.fn_diamond_arena_seated_players(v_arena) AS s(user_id)');
    expect(ONLINE).toContain(
      'count(*) FILTER (WHERE public.fn_diamond_arena_is_player(present.user_id))'
    );
    expect(ONLINE).toContain('WHERE present.user_id IS NOT NULL;');
    expect(MIG, 'a horse is a player; nothing here may filter on the horse flag').not.toMatch(
      /is_horse/i
    );
  });

  it('answers online only while a source shows the caller, and never a made-up zero', () => {
    expect(ONLINE).toContain("jsonb_build_object('online', 'no_caller_to_witness')");
    expect(ONLINE).toContain('coalesce(bool_or(present.user_id = v_uid), false)');
    const unseen = sliceBetween(ONLINE, 'IF NOT v_witness THEN', 'END IF;');
    expect(unseen).toContain('v_online := NULL;');
    expect(unseen).toContain("jsonb_build_object('online', 'presence_not_reported')");
    expect(ONLINE).toContain("jsonb_build_object('online', 'read_failed_' || SQLSTATE)");
    expect(COUNTS, 'no figure may be coalesced to a zero').not.toMatch(
      /coalesce\(\s*v_(members|online|seated|tables)/i
    );
  });

  it('answers with counts only, never a name or an id', () => {
    const answer = sliceBetween(COUNTS, "RETURN jsonb_build_object(\n    'members'", '$fn$;');
    const keys = [...answer.matchAll(/'([a-z_]+)', /g)].map((m) => m[1]).sort();
    expect(keys).toEqual(['as_of', 'members', 'online', 'seated', 'tables', 'unknown']);
    expect(ONLINE).not.toMatch(/jsonb_agg|array_agg|string_agg/);
  });

  it('proves at apply that the feeds it reads exist and are published', () => {
    expect(FINAL).toContain("to_regclass('realtime.subscription') IS NULL");
    expect(FINAL).toContain("has_table_privilege('postgres', 'realtime.subscription', 'SELECT')");
    expect(FINAL).toContain("tablename IN ('table_waitlist', 'notifications')) <> 2");
    expect(FINAL).toContain(
      "v_counts->'unknown'->>'online' IS DISTINCT FROM 'no_caller_to_witness'"
    );
  });

  it('the client keeps holding the feeds Online reads on every signed-in page', () => {
    const app = tsCode(read('src/App.tsx'));
    expect(app).toContain('<GlobalWaitlistListener />');
    const waitlist = tsCode(read('src/components/common/GlobalWaitlistListener.tsx'));
    const watch = sliceBetween(waitlist, 'if (user?.id) {', '.subscribe();');
    expect(watch).toContain("table: 'table_waitlist',");
    expect(watch).toContain('filter: `user_id=eq.${user.id}`,');
    const header = tsCode(read('src/stores/useHeaderDataStore.ts'));
    expect(header).toContain("table: 'notifications',");
    expect(header).toContain('filter: `user_id=eq.${userId}`,');
  });

  it('the Players page asks an unknown Online once more before it prints Unavailable', () => {
    const page = tsCode(read('src/pages/DiamondPlayersPage.tsx'));
    expect(page).toContain('const recheckOnline = next.online === COUNT_UNKNOWN;');
    expect(page).toContain('setCounts(recheckOnline ? { ...next, online: null } : next);');
    expect(page).toContain(
      'recheck = setTimeout(() => void ask(false), DIAMOND_ONLINE_RECHECK_MS);'
    );
    expect(page).toContain('setCounts((shown) => ({ ...shown, online: next.online }));');
    expect(page).toContain('clearTimeout(recheck);');
    expect(tsCode(read('src/lib/diamondArenaCounts.ts'))).toContain(
      'export const DIAMOND_ONLINE_RECHECK_MS = 3_000;'
    );
  });
});
